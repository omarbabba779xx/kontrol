import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { raiseNonconformity, NC_SEVERITIES } from "@/lib/core/isms";
import { UC_BY_CODE } from "@/lib/frameworks/unified";
import { getDb } from "@/lib/db";

/**
 * The operating side of the management system: planned changes (6.3), competence (7.2), the communication plan (7.4), security
 * incidents, and internal audits with their plan, their findings and their conclusion (9.2).
 */
export const RECORD_KINDS = ["change", "competence", "communication"] as const;
export const RECORD_STATUSES: Record<(typeof RECORD_KINDS)[number], readonly string[]> = { change: ["planned", "done", "cancelled"], competence: ["met", "gap"], communication: ["active", "retired"] };
export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const INCIDENT_STATUSES = ["reported", "contained", "resolved", "closed"] as const;
type RecordKind = (typeof RECORD_KINDS)[number];
type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
const HOUR = 3_600_000;

const db = async (tenantId: string) => (await getDb()).scope(tenantId);
const log = (actor: Actor, action: string, objectType: string, objectId: string, payload: unknown, tx: Parameters<typeof appendAudit>[1]) => appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action, objectType, objectId, payload }, tx);
const date = (value: string | undefined | null, label: string) => {
  if (value && Number.isNaN(Date.parse(value))) throw userError(`${label} is invalid`);
  return value ?? null;
};
async function user(tenantId: string, userId: string | null | undefined, label = "Owner") {
  if (!userId) return null;
  const row = await (await db(tenantId)).get<{ id: string; status: string }>("SELECT id, status FROM users WHERE tenant_id = ? AND id = ?", tenantId, userId);
  if (!row) throw userError(`${label} not found`);
  if (row.status !== "active") throw userError(`${label} is disabled`);
  return row.id;
}

// 6.3, 7.2, 7.4 -----------------------------------------------------------------------------------------------------------

/**
 * One record of a planned change, a competence requirement or a communication. What each kind must say:
 *   change         why, what it could affect, who is responsible and when (the considerations of clause 6.3)
 *   competence     the role, the competence it needs, the evidence, and the action when there is a gap
 *   communication  what is communicated, to whom, when, by whom and how (the five questions of clause 7.4)
 */
export async function saveRecord(actor: Actor, input: { id?: string; kind: RecordKind; title: string; status?: string; ownerId?: string | null; dueAt?: string | null; detail: Record<string, string> }) {
  const status = input.status ?? RECORD_STATUSES[input.kind][0];
  if (!RECORD_STATUSES[input.kind].includes(status)) throw userError(`A ${input.kind} record is ${RECORD_STATUSES[input.kind].join(", ")}`);
  const need = (field: string, label: string) => {
    if (!(input.detail[field] ?? "").trim()) throw userError(label);
  };
  if (input.kind === "change") {
    need("purpose", "State the purpose of the change");
    need("consequences", "State what the change could affect, including the integrity of the ISMS");
    if (!input.ownerId) throw userError("A planned change needs someone responsible");
  }
  if (input.kind === "competence") {
    need("competence", "State the competence the role needs");
    if (status === "met") need("evidence", "State the evidence of competence (training, experience, qualification)");
    if (status === "gap") need("action", "State the action that closes the gap");
  }
  if (input.kind === "communication" && !["internal", "external"].includes(input.detail.scope ?? "")) throw userError("State whether the communication is internal or external");
  if (input.kind === "communication") for (const [field, label] of [["audience", "to whom"], ["timing", "when"], ["channel", "how"]] as const) need(field, `State ${label} this is communicated`);
  const ownerId = await user(actor.tenantId, input.ownerId);
  if (input.kind === "communication" && !ownerId) throw userError("State who communicates");
  const dueAt = date(input.dueAt, "Date");
  const scope = await db(actor.tenantId);
  const id = input.id ?? `rec_${randomUUID()}`;
  const now = new Date().toISOString();
  const detail = JSON.stringify(Object.fromEntries(Object.entries(input.detail).map(([key, value]) => [key, String(value).slice(0, 2000)])));
  await scope.transaction(async (tx) => {
    if (input.id) {
      const changed = await tx.run("UPDATE isms_records SET title = ?, detail_json = ?, status = ?, owner_id = ?, due_at = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND kind = ?", input.title.trim(), detail, status, ownerId, dueAt, actor.userId, now, actor.tenantId, id, input.kind);
      if (changed.changes !== 1) throw userError("Record not found");
    } else {
      await tx.run("INSERT INTO isms_records (id,tenant_id,kind,title,detail_json,status,owner_id,due_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", id, actor.tenantId, input.kind, input.title.trim(), detail, status, ownerId, dueAt, actor.userId, now);
    }
    await log(actor, `isms.${input.kind}_${input.id ? "updated" : "recorded"}`, "isms_record", id, { title: input.title, status }, tx);
  });
  return { id };
}

