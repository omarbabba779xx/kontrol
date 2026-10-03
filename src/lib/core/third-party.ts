import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit, sha256 } from "@/lib/core/integrity";
import { notify } from "@/lib/core/notifications";
import {
  concentration,
  registerIssues,
  validLei,
  type ArrangementRecord,
  type ProviderRecord,
  type Subcontractor,
} from "@/lib/core/register-health";
import { createTask, publicLink } from "@/lib/core/tasks";
import { QUESTION_BY_ID, QUESTIONS, scoreAnswers, TEMPLATE_ID, type Answer } from "@/lib/core/vendor-questionnaire";
import { getDb } from "@/lib/db";

/**
 * Third-party risk: the DORA register of information (Art.28(3)) and vendor questionnaires answered through a one-time link.
 * The register export follows the structure of the ITS templates for the register (providers, contractual arrangements, supply
 * chain, assessment) but is not an xBRL-CSV submission file: see docs/DORA_REGISTER.md.
 */
const DAY = 86_400_000;
export const SERVICE_TYPES = [
  "cloud_iaas",
  "cloud_paas",
  "cloud_saas",
  "data_centre",
  "network_telecom",
  "security_services",
  "software_licensing",
  "data_analytics",
  "payment_services",
  "market_data",
  "other_ict",
] as const;
const COUNTRY = /^[A-Z]{2}$/;

type ProviderRow = ProviderRecord & {
  parent_name: string | null;
  parent_lei: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};
type ArrangementRow = Omit<ArrangementRecord, "subcontractors" | "exit_plan" | "audit_rights"> & {
  description: string;
  notice_period_days: number | null;
  subcontractors_json: string;
  exit_plan: number;
  audit_rights: number;
  created_at: string;
  updated_at: string;
};
type QuestionnaireRow = {
  id: string;
  tenant_id: string;
  provider_id: string;
  template: string;
  token_hash: string;
  status: string;
  expires_at: string;
  respondent_name: string | null;
  respondent_email: string | null;
  answers_json: string;
  score: number | null;
  critical_failures: number;
  created_by: string;
  created_at: string;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
};
type StoredAnswers = Record<string, { answer: Answer; comment?: string }>;

const toArrangement = (row: ArrangementRow): ArrangementRecord => ({
  ...row,
  subcontractors: JSON.parse(row.subcontractors_json) as Subcontractor[],
  exit_plan: row.exit_plan === 1,
  audit_rights: row.audit_rights === 1,
});
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const answerMap = (answers: StoredAnswers) => Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, value.answer]));

async function db(tenantId: string) {
  return (await getDb()).scope(tenantId);
}

export async function createProvider(
  actor: Actor,
  input: {
    name: string;
    lei?: string;
    country: string;
    parentName?: string;
    parentLei?: string;
    providerType: "third_party" | "intra_group";
  },
) {
  if (!COUNTRY.test(input.country)) throw userError("Country must be an ISO 3166 alpha-2 code");
  for (const lei of [input.lei, input.parentLei])
    if (lei && !validLei(lei)) throw userError("The LEI is not valid (ISO 17442 check failed)");
  const scope = await db(actor.tenantId);
  if (await scope.get("SELECT id FROM ict_providers WHERE tenant_id = ? AND lower(name) = lower(?)", actor.tenantId, input.name.trim()))
    throw userError("A provider with this name already exists (duplicate)");
  const id = `prv_${randomUUID()}`;
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO ict_providers (id,tenant_id,name,lei,country,parent_name,parent_lei,provider_type,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      actor.tenantId,
      input.name.trim(),
      input.lei ?? null,
      input.country,
      input.parentName ?? null,
      input.parentLei ?? null,
      input.providerType,
      "active",
      actor.userId,
      now,
      now,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "third_party.provider_created",
        objectType: "ict_provider",
        objectId: id,
        payload: { name: input.name, country: input.country },
      },
      tx,
    );
  });
  return { id };
}

