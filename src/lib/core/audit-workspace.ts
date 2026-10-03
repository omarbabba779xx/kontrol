import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { notify } from "@/lib/core/notifications";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { baseRequirements } from "@/lib/frameworks/mapping";
import { UC_BY_CODE } from "@/lib/frameworks/unified";
import type { FrameworkId } from "@/lib/frameworks/types";
import { getDb } from "@/lib/db";

/**
 * Audit engagements: a period, a framework, auditors with expiring access, a list of requests (PBC) and the
 * conversation around each. External auditors are `external` users: they reach this workspace for the engagements they were
 * granted until the access expires, and nothing else in the platform. Nobody can accept a response they provided.
 */
export const KINDS = ["soc2_type1", "soc2_type2", "iso27001_certification", "internal", "other"] as const;
export const ENGAGEMENT_STATUSES = ["planning", "fieldwork", "review", "closed"] as const;
export const REQUEST_STATUSES = ["open", "provided", "accepted", "needs_more"] as const;
type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];
type RequestStatus = (typeof REQUEST_STATUSES)[number];
const DAY = 86_400_000;
const MAX_PERIOD_DAYS = 400;

export type EngagementRow = { id: string; name: string; framework_id: FrameworkId; kind: string; scope: string; period_start: string; period_end: string; auditor_org: string; status: EngagementStatus; lead_id: string | null; created_by: string; created_at: string; closed_at: string | null };
type RequestRow = { id: string; engagement_id: string; ref: string; title: string; description: string; uc_code: string | null; assignee_id: string | null; status: RequestStatus; due_at: string | null; created_by: string; created_at: string; resolved_at: string | null };
type EventRow = { id: string; engagement_id: string; request_id: string | null; kind: string; author_id: string; body: string; reference_json: string; created_at: string };

const isAuditor = (actor: Actor) => actor.external === true || actor.role === "auditor";