// Incidents ----------------------------------------------------------------------------------------------------------------

type IncidentRow = { id: string; ref: string; title: string; severity: (typeof INCIDENT_SEVERITIES)[number]; status: IncidentStatus; personal_data: number; notification_due: string | null; notified_at: string | null; root_cause: string; lessons: string; nonconformity_id: string | null; no_nonconformity_reason: string | null; asset_id: string | null; detected_at: string; owner_id: string | null };

/** Records a security incident. One that involves personal data starts the 72-hour clock of GDPR Article 33 from its detection. */
export async function reportIncident(actor: Actor, input: { title: string; description?: string; severity: (typeof INCIDENT_SEVERITIES)[number]; detectedAt: string; assetId?: string; personalData?: boolean; ownerId?: string }) {
  if (Number.isNaN(Date.parse(input.detectedAt))) throw userError("Detection time is invalid");
  if (Date.parse(input.detectedAt) > Date.now() + 5 * 60_000) throw userError("An incident cannot be detected in the future");
  const ownerId = await user(actor.tenantId, input.ownerId);
  const scope = await db(actor.tenantId);
  if (input.assetId && !(await scope.get("SELECT id FROM assets WHERE tenant_id = ? AND id = ? AND valid_to IS NULL", actor.tenantId, input.assetId))) throw userError("Asset not found");
  const id = `inc_${randomUUID()}`;
  const now = new Date().toISOString();
  const due = input.personalData ? new Date(Date.parse(input.detectedAt) + 72 * HOUR).toISOString() : null;
  let ref = "";
  await scope.transaction(async (tx) => {
    const count = await tx.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM isms_incidents WHERE tenant_id = ?", actor.tenantId);
    ref = `INC-${String(Number(count?.n ?? 0) + 1).padStart(3, "0")}`;
    await tx.run("INSERT INTO isms_incidents (id,tenant_id,ref,title,description,severity,status,detected_at,asset_id,personal_data,notification_due,owner_id,reported_by,reported_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, actor.tenantId, ref, input.title.trim(), input.description ?? "", input.severity, "reported", input.detectedAt, input.assetId ?? null, input.personalData ? 1 : 0, due, ownerId, actor.userId, now, now);
    await log(actor, "isms.incident_reported", "isms_incident", id, { ref, severity: input.severity, personalData: input.personalData === true, notificationDue: due }, tx);
  });
  return { id, ref, notificationDue: due };
}

async function loadIncident(actor: Actor, id: string) {
  const row = await (await db(actor.tenantId)).get<IncidentRow>("SELECT * FROM isms_incidents WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
  if (!row) throw userError("Incident not found");
  if (row.status === "closed") throw userError("This incident is closed (already final): it can no longer change");
  return row;
}

/** Moves an incident forward (reported, contained, resolved) and records what is learned on the way. It never moves backward. */
export async function updateIncident(actor: Actor, input: { id: string; status?: Exclude<IncidentStatus, "closed">; rootCause?: string; lessons?: string; ownerId?: string | null; notified?: { at: string; note: string } }) {
  const row = await loadIncident(actor, input.id);
  if (input.status && INCIDENT_STATUSES.indexOf(input.status) < INCIDENT_STATUSES.indexOf(row.status)) throw userError(`An incident does not go back from ${row.status} to ${input.status}`);
  if (input.notified) {
    if (!row.personal_data) throw userError("Only an incident involving personal data has a notification to record");
    if (Number.isNaN(Date.parse(input.notified.at))) throw userError("Notification time is invalid");
  }
  const ownerId = input.ownerId === undefined ? row.owner_id : await user(actor.tenantId, input.ownerId);
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE isms_incidents SET status = ?, root_cause = ?, lessons = ?, owner_id = ?, notified_at = ?, notification_note = COALESCE(?, notification_note), updated_at = ? WHERE tenant_id = ? AND id = ?",
      input.status ?? row.status, input.rootCause?.trim() ?? row.root_cause, input.lessons?.trim() ?? row.lessons, ownerId, input.notified?.at ?? row.notified_at, input.notified?.note ?? null, new Date().toISOString(), actor.tenantId, row.id);
    await log(actor, "isms.incident_updated", "isms_incident", row.id, { ref: row.ref, status: input.status ?? row.status, notified: input.notified?.at ?? null }, tx);
  });
  return { id: row.id, status: input.status ?? row.status };
}

/**
 * Closing an incident is the post-incident review: the cause, what was learned, and for anything serious either a nonconformity that
 * carries the corrective action or a stated reason why none is needed. A personal-data incident closes only once the notification
 * question is answered.
 */