export async function updateProvider(
  actor: Actor,
  input: {
    id: string;
    lei?: string | null;
    country?: string;
    parentName?: string | null;
    parentLei?: string | null;
    status?: "active" | "exited";
  },
) {
  const scope = await db(actor.tenantId);
  const row = await scope.get<ProviderRow>("SELECT * FROM ict_providers WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
  if (!row) throw userError("Provider not found");
  if (input.country && !COUNTRY.test(input.country)) throw userError("Country must be an ISO 3166 alpha-2 code");
  for (const lei of [input.lei, input.parentLei])
    if (lei && !validLei(lei)) throw userError("The LEI is not valid (ISO 17442 check failed)");
  if (
    input.status === "exited" &&
    (await scope.get(
      "SELECT id FROM ict_arrangements WHERE tenant_id = ? AND provider_id = ? AND status = 'active'",
      actor.tenantId,
      row.id,
    ))
  )
    throw userError("Terminate the provider's active arrangements before marking it exited");
  await scope.transaction(async (tx) => {
    await tx.run(
      "UPDATE ict_providers SET lei = ?, country = ?, parent_name = ?, parent_lei = ?, status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      input.lei === undefined ? row.lei : input.lei,
      input.country ?? row.country,
      input.parentName === undefined ? row.parent_name : input.parentName,
      input.parentLei === undefined ? row.parent_lei : input.parentLei,
      input.status ?? row.status,
      new Date().toISOString(),
      actor.tenantId,
      row.id,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "third_party.provider_updated",
        objectType: "ict_provider",
        objectId: row.id,
        payload: { status: input.status ?? null, lei: input.lei ?? null, country: input.country ?? null },
      },
      tx,
    );
  });
  return { id: row.id };
}

export type ArrangementInput = {
  providerId: string;
  serviceType: (typeof SERVICE_TYPES)[number];
  description?: string;
  functionSupported: string;
  criticality: "critical_or_important" | "not_critical";
  startDate: string;
  endDate?: string | null;
  noticePeriodDays?: number | null;
  governingLaw?: string | null;
  serviceCountry?: string | null;
  dataCountry?: string | null;
  dataSensitivity: "none" | "personal" | "special_or_confidential";
  subcontractors: Subcontractor[];
  substitutability: "easy" | "difficult" | "impossible" | "not_assessed";
  exitPlan: boolean;
  exitTestedAt?: string | null;
  auditRights: boolean;
  incidentNotificationHours?: number | null;
};

function validateArrangement(input: ArrangementInput) {
  for (const country of [input.governingLaw, input.serviceCountry, input.dataCountry, ...input.subcontractors.map((sub) => sub.country)])
    if (country && !COUNTRY.test(country)) throw userError("Countries must be ISO 3166 alpha-2 codes");
  for (const date of [input.startDate, input.endDate, input.exitTestedAt])
    if (date && Number.isNaN(Date.parse(date))) throw userError("A date is invalid");
  if (input.endDate && Date.parse(input.endDate) < Date.parse(input.startDate))
    throw userError("The end date must not precede the start date");
  if (input.exitTestedAt && !input.exitPlan) throw userError("An exit test requires an exit plan");
}