/** Internal users see every engagement; external auditors only those with an unexpired, unrevoked grant. */
async function engagementFor(actor: Actor, id: string): Promise<EngagementRow> {
  const db = (await getDb()).scope(actor.tenantId);
  const engagement = await db.get<EngagementRow>("SELECT * FROM audit_engagements WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
  if (!engagement) throw userError("Engagement not found");
  if (actor.external) {
    const grant = await db.get<{ expires_at: string; revoked_at: string | null }>("SELECT expires_at, revoked_at FROM audit_access WHERE tenant_id = ? AND engagement_id = ? AND user_id = ?", actor.tenantId, id, actor.userId);
    // The same answer as a missing engagement: an external user learns nothing about engagements they were not granted.
    if (!grant || grant.revoked_at || grant.expires_at <= new Date().toISOString()) throw userError("Engagement not found");
  }
  return engagement;
}

function assertOpen(engagement: EngagementRow) {
  if (engagement.status === "closed") throw userError("This engagement is closed (already final): it can no longer be changed");
}

export async function createEngagement(actor: Actor, input: { name: string; frameworkId: FrameworkId; kind: (typeof KINDS)[number]; scope?: string; periodStart: string; periodEnd: string; auditorOrg?: string; leadId?: string }) {
  if (!FRAMEWORK_BY_ID.has(input.frameworkId)) throw userError(`Framework ${input.frameworkId} not found`);
  const start = Date.parse(input.periodStart), end = Date.parse(input.periodEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw userError("The period must end after it starts");
  if ((end - start) / DAY > MAX_PERIOD_DAYS) throw userError(`The period cannot exceed ${MAX_PERIOD_DAYS} days`);
  const db = (await getDb()).scope(actor.tenantId);
  if (input.leadId && !(await db.get("SELECT id FROM users WHERE tenant_id = ? AND id = ? AND status = 'active' AND external = 0", actor.tenantId, input.leadId))) throw userError("Lead not found");
  const id = `aud_${randomUUID()}`;
  await db.transaction(async (tx) => {
    await tx.run("INSERT INTO audit_engagements (id,tenant_id,name,framework_id,kind,scope,period_start,period_end,auditor_org,status,lead_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, actor.tenantId, input.name.trim(), input.frameworkId, input.kind, input.scope ?? "", new Date(start).toISOString(), new Date(end).toISOString(), input.auditorOrg ?? "", "planning", input.leadId ?? null, actor.userId, new Date().toISOString());
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "audit.engagement_created", objectType: "audit_engagement", objectId: id, payload: { name: input.name, frameworkId: input.frameworkId, kind: input.kind, periodStart: input.periodStart, periodEnd: input.periodEnd } }, tx);
  });
  return { id };
}

export async function listEngagements(actor: Actor) {
  const db = (await getDb()).scope(actor.tenantId);
  const now = new Date().toISOString();
  const rows = actor.external
    ? await db.all<EngagementRow>("SELECT e.* FROM audit_engagements e JOIN audit_access a ON a.engagement_id = e.id WHERE e.tenant_id = ? AND a.user_id = ? AND a.revoked_at IS NULL AND a.expires_at > ? ORDER BY e.period_end DESC", actor.tenantId, actor.userId, now)
    : await db.all<EngagementRow>("SELECT * FROM audit_engagements WHERE tenant_id = ? ORDER BY period_end DESC", actor.tenantId);
  const counts = await db.all<{ engagement_id: string; status: string; n: number }>("SELECT engagement_id, status, COUNT(*) AS n FROM audit_requests WHERE tenant_id = ? GROUP BY engagement_id, status", actor.tenantId);
  return rows.map((row) => ({ ...row, requests: Object.fromEntries(REQUEST_STATUSES.map((status) => [status, Number(counts.find((item) => item.engagement_id === row.id && item.status === status)?.n ?? 0)])) as Record<RequestStatus, number> }));
}

export async function setEngagementStatus(actor: Actor, input: { id: string; status: EngagementStatus }) {
  const engagement = await engagementFor(actor, input.id);
  assertOpen(engagement);
  if (ENGAGEMENT_STATUSES.indexOf(input.status) < ENGAGEMENT_STATUSES.indexOf(engagement.status)) throw userError("An engagement moves forward only: planning, fieldwork, review, closed");
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run("UPDATE audit_engagements SET status = ?, closed_at = ? WHERE tenant_id = ? AND id = ?", input.status, input.status === "closed" ? new Date().toISOString() : null, actor.tenantId, engagement.id);
    if (input.status === "closed") await tx.run("UPDATE audit_access SET revoked_at = ? WHERE tenant_id = ? AND engagement_id = ? AND revoked_at IS NULL", new Date().toISOString(), actor.tenantId, engagement.id);
    await tx.run("INSERT INTO audit_events (id,tenant_id,engagement_id,request_id,kind,author_id,body,reference_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)", `aev_${randomUUID()}`, actor.tenantId, engagement.id, null, "status", actor.userId, `${engagement.status} -> ${input.status}`, "{}", new Date().toISOString());
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "audit.engagement_status", objectType: "audit_engagement", objectId: engagement.id, payload: { from: engagement.status, to: input.status } }, tx);
  });
  return { id: engagement.id, status: input.status };
}