export async function closeIncident(actor: Actor, input: { id: string; rootCause: string; lessons: string; nonconformity?: { severity: (typeof NC_SEVERITIES)[number]; title: string; ownerId?: string }; noNonconformityReason?: string }) {
  const row = await loadIncident(actor, input.id);
  if (row.status !== "resolved") throw userError("Resolve the incident before closing it");
  if (row.personal_data && !row.notified_at) throw userError("Record whether and when the authority was notified before closing a personal-data incident");
  const serious = row.severity === "high" || row.severity === "critical";
  if (serious && !input.nonconformity && (input.noNonconformityReason ?? "").trim().length < 20) throw userError("A high or critical incident needs a nonconformity with a corrective action, or the reason why none is needed (20 characters minimum)");
  let nonconformity: { id: string; ref: string } | null = null;
  if (input.nonconformity) {
    nonconformity = await raiseNonconformity(actor, { source: "incident", severity: input.nonconformity.severity, title: input.nonconformity.title, description: `Raised from ${row.ref}: ${row.title}`, ownerId: input.nonconformity.ownerId });
    await (await db(actor.tenantId)).run("UPDATE isms_nonconformities SET incident_id = ? WHERE tenant_id = ? AND id = ?", row.id, actor.tenantId, nonconformity.id);
  }
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE isms_incidents SET status = 'closed', root_cause = ?, lessons = ?, nonconformity_id = ?, no_nonconformity_reason = ?, closed_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", input.rootCause.trim(), input.lessons.trim(), nonconformity?.id ?? null, nonconformity ? null : (input.noNonconformityReason?.trim() ?? null), now, now, actor.tenantId, row.id);
    await log(actor, "isms.incident_closed", "isms_incident", row.id, { ref: row.ref, nonconformity: nonconformity?.ref ?? null, rootCause: input.rootCause.trim() }, tx);
  });
  return { id: row.id, nonconformity };
}

// Internal audit -----------------------------------------------------------------------------------------------------------

/** Plans an internal audit: what it is for, against which criteria, over which controls, and who audits. */
export async function planInternalAudit(actor: Actor, input: { name: string; objectives: string; criteria: string; scope?: string; auditorId: string; periodStart: string; periodEnd: string; ucCodes?: string[]; frameworkId?: string }) {
  if (Number.isNaN(Date.parse(input.periodStart)) || Number.isNaN(Date.parse(input.periodEnd)) || input.periodEnd < input.periodStart) throw userError("The audit period is invalid");
  const codes = [...new Set(input.ucCodes ?? [])];
  for (const code of codes) if (!UC_BY_CODE.has(code)) throw userError(`Control ${code} not found`);
  const auditorId = (await user(actor.tenantId, input.auditorId, "Auditor"))!;
  const scope = await db(actor.tenantId);
  // Independence (9.2.2): an auditor does not audit controls they own.
  if (codes.length) {
    const own = await scope.all<{ uc_code: string }>(`SELECT uc_code FROM control_implementations WHERE tenant_id = ? AND owner_id = ? AND uc_code IN (${codes.map(() => "?").join(",")})`, actor.tenantId, auditorId, ...codes);
    if (own.length) throw userError(`Separation of duties: the auditor owns ${own.map((row) => row.uc_code).join(", ")} and cannot audit their own work`);
  }
  const id = `eng_${randomUUID()}`;
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    await tx.run("INSERT INTO audit_engagements (id,tenant_id,name,framework_id,kind,scope,period_start,period_end,auditor_org,status,lead_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", id, actor.tenantId, input.name.trim(), input.frameworkId ?? "iso27001", "internal", input.scope ?? "", input.periodStart, input.periodEnd, "Internal audit", "planning", auditorId, actor.userId, now);
    await tx.run("INSERT INTO internal_audit_plans (engagement_id,tenant_id,objectives,criteria,auditor_id,uc_codes_json,planned_by,planned_at) VALUES (?,?,?,?,?,?,?,?)", id, actor.tenantId, input.objectives.trim(), input.criteria.trim(), auditorId, JSON.stringify(codes), actor.userId, now);
    await log(actor, "isms.internal_audit_planned", "audit_engagement", id, { name: input.name, auditor: auditorId, controls: codes, periodEnd: input.periodEnd }, tx);
  });
  return { id };
}