export async function createArrangement(actor: Actor, input: ArrangementInput) {
  validateArrangement(input);
  const scope = await db(actor.tenantId);
  const provider = await scope.get<ProviderRow>(
    "SELECT * FROM ict_providers WHERE tenant_id = ? AND id = ?",
    actor.tenantId,
    input.providerId,
  );
  if (!provider) throw userError("Provider not found");
  if (provider.status === "exited") throw userError("The provider has exited: it cannot take new arrangements");
  const id = `arr_${randomUUID()}`;
  const now = new Date().toISOString();
  let ref = "";
  await scope.transaction(async (tx) => {
    const count = await tx.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM ict_arrangements WHERE tenant_id = ?", actor.tenantId);
    ref = `ARR-${String(Number(count?.n ?? 0) + 1).padStart(3, "0")}`;
    await tx.run(
      "INSERT INTO ict_arrangements (id,tenant_id,provider_id,ref,service_type,description,function_supported,criticality,start_date,end_date,notice_period_days,governing_law,service_country,data_country,data_sensitivity,subcontractors_json,substitutability,exit_plan,exit_tested_at,audit_rights,incident_notification_hours,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      actor.tenantId,
      provider.id,
      ref,
      input.serviceType,
      input.description ?? "",
      input.functionSupported.trim(),
      input.criticality,
      input.startDate,
      input.endDate ?? null,
      input.noticePeriodDays ?? null,
      input.governingLaw ?? null,
      input.serviceCountry ?? null,
      input.dataCountry ?? null,
      input.dataSensitivity,
      JSON.stringify(input.subcontractors),
      input.substitutability,
      input.exitPlan ? 1 : 0,
      input.exitTestedAt ?? null,
      input.auditRights ? 1 : 0,
      input.incidentNotificationHours ?? null,
      "active",
      actor.userId,
      now,
      now,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "third_party.arrangement_created",
        objectType: "ict_arrangement",
        objectId: id,
        payload: { ref, provider: provider.name, criticality: input.criticality, serviceType: input.serviceType },
      },
      tx,
    );
  });
  return { id, ref };
}

export async function updateArrangement(actor: Actor, input: { id: string; changes: Partial<Omit<ArrangementInput, "providerId">> }) {
  const scope = await db(actor.tenantId);
  const row = await scope.get<ArrangementRow>("SELECT * FROM ict_arrangements WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
  if (!row) throw userError("Arrangement not found");
  if (row.status === "terminated") throw userError("This arrangement is already terminated: it can no longer change");
  const current = toArrangement(row);
  const c = input.changes;
  const merged: ArrangementInput = {
    providerId: row.provider_id,
    serviceType: c.serviceType ?? (row.service_type as ArrangementInput["serviceType"]),
    description: c.description ?? row.description,
    functionSupported: c.functionSupported ?? row.function_supported,
    criticality: c.criticality ?? current.criticality,
    startDate: c.startDate ?? row.start_date,
    endDate: c.endDate === undefined ? row.end_date : c.endDate,
    noticePeriodDays: c.noticePeriodDays === undefined ? row.notice_period_days : c.noticePeriodDays,
    governingLaw: c.governingLaw === undefined ? row.governing_law : c.governingLaw,
    serviceCountry: c.serviceCountry === undefined ? row.service_country : c.serviceCountry,
    dataCountry: c.dataCountry === undefined ? row.data_country : c.dataCountry,
    dataSensitivity: c.dataSensitivity ?? (row.data_sensitivity as ArrangementInput["dataSensitivity"]),
    subcontractors: c.subcontractors ?? current.subcontractors,
    substitutability: c.substitutability ?? (row.substitutability as ArrangementInput["substitutability"]),
    exitPlan: c.exitPlan ?? current.exit_plan,
    exitTestedAt: c.exitTestedAt === undefined ? row.exit_tested_at : c.exitTestedAt,
    auditRights: c.auditRights ?? current.audit_rights,
    incidentNotificationHours: c.incidentNotificationHours === undefined ? row.incident_notification_hours : c.incidentNotificationHours,
  };
  validateArrangement(merged);
  await scope.transaction(async (tx) => {
    await tx.run(
      "UPDATE ict_arrangements SET service_type = ?, description = ?, function_supported = ?, criticality = ?, start_date = ?, end_date = ?, notice_period_days = ?, governing_law = ?, service_country = ?, data_country = ?, data_sensitivity = ?, subcontractors_json = ?, substitutability = ?, exit_plan = ?, exit_tested_at = ?, audit_rights = ?, incident_notification_hours = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      merged.serviceType,
      merged.description ?? "",
      merged.functionSupported,
      merged.criticality,
      merged.startDate,
      merged.endDate ?? null,
      merged.noticePeriodDays ?? null,
      merged.governingLaw ?? null,
      merged.serviceCountry ?? null,
      merged.dataCountry ?? null,
      merged.dataSensitivity,
      JSON.stringify(merged.subcontractors),
      merged.substitutability,
      merged.exitPlan ? 1 : 0,
      merged.exitTestedAt ?? null,
      merged.auditRights ? 1 : 0,
      merged.incidentNotificationHours ?? null,
      new Date().toISOString(),
      actor.tenantId,
      row.id,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "third_party.arrangement_updated",
        objectType: "ict_arrangement",
        objectId: row.id,
        payload: { ref: row.ref, fields: Object.keys(c) },
      },
      tx,
    );
  });
  return { id: row.id };
}