/** Grants an external auditor access until a date. Closing the engagement revokes every grant. */
export async function grantAccess(actor: Actor, input: { engagementId: string; userId: string; days: number }) {
  const engagement = await engagementFor(actor, input.engagementId);
  assertOpen(engagement);
  if (input.days < 1 || input.days > 180) throw userError("Access lasts between 1 and 180 days");
  const db = (await getDb()).scope(actor.tenantId);
  const user = await db.get<{ id: string; name: string; external: number; status: string }>("SELECT id, name, external, status FROM users WHERE tenant_id = ? AND id = ?", actor.tenantId, input.userId);
  if (!user) throw userError("User not found");
  if (Number(user.external) !== 1) throw userError("Only external auditors need a grant: internal users already see engagements");
  if (user.status !== "active") throw userError("User is disabled");
  const expires = new Date(Date.now() + input.days * DAY).toISOString();
  await db.transaction(async (tx) => {
    await tx.run(`INSERT INTO audit_access (id,tenant_id,engagement_id,user_id,expires_at,granted_by,granted_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(engagement_id, user_id) DO UPDATE SET expires_at = excluded.expires_at, revoked_at = NULL, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
      `acc_${randomUUID()}`, actor.tenantId, engagement.id, user.id, expires, actor.userId, new Date().toISOString());
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "audit.access_granted", objectType: "audit_engagement", objectId: engagement.id, payload: { userId: user.id, expiresAt: expires } }, tx);
  });
  return { engagementId: engagement.id, userId: user.id, expiresAt: expires };
}

export async function revokeAccess(actor: Actor, input: { engagementId: string; userId: string }) {
  const engagement = await engagementFor(actor, input.engagementId);
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    const result = await tx.run("UPDATE audit_access SET revoked_at = ? WHERE tenant_id = ? AND engagement_id = ? AND user_id = ? AND revoked_at IS NULL", new Date().toISOString(), actor.tenantId, engagement.id, input.userId);
    if (result.changes !== 1) throw userError("No active access to revoke (not found)");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "audit.access_revoked", objectType: "audit_engagement", objectId: engagement.id, payload: { userId: input.userId } }, tx);
  });
  return input;
}

async function addEvent(tx: { run: (sql: string, ...params: unknown[]) => Promise<unknown> }, actor: Actor, engagementId: string, requestId: string | null, kind: string, body: string, reference: unknown = {}) {
  await tx.run("INSERT INTO audit_events (id,tenant_id,engagement_id,request_id,kind,author_id,body,reference_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)", `aev_${randomUUID()}`, actor.tenantId, engagementId, requestId, kind, actor.userId, body, JSON.stringify(reference), new Date().toISOString());
}

export async function createRequest(actor: Actor, input: { engagementId: string; title: string; description?: string; ucCode?: string; assigneeId?: string; dueAt?: string }) {
  const engagement = await engagementFor(actor, input.engagementId);
  assertOpen(engagement);
  if (input.ucCode && !UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) throw userError("Due date is invalid");
  const db = (await getDb()).scope(actor.tenantId);
  if (input.assigneeId && !(await db.get("SELECT id FROM users WHERE tenant_id = ? AND id = ? AND status = 'active' AND external = 0", actor.tenantId, input.assigneeId))) throw userError("Assignee not found");
  const id = `areq_${randomUUID()}`;
  let ref = "";
  await db.transaction(async (tx) => {
    const count = Number((await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_requests WHERE tenant_id = ? AND engagement_id = ?", actor.tenantId, engagement.id))?.n ?? 0);
    ref = `PBC-${String(count + 1).padStart(3, "0")}`;
    await tx.run("INSERT INTO audit_requests (id,tenant_id,engagement_id,ref,title,description,uc_code,assignee_id,status,due_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id, actor.tenantId, engagement.id, ref, input.title.trim(), input.description ?? "", input.ucCode ?? null, input.assigneeId ?? null, "open", input.dueAt ?? null, actor.userId, new Date().toISOString());
    await addEvent(tx, actor, engagement.id, id, "status", `${ref} opened`);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "audit.request_created", objectType: "audit_request", objectId: id, payload: { ref, title: input.title, ucCode: input.ucCode ?? null } }, tx);
  });
  if (input.assigneeId) await notify(actor.tenantId, { type: "audit.request_due", severity: "medium", title: `Audit request ${ref}: ${input.title}`, body: `${actor.name} requested evidence for ${engagement.name}${input.dueAt ? `, due ${input.dueAt.slice(0, 10)}` : ""}.`, dedupeKey: `audit.request:${id}:assigned` }).catch(() => undefined);
  return { id, ref };
}

/** One request per implemented or partial control mapped to the engagement's framework, skipping controls that already have one. */
export async function generateRequests(actor: Actor, input: { engagementId: string; limit: number }) {
  const engagement = await engagementFor(actor, input.engagementId);
  assertOpen(engagement);
  const db = (await getDb()).scope(actor.tenantId);
  const attested = await db.all<{ uc_code: string; status: string }>("SELECT uc_code, status FROM control_implementations WHERE tenant_id = ? AND status IN ('implemented','partial') ORDER BY uc_code", actor.tenantId);
  const existing = new Set((await db.all<{ uc_code: string | null }>("SELECT uc_code FROM audit_requests WHERE tenant_id = ? AND engagement_id = ?", actor.tenantId, engagement.id)).map((row) => row.uc_code));
  const created: string[] = [];
  for (const row of attested) {
    if (created.length >= input.limit) break;
    const control = UC_BY_CODE.get(row.uc_code);
    const requirements = control ? baseRequirements(row.uc_code, engagement.framework_id) : [];
    if (!control || requirements.length === 0 || existing.has(row.uc_code)) continue;
    const request = await createRequest(actor, { engagementId: engagement.id, title: `Evidence of operation: ${control.title}`, description: `Provide evidence that ${row.uc_code} operated during the period. It supports ${requirements.slice(0, 8).join(", ")}${requirements.length > 8 ? ` and ${requirements.length - 8} more` : ""} of ${FRAMEWORK_BY_ID.get(engagement.framework_id)?.name}.`, ucCode: row.uc_code });
    created.push(request.ref);
  }
  return { created: created.length, refs: created };
}

/** An internal response: a note and/or a reference to evidence that already exists in this tenant, whose hash is recorded. */
export async function respond(actor: Actor, input: { requestId: string; note?: string; evidence?: { type: "control_evidence" | "machine_evidence" | "vault"; id: string } }) {
  const db = (await getDb()).scope(actor.tenantId);
  const request = await db.get<RequestRow>("SELECT * FROM audit_requests WHERE tenant_id = ? AND id = ?", actor.tenantId, input.requestId);
  if (!request) throw userError("Request not found");
  const engagement = await engagementFor(actor, request.engagement_id);
  assertOpen(engagement);
  if (!input.note && !input.evidence) throw userError("A response needs a note or evidence");
  let reference: Record<string, unknown> = {};
  if (input.evidence) {
    const { type, id } = input.evidence;
    const found = type === "control_evidence" ? await db.get<{ id: string; title: string; content_hash: string; status: string; valid_until: string }>("SELECT id, title, content_hash, status, valid_until FROM control_evidence WHERE tenant_id = ? AND id = ?", actor.tenantId, id)
      : type === "machine_evidence" ? await db.get<{ id: string; title: string; content_hash: string; status: string }>("SELECT id, name AS title, content_hash, status FROM evidence WHERE tenant_id = ? AND id = ?", actor.tenantId, id)
      : await db.get<{ id: string; title: string; content_hash: string; status: string }>("SELECT id, name AS title, content_hash, status FROM vault_documents WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
    if (!found) throw userError("Evidence not found");
    if (type === "control_evidence" && found.status !== "accepted") throw userError("Only evidence that another person has accepted can be provided to auditors");
    reference = { type, id: found.id, title: found.title, hash: found.content_hash };
  }
  await db.transaction(async (tx) => {
    await addEvent(tx, actor, engagement.id, request.id, "response", input.note ?? "", reference);
    await tx.run("UPDATE audit_requests SET status = 'provided', resolved_at = NULL WHERE tenant_id = ? AND id = ?", actor.tenantId, request.id);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "audit.response_provided", objectType: "audit_request", objectId: request.id, payload: { ref: request.ref, reference } }, tx);
  });
  return { requestId: request.id, status: "provided" };
}

export async function comment(actor: Actor, input: { requestId: string; body: string }) {
  const db = (await getDb()).scope(actor.tenantId);
  const request = await db.get<RequestRow>("SELECT * FROM audit_requests WHERE tenant_id = ? AND id = ?", actor.tenantId, input.requestId);
  if (!request) throw userError("Request not found");
  const engagement = await engagementFor(actor, request.engagement_id);
  assertOpen(engagement);
  await db.transaction(async (tx) => { await addEvent(tx, actor, engagement.id, request.id, "comment", input.body.trim()); });
  return { requestId: request.id };
}

/** Auditors accept or send back a response; nobody may accept what they provided themselves. */
export async function setRequestStatus(actor: Actor, input: { requestId: string; status: RequestStatus }) {
  const db = (await getDb()).scope(actor.tenantId);
  const request = await db.get<RequestRow>("SELECT * FROM audit_requests WHERE tenant_id = ? AND id = ?", actor.tenantId, input.requestId);
  if (!request) throw userError("Request not found");
  const engagement = await engagementFor(actor, request.engagement_id);
  assertOpen(engagement);
  if ((input.status === "accepted" || input.status === "needs_more") && !isAuditor(actor)) throw userError("Separation of duties: only an auditor can accept a response or send it back");
  if (input.status === "provided") throw userError("A request becomes provided when a response is added");
  if ((input.status === "accepted" || input.status === "needs_more") && request.status !== "provided") throw userError("Only a provided response can be accepted or sent back");
  if (input.status === "open" && isAuditor(actor) && request.status === "accepted") throw userError("An accepted request is final for the auditor; add a comment instead (already accepted)");
  await db.transaction(async (tx) => {
    const result = await tx.run("UPDATE audit_requests SET status = ?, resolved_at = ? WHERE tenant_id = ? AND id = ? AND status = ?", input.status, input.status === "accepted" ? new Date().toISOString() : null, actor.tenantId, request.id, request.status);
    if (result.changes !== 1) throw userError("The request changed while you were reviewing it; reload and try again");
    await addEvent(tx, actor, engagement.id, request.id, "status", `${request.status} -> ${input.status}`);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "audit.request_status", objectType: "audit_request", objectId: request.id, payload: { ref: request.ref, from: request.status, to: input.status } }, tx);
  });
  return { requestId: request.id, status: input.status };
}

export type ControlCoverage = { ucCode: string; title: string; controls: Array<{ code: string; points: number; failures: number; healthyDays: number; failingDays: number; gapDays: number; longestGapDays: number }>; healthyDays: number; failingDays: number; gapDays: number; effectiveness: number | null };

/**
 * Operating effectiveness over the period (SOC 2 Type II): for every unified control linked to executable controls, how many days of
 * the period each had healthy evidence, failing evidence, or none. A point of evidence is valid from when it was collected until the next
 * one or its expiry, whichever comes first; anything after that is a gap, not a pass.
 */
export async function periodCoverage(tenantId: string, engagement: { period_start: string; period_end: string }): Promise<{ periodDays: number; elapsedDays: number; controls: ControlCoverage[] }> {
  const db = (await getDb()).scope(tenantId);
  const start = Date.parse(engagement.period_start);
  const end = Math.min(Date.parse(engagement.period_end), Date.now());
  const elapsed = Math.max(0, (end - start) / DAY);
  const periodDays = Math.round((Date.parse(engagement.period_end) - start) / DAY);
  const links = await db.all<{ uc_code: string; linked_control_code: string }>("SELECT uc_code, linked_control_code FROM control_implementations WHERE tenant_id = ? AND linked_control_code IS NOT NULL AND linked_control_code <> ''", tenantId);
  const result: ControlCoverage[] = [];
  for (const link of links) {
    const per: ControlCoverage["controls"] = [];
    for (const code of [...new Set(link.linked_control_code.split(",").map((item) => item.trim()).filter(Boolean))]) {
      const rows = await db.all<{ collected_at: string; expires_at: string | null; status: string }>(
        "SELECT e.collected_at, e.expires_at, e.status FROM evidence e JOIN controls c ON c.id = e.control_id WHERE e.tenant_id = ? AND c.code = ? AND c.valid_to IS NULL AND e.source NOT LIKE 'manual:%' AND e.collected_at <= ? ORDER BY e.collected_at", tenantId, code, new Date(end).toISOString());
      let healthy = 0, failing = 0, covered = 0, longestGap = 0, cursor = start, points = 0, failures = 0;
      rows.forEach((row, index) => {
        const at = Date.parse(row.collected_at);
        const next = index + 1 < rows.length ? Date.parse(rows[index + 1].collected_at) : end;
        const validUntil = row.expires_at ? Date.parse(row.expires_at) : at + DAY;
        const from = Math.max(at, start), to = Math.min(next, validUntil, end);
        if (at >= start && at <= end) { points += 1; if (row.status === "failed") failures += 1; }
        if (to <= from) return;
        longestGap = Math.max(longestGap, (from - cursor) / DAY);
        if (row.status === "failed") failing += (to - from) / DAY;
        else healthy += (to - from) / DAY;
        covered += to - from;
        cursor = to;
      });
      longestGap = Math.max(longestGap, (end - cursor) / DAY);
      per.push({ code, points, failures, healthyDays: round(healthy), failingDays: round(failing), gapDays: round(Math.max(0, elapsed - covered / DAY)), longestGapDays: round(longestGap) });
    }
    if (!per.length) continue;
    // A unified control is only as effective as its weakest executable control.
    const worst = per.reduce((a, b) => (b.healthyDays < a.healthyDays ? b : a));
    result.push({ ucCode: link.uc_code, title: UC_BY_CODE.get(link.uc_code)?.title ?? link.uc_code, controls: per, healthyDays: worst.healthyDays, failingDays: worst.failingDays, gapDays: worst.gapDays, effectiveness: elapsed > 0 ? round(Math.min(1, worst.healthyDays / elapsed)) : null });
  }
  return { periodDays, elapsedDays: round(elapsed), controls: result.sort((a, b) => a.ucCode.localeCompare(b.ucCode)) };
}

const round = (value: number) => Math.round(value * 100) / 100;

export async function engagementDetail(actor: Actor, id: string) {
  const engagement = await engagementFor(actor, id);
  const db = (await getDb()).scope(actor.tenantId);
  const requests = await db.all<RequestRow & { assignee_name: string | null }>("SELECT r.*, u.name AS assignee_name FROM audit_requests r LEFT JOIN users u ON u.id = r.assignee_id WHERE r.tenant_id = ? AND r.engagement_id = ? ORDER BY r.ref", actor.tenantId, engagement.id);
  const events = await db.all<EventRow & { author_name: string | null }>("SELECT e.*, u.name AS author_name FROM audit_events e LEFT JOIN users u ON u.id = e.author_id WHERE e.tenant_id = ? AND e.engagement_id = ? ORDER BY e.created_at", actor.tenantId, engagement.id);
  const access = actor.external ? [] : await db.all<{ user_id: string; name: string; email: string; expires_at: string; revoked_at: string | null }>("SELECT a.user_id, u.name, u.email, a.expires_at, a.revoked_at FROM audit_access a JOIN users u ON u.id = a.user_id WHERE a.tenant_id = ? AND a.engagement_id = ? ORDER BY u.name", actor.tenantId, engagement.id);
  const now = new Date().toISOString();
  const canManage = !actor.external && actor.role !== "viewer" && actor.role !== "auditor";
  const evidenceOptions = canManage ? await db.all<{ id: string; uc_code: string; title: string }>("SELECT id, uc_code, title FROM control_evidence WHERE tenant_id = ? AND status = 'accepted' ORDER BY uc_code LIMIT 200", actor.tenantId) : [];
  return {
    engagement,
    evidenceOptions,
    requests: requests.map((request) => ({ ...request, overdue: request.due_at !== null && request.due_at < now && ["open", "needs_more"].includes(request.status), events: events.filter((event) => event.request_id === request.id).map((event) => ({ ...event, reference: JSON.parse(event.reference_json) as Record<string, unknown> })) })),
    access: access.map((row) => ({ ...row, active: row.revoked_at === null && row.expires_at > now })),
    coverage: await periodCoverage(actor.tenantId, engagement),
    canManage,
    viewer: { external: actor.external === true, auditor: isAuditor(actor) },
  };
}

/** Records that a pack was downloaded: the engagement's own trail shows who took what and when. */
export async function recordDownload(actor: Actor, engagementId: string, fingerprint: string) {
  const engagement = await engagementFor(actor, engagementId);
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await addEvent(tx, actor, engagement.id, null, "download", "Evidence pack downloaded", { fingerprint });
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "audit.pack_downloaded", objectType: "audit_engagement", objectId: engagement.id, payload: { fingerprint } }, tx);
  });
}

export { engagementFor };