async function loadAudit(actor: Actor, id: string) {
  const row = await (await db(actor.tenantId)).get<{ engagement_id: string; auditor_id: string; uc_codes_json: string; concluded_at: string | null; name: string; status: string }>(
    "SELECT p.engagement_id, p.auditor_id, p.uc_codes_json, p.concluded_at, e.name, e.status FROM internal_audit_plans p JOIN audit_engagements e ON e.id = p.engagement_id WHERE p.tenant_id = ? AND p.engagement_id = ?", actor.tenantId, id);
  if (!row) throw userError("Internal audit not found");
  if (row.concluded_at) throw userError("This audit is concluded (already final): it can no longer change");
  return row;
}

/** A finding of the audit becomes a nonconformity, linked to the audit that found it. Only the auditor raises findings. */
export async function raiseAuditFinding(actor: Actor, input: { auditId: string; severity: (typeof NC_SEVERITIES)[number]; title: string; description?: string; requirement?: string; ucCode?: string }) {
  const audit = await loadAudit(actor, input.auditId);
  if (audit.auditor_id !== actor.userId) throw userError("Only the auditor of this audit records its findings");
  const created = await raiseNonconformity(actor, { source: "internal_audit", severity: input.severity, title: input.title, description: input.description, requirement: input.requirement, ucCode: input.ucCode });
  await (await db(actor.tenantId)).run("UPDATE isms_nonconformities SET audit_id = ? WHERE tenant_id = ? AND id = ?", audit.engagement_id, actor.tenantId, created.id);
  return created;
}

/** The auditor states the conclusion; the audit closes and its findings stay open as nonconformities until they are corrected. */
export async function concludeInternalAudit(actor: Actor, input: { auditId: string; conclusion: string }) {
  const audit = await loadAudit(actor, input.auditId);
  if (audit.auditor_id !== actor.userId) throw userError("Only the auditor of this audit can conclude it");
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  const findings = await scope.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM isms_nonconformities WHERE tenant_id = ? AND audit_id = ?", actor.tenantId, audit.engagement_id);
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE internal_audit_plans SET conclusion = ?, concluded_at = ? WHERE tenant_id = ? AND engagement_id = ?", input.conclusion.trim(), now, actor.tenantId, audit.engagement_id);
    await tx.run("UPDATE audit_engagements SET status = 'closed', closed_at = ? WHERE tenant_id = ? AND id = ?", now, actor.tenantId, audit.engagement_id);
    await log(actor, "isms.internal_audit_concluded", "audit_engagement", audit.engagement_id, { name: audit.name, findings: Number(findings?.n ?? 0), conclusion: input.conclusion.trim() }, tx);
  });
  return { id: audit.engagement_id, findings: Number(findings?.n ?? 0) };
}

// Views ----------------------------------------------------------------------------------------------------------------------

export async function operationsSnapshot(tenantId: string) {
  const scope = await db(tenantId);
  const now = new Date().toISOString();
  const [records, incidents, audits] = await Promise.all([
    scope.all<{ id: string; kind: RecordKind; title: string; detail_json: string; status: string; owner_id: string | null; due_at: string | null; updated_at: string }>("SELECT id, kind, title, detail_json, status, owner_id, due_at, updated_at FROM isms_records WHERE tenant_id = ? ORDER BY kind, updated_at DESC LIMIT 500", tenantId),
    scope.all<IncidentRow & { description: string; reported_at: string; closed_at: string | null; notification_note: string | null }>("SELECT * FROM isms_incidents WHERE tenant_id = ? ORDER BY detected_at DESC LIMIT 300", tenantId),
    scope.all<{ id: string; name: string; status: string; period_start: string; period_end: string; closed_at: string | null; objectives: string; criteria: string; auditor_id: string; uc_codes_json: string; conclusion: string | null; findings: number | string }>(
      "SELECT e.id, e.name, e.status, e.period_start, e.period_end, e.closed_at, p.objectives, p.criteria, p.auditor_id, p.uc_codes_json, p.conclusion, (SELECT COUNT(*) FROM isms_nonconformities n WHERE n.tenant_id = e.tenant_id AND n.audit_id = e.id) AS findings FROM audit_engagements e JOIN internal_audit_plans p ON p.engagement_id = e.id WHERE e.tenant_id = ? ORDER BY e.period_end DESC LIMIT 50", tenantId),
  ]);
  return {
    records: records.map(({ detail_json, ...record }) => ({ ...record, detail: JSON.parse(detail_json) as Record<string, string>, overdue: record.kind === "change" && record.status === "planned" && record.due_at !== null && record.due_at < now })),
    incidents: incidents.map((incident) => ({ ...incident, personal_data: Number(incident.personal_data) === 1, notificationOverdue: Number(incident.personal_data) === 1 && !incident.notified_at && incident.notification_due !== null && incident.notification_due < now })),
    internalAudits: audits.map(({ uc_codes_json, ...audit }) => ({ ...audit, findings: Number(audit.findings), controls: JSON.parse(uc_codes_json) as string[] })),
  };
}