export async function terminateArrangement(actor: Actor, input: { id: string; reason: string }) {
  const scope = await db(actor.tenantId);
  const row = await scope.get<ArrangementRow>("SELECT * FROM ict_arrangements WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
  if (!row) throw userError("Arrangement not found");
  if (row.status === "terminated") throw userError("This arrangement is already terminated");
  await scope.transaction(async (tx) => {
    await tx.run(
      "UPDATE ict_arrangements SET status = 'terminated', updated_at = ? WHERE tenant_id = ? AND id = ?",
      new Date().toISOString(),
      actor.tenantId,
      row.id,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "third_party.arrangement_terminated",
        objectType: "ict_arrangement",
        objectId: row.id,
        payload: { ref: row.ref, reason: input.reason },
      },
      tx,
    );
  });
  return { id: row.id };
}

export async function registerSnapshot(tenantId: string, now = Date.now()) {
  const scope = await db(tenantId);
  const providers = await scope.all<ProviderRow>("SELECT * FROM ict_providers WHERE tenant_id = ? ORDER BY name", tenantId);
  const arrangements = (await scope.all<ArrangementRow>("SELECT * FROM ict_arrangements WHERE tenant_id = ? ORDER BY ref", tenantId)).map(
    toArrangement,
  );
  const rows = await scope.all<QuestionnaireRow>(
    "SELECT id, provider_id, template, status, expires_at, respondent_name, respondent_email, score, critical_failures, created_by, created_at, submitted_at, reviewed_by, reviewed_at, review_note FROM vendor_questionnaires WHERE tenant_id = ? ORDER BY created_at DESC",
    tenantId,
  );
  const questionnaires = rows.map((row) => ({
    id: row.id,
    provider_id: row.provider_id,
    template: row.template,
    status: row.status,
    expires_at: row.expires_at,
    respondent_name: row.respondent_name,
    respondent_email: row.respondent_email,
    score: row.score,
    critical_failures: row.critical_failures,
    created_by: row.created_by,
    created_at: row.created_at,
    submitted_at: row.submitted_at,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    review_note: row.review_note,
    expired: row.status === "sent" && row.expires_at < new Date(now).toISOString(),
  }));
  const issues = registerIssues(providers, arrangements, now);
  return {
    providers,
    arrangements,
    issues,
    exportable: !issues.some((issue) => issue.severity === "error"),
    concentration: concentration(providers, arrangements),
    questionnaires,
  };
}

const csv = (rows: unknown[][]) =>
  rows
    .map((row) =>
      row
        .map((cell) => {
          let text = cell === null || cell === undefined ? "" : String(cell);
          if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(","),
    )
    .join("\n");

/** Export of the register. Refuses while completeness errors remain, so an incomplete register is not mistaken for a final one. */
export async function exportRegister(actor: Actor, format: "json" | "csv") {
  const snapshot = await registerSnapshot(actor.tenantId);
  const errors = snapshot.issues.filter((issue) => issue.severity === "error");
  if (errors.length)
    throw userError(
      `The register is incomplete: ${errors.length} error(s) must be fixed before export (${errors
        .slice(0, 3)
        .map((issue) => `${issue.ref} ${issue.code}`)
        .join(", ")})`,
    );
  const entity = await (await getDb()).system().get<{ name: string }>("SELECT name FROM tenants WHERE id = ?", actor.tenantId);
  const active = snapshot.arrangements.filter((item) => item.status === "active");
  const providerOf = new Map(snapshot.providers.map((provider) => [provider.id, provider as ProviderRow]));
  const contractual = active.map((item) => ({
    arrangement_ref: item.ref,
    provider_lei: providerOf.get(item.provider_id)?.lei ?? null,
    provider_name: providerOf.get(item.provider_id)?.name ?? null,
    service_type: item.service_type,
    function_supported: item.function_supported,
    critical_or_important: item.criticality === "critical_or_important",
    start_date: item.start_date,
    end_date: item.end_date,
    governing_law: item.governing_law,
    service_country: item.service_country,
    data_country: item.data_country,
    data_sensitivity: item.data_sensitivity,
    audit_rights: item.audit_rights,
    incident_notification_hours: item.incident_notification_hours,
  }));
  const providers = (snapshot.providers as ProviderRow[])
    .filter((provider) => provider.status === "active")
    .map((provider) => ({
      lei: provider.lei,
      name: provider.name,
      country: provider.country,
      type: provider.provider_type,
      parent_name: provider.parent_name,
      parent_lei: provider.parent_lei,
    }));
  const supplyChain = active.flatMap((item) =>
    item.subcontractors.map((sub, index) => ({
      arrangement_ref: item.ref,
      rank: sub.rank ?? index + 1,
      subcontractor: sub.name,
      country: sub.country ?? null,
      service: sub.service ?? null,
    })),
  );
  const assessment = active.map((item) => ({
    arrangement_ref: item.ref,
    substitutability: item.substitutability,
    exit_plan: item.exit_plan,
    exit_tested_at: item.exit_tested_at,
  }));
  await appendAudit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "third_party.register_exported",
    objectType: "register",
    objectId: "dora",
    payload: { format, arrangements: active.length, providers: providers.length },
  });
  if (format === "csv")
    return {
      body: csv([Object.keys(contractual[0] ?? { arrangement_ref: "" }), ...contractual.map((row) => Object.values(row))]),
      contentType: "text/csv; charset=utf-8",
      filename: "register-of-information-arrangements.csv",
    };
  const content = {
    format: "kontrol-register-of-information/1",
    entity: entity?.name ?? actor.tenantId,
    generatedAt: new Date().toISOString(),
    notice: "Structured on the ITS templates for the DORA register of information. Not an xBRL-CSV submission file.",
    providers,
    contractualArrangements: contractual,
    supplyChain,
    assessment,
    validation: { errors: 0, warnings: snapshot.issues.length },
    concentration: snapshot.concentration,
  };
  return {
    body: JSON.stringify({ ...content, sha256: sha256(JSON.stringify(content)) }, null, 2),
    contentType: "application/json",
    filename: "register-of-information.json",
  };
}

/* ------------------------------ Questionnaires ------------------------------ */

export async function sendQuestionnaire(actor: Actor, input: { providerId: string; days: number; respondentEmail?: string }) {
  const scope = await db(actor.tenantId);
  const provider = await scope.get<ProviderRow>(
    "SELECT * FROM ict_providers WHERE tenant_id = ? AND id = ?",
    actor.tenantId,
    input.providerId,
  );
  if (!provider) throw userError("Provider not found");
  if (
    await scope.get(
      "SELECT id FROM vendor_questionnaires WHERE tenant_id = ? AND provider_id = ? AND status = 'sent' AND expires_at > ?",
      actor.tenantId,
      provider.id,
      new Date().toISOString(),
    )
  )
    throw userError("A questionnaire is already open for this provider (duplicate): revoke it first");
  const token = randomBytes(32).toString("base64url");
  const id = `vq_${randomUUID()}`;
  const now = Date.now();
  const expiresAt = new Date(now + input.days * DAY).toISOString();
  await scope.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO vendor_questionnaires (id,tenant_id,provider_id,template,token_hash,status,expires_at,respondent_email,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id,
      actor.tenantId,
      provider.id,
      TEMPLATE_ID,
      hashToken(token),
      "sent",
      expiresAt,
      input.respondentEmail ?? null,
      actor.userId,
      new Date(now).toISOString(),
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "third_party.questionnaire_sent",
        objectType: "vendor_questionnaire",
        objectId: id,
        payload: { provider: provider.name, days: input.days },
      },
      tx,
    );
  });
  // The link is the only place the token exists: only its hash is stored.
  return { id, link: publicLink(`/vendor-response/${token}`), expiresAt };
}

export async function revokeQuestionnaire(actor: Actor, id: string) {
  const scope = await db(actor.tenantId);
  const row = await scope.get<QuestionnaireRow>("SELECT * FROM vendor_questionnaires WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
  if (!row) throw userError("Questionnaire not found");
  if (row.status !== "sent") throw userError(`Only an open questionnaire can be revoked: this one is already ${row.status}`);
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE vendor_questionnaires SET status = 'revoked' WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "third_party.questionnaire_revoked",
        objectType: "vendor_questionnaire",
        objectId: id,
        payload: {},
      },
      tx,
    );
  });
  return { id };
}

async function byToken(token: string) {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw userError("Questionnaire not found: the link is invalid, expired or has been used");
  const row = await (
    await getDb()
  )
    .system()
    .get<QuestionnaireRow>("SELECT * FROM vendor_questionnaires WHERE token_hash = ?", hashToken(token));
  // One answer for every unusable link, so a link reveals nothing about why it fails.
  if (!row || row.status !== "sent" || row.expires_at <= new Date().toISOString())
    throw userError("Questionnaire not found: the link is invalid, expired or has been used");
  return row;
}

export async function publicQuestionnaire(token: string) {
  const row = await byToken(token);
  const provider = await (
    await db(row.tenant_id)
  ).get<{ name: string }>("SELECT name FROM ict_providers WHERE tenant_id = ? AND id = ?", row.tenant_id, row.provider_id);
  const tenant = await (await getDb()).system().get<{ name: string }>("SELECT name FROM tenants WHERE id = ?", row.tenant_id);
  return {
    organisation: tenant?.name ?? "",
    provider: provider?.name ?? "",
    expiresAt: row.expires_at,
    questions: QUESTIONS.map(({ id, section, text, evidence }) => ({ id, section, text, evidence: evidence ?? null })),
  };
}

export async function submitPublicQuestionnaire(
  token: string,
  input: { respondentName: string; respondentEmail: string; answers: StoredAnswers },
) {
  const row = await byToken(token);
  for (const id of Object.keys(input.answers)) if (!QUESTION_BY_ID.has(id)) throw userError(`Unknown question ${id}`);
  const missing = QUESTIONS.filter((question) => !input.answers[question.id]);
  if (missing.length) throw userError(`Answer every question: ${missing.length} missing`);
  const scored = scoreAnswers(answerMap(input.answers));
  const scope = await db(row.tenant_id);
  await scope.transaction(async (tx) => {
    // Re-checked in the statement itself: a link answers exactly once even under concurrent submissions.
    const changed = await tx.run(
      "UPDATE vendor_questionnaires SET status = 'submitted', answers_json = ?, score = ?, critical_failures = ?, respondent_name = ?, respondent_email = ?, submitted_at = ? WHERE tenant_id = ? AND id = ? AND status = 'sent'",
      JSON.stringify(input.answers),
      scored.score,
      scored.criticalFailures.length,
      input.respondentName,
      input.respondentEmail,
      new Date().toISOString(),
      row.tenant_id,
      row.id,
    );
    if (changed.changes !== 1) throw userError("Questionnaire not found: the link is invalid, expired or has been used");
    await appendAudit(
      {
        tenantId: row.tenant_id,
        actorId: `external:${input.respondentEmail}`,
        action: "third_party.questionnaire_submitted",
        objectType: "vendor_questionnaire",
        objectId: row.id,
        payload: { score: scored.score, criticalFailures: scored.criticalFailures },
      },
      tx,
    );
  });
  await notify(row.tenant_id, {
    type: "vendor.questionnaire_submitted",
    severity: scored.level === "high" ? "high" : "low",
    title: `Vendor questionnaire submitted (score ${scored.score}/100)`,
    body: `${scored.criticalFailures.length} blocking finding(s). Review it in Third parties.`,
    link: publicLink("/third-party"),
    dedupeKey: `vendor.questionnaire_submitted:${row.id}`,
  });
  return { received: true };
}

export async function reviewQuestionnaire(actor: Actor, input: { id: string; accept: boolean; note: string }) {
  const scope = await db(actor.tenantId);
  const row = await scope.get<QuestionnaireRow>(
    "SELECT * FROM vendor_questionnaires WHERE tenant_id = ? AND id = ?",
    actor.tenantId,
    input.id,
  );
  if (!row) throw userError("Questionnaire not found");
  if (row.status !== "submitted") throw userError(`Only a submitted questionnaire can be reviewed: this one is already ${row.status}`);
  if (row.created_by === actor.userId) throw userError("Separation of duties: the person who sent the questionnaire cannot review it");
  const provider = await scope.get<{ name: string }>(
    "SELECT name FROM ict_providers WHERE tenant_id = ? AND id = ?",
    actor.tenantId,
    row.provider_id,
  );
  const scored = scoreAnswers(answerMap(JSON.parse(row.answers_json) as StoredAnswers));
  await scope.transaction(async (tx) => {
    const changed = await tx.run(
      "UPDATE vendor_questionnaires SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE tenant_id = ? AND id = ? AND status = 'submitted'",
      input.accept ? "accepted" : "rejected",
      actor.userId,
      new Date().toISOString(),
      input.note,
      actor.tenantId,
      row.id,
    );
    if (changed.changes !== 1) throw userError("This questionnaire already changed while you were reviewing it");
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: input.accept ? "third_party.questionnaire_accepted" : "third_party.questionnaire_rejected",
        objectType: "vendor_questionnaire",
        objectId: row.id,
        payload: { score: scored.score, criticalFailures: scored.criticalFailures, note: input.note },
      },
      tx,
    );
  });
  // Every blocking finding becomes work with an owner, so the review ends in remediation rather than a report.
  let tasks = 0;
  if (input.accept) {
    for (const id of scored.criticalFailures) {
      const question = QUESTION_BY_ID.get(id);
      if (!question) continue;
      await createTask(actor, {
        title: `${provider?.name ?? "Vendor"}: ${question.text.slice(0, 120)}`,
        description: `Blocking finding from the vendor questionnaire (${id}). Obtain a remediation commitment or a compensating control.`,
        priority: "high",
        sourceType: "vendor_questionnaire",
        sourceId: row.id,
        ucCode: question.ucCode,
        dueAt: new Date(Date.now() + 30 * DAY).toISOString(),
      });
      tasks += 1;
    }
  }
  return { id: row.id, tasks };
}

export async function questionnaireDetail(actor: Actor, id: string) {
  const row = await (
    await db(actor.tenantId)
  ).get<QuestionnaireRow>("SELECT * FROM vendor_questionnaires WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
  if (!row) throw userError("Questionnaire not found");
  const answers = JSON.parse(row.answers_json) as StoredAnswers;
  return {
    id: row.id,
    status: row.status,
    score: row.score,
    respondent: { name: row.respondent_name, email: row.respondent_email },
    submittedAt: row.submitted_at,
    review: row.reviewed_by ? { by: row.reviewed_by, at: row.reviewed_at, note: row.review_note } : null,
    scored: scoreAnswers(answerMap(answers)),
    answers: QUESTIONS.map((question) => ({
      id: question.id,
      section: question.section,
      text: question.text,
      critical: question.critical === true,
      ucCode: question.ucCode,
      answer: answers[question.id]?.answer ?? null,
      comment: answers[question.id]?.comment ?? "",
    })),
  };
}
