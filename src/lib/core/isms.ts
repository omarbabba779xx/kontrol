import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { complianceSnapshot } from "@/lib/core/compliance-engine";
import { UserError, userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { ismsClauses } from "@/lib/core/isms-checks";
import { riskSnapshot } from "@/lib/core/risk-register";
import { createTask } from "@/lib/core/tasks";
import { UC_BY_CODE } from "@/lib/frameworks/unified";
import { getDb } from "@/lib/db";

/**
 * The management system itself: the records ISO/IEC 27001 clauses 4 to 10 ask an organisation to keep, with the decisions that belong
 * to management kept for an administrator and the checks that need a second person kept for someone other than the owner.
 */
export const CONTEXT_KINDS = ["internal_issue", "external_issue", "interested_party"] as const;
export const OBJECTIVE_STATUSES = ["planned", "on_track", "at_risk", "achieved", "missed"] as const;
export const NC_SOURCES = ["internal_audit", "external_audit", "incident", "monitoring", "management_review", "other"] as const;
export const NC_SEVERITIES = ["major", "minor", "observation"] as const;
type ContextKind = (typeof CONTEXT_KINDS)[number];
type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

const db = async (tenantId: string) => (await getDb()).scope(tenantId);
const management = (actor: Actor, what: string) => {
  if (actor.role !== "admin") throw new UserError(`Only an administrator can ${what}: it is a management decision`, 403);
};
const audit = (actor: Actor, action: string, objectType: string, objectId: string, payload: unknown, tx: Parameters<typeof appendAudit>[1]) =>
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action, objectType, objectId, payload }, tx);

async function activeUser(tenantId: string, userId: string | null | undefined) {
  if (!userId) return null;
  const user = await (await db(tenantId)).get<{ id: string; status: string; external: number }>("SELECT id, status, external FROM users WHERE tenant_id = ? AND id = ?", tenantId, userId);
  if (!user || user.external === 1) throw userError("Owner not found");
  if (user.status !== "active") throw userError("Owner is disabled");
  return user.id;
}

// Clause 4.1 and 4.2 ------------------------------------------------------------------------------------------------------

export async function saveContextItem(actor: Actor, input: { id?: string; kind: ContextKind; title: string; detail?: string; requirement?: string }) {
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  const id = input.id ?? `ctx_${randomUUID()}`;
  if (input.kind === "interested_party" && !input.requirement?.trim()) throw userError("State what this interested party requires");
  await scope.transaction(async (tx) => {
    if (input.id) {
      const changed = await tx.run("UPDATE isms_context SET kind = ?, title = ?, detail = ?, requirement = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", input.kind, input.title.trim(), input.detail ?? "", input.requirement?.trim() ?? "", actor.userId, now, actor.tenantId, id);
      if (changed.changes !== 1) throw userError("Context item not found");
    } else {
      await tx.run("INSERT INTO isms_context (id,tenant_id,kind,title,detail,requirement,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)", id, actor.tenantId, input.kind, input.title.trim(), input.detail ?? "", input.requirement?.trim() ?? "", actor.userId, now);
    }
    await audit(actor, input.id ? "isms.context_updated" : "isms.context_added", "isms_context", id, { kind: input.kind, title: input.title }, tx);
  });
  return { id };
}

export async function removeContextItem(actor: Actor, input: { id: string }) {
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    const row = await tx.get<{ kind: string; title: string }>("SELECT kind, title FROM isms_context WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
    if (!row) throw userError("Context item not found");
    await tx.run("DELETE FROM isms_context WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
    await audit(actor, "isms.context_removed", "isms_context", input.id, row, tx);
  });
  return { id: input.id };
}

// Clause 4.3 ---------------------------------------------------------------------------------------------------------------

export async function approveScope(actor: Actor, input: { statement: string; boundaries?: string; exclusions?: string }) {
  management(actor, "approve the scope of the ISMS");
  const scope = await db(actor.tenantId);
  const previous = await scope.get<{ version: number }>("SELECT version FROM isms_scope WHERE tenant_id = ?", actor.tenantId);
  const version = Number(previous?.version ?? 0) + 1;
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO isms_scope (tenant_id,statement,boundaries,exclusions,version,approved_by,approved_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET statement = excluded.statement, boundaries = excluded.boundaries, exclusions = excluded.exclusions, version = excluded.version, approved_by = excluded.approved_by, approved_at = excluded.approved_at",
      actor.tenantId, input.statement.trim(), input.boundaries ?? "", input.exclusions ?? "", version, actor.userId, now);
    await audit(actor, "isms.scope_approved", "isms_scope", actor.tenantId, { version, statement: input.statement.trim(), exclusions: input.exclusions ?? "" }, tx);
  });
  return { version };
}

// Clause 6.2 ---------------------------------------------------------------------------------------------------------------

export async function saveObjective(actor: Actor, input: { id?: string; title: string; measure: string; target: string; ownerId?: string | null; dueAt: string; status?: ObjectiveStatus }) {
  if (Number.isNaN(Date.parse(input.dueAt))) throw userError("Due date is invalid");
  const ownerId = await activeUser(actor.tenantId, input.ownerId);
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  const id = input.id ?? `obj_${randomUUID()}`;
  await scope.transaction(async (tx) => {
    if (input.id) {
      const changed = await tx.run("UPDATE isms_objectives SET title = ?, measure = ?, target = ?, owner_id = ?, due_at = ?, status = COALESCE(?, status), updated_at = ? WHERE tenant_id = ? AND id = ?", input.title.trim(), input.measure.trim(), input.target.trim(), ownerId, input.dueAt, input.status ?? null, now, actor.tenantId, id);
      if (changed.changes !== 1) throw userError("Objective not found");
    } else {
      await tx.run("INSERT INTO isms_objectives (id,tenant_id,title,measure,target,owner_id,due_at,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, actor.tenantId, input.title.trim(), input.measure.trim(), input.target.trim(), ownerId, input.dueAt, input.status ?? "planned", actor.userId, now, now);
    }
    await audit(actor, input.id ? "isms.objective_updated" : "isms.objective_set", "isms_objective", id, { title: input.title, target: input.target, dueAt: input.dueAt }, tx);
  });
  return { id };
}

/** Records a measurement against an objective: the value observed, and where the objective stands as a result. */
export async function measureObjective(actor: Actor, input: { id: string; value: string; status: ObjectiveStatus }) {
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    const changed = await tx.run("UPDATE isms_objectives SET current_value = ?, status = ?, measured_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", input.value.trim(), input.status, now, now, actor.tenantId, input.id);
    if (changed.changes !== 1) throw userError("Objective not found");
    await audit(actor, "isms.objective_measured", "isms_objective", input.id, { value: input.value.trim(), status: input.status }, tx);
  });
  return { id: input.id, measuredAt: now };
}

// Clause 9.3 ---------------------------------------------------------------------------------------------------------------

/**
 * The inputs clause 9.3.2 lists, read from the system at the moment the review is prepared and frozen with it: what management saw is
 * part of the record, and does not change when the posture does.
 */
async function reviewInputs(tenantId: string) {
  const scope = await db(tenantId);
  const [compliance, risks, clauses] = await Promise.all([complianceSnapshot(tenantId), riskSnapshot(tenantId), ismsClauses(scope, tenantId)]);
  const previous = await scope.get<{ id: string; held_at: string }>("SELECT id, held_at FROM isms_reviews WHERE tenant_id = ? AND status = 'approved' ORDER BY held_at DESC LIMIT 1", tenantId);
  const actions = previous ? await scope.all<{ status: string }>("SELECT status FROM tasks WHERE tenant_id = ? AND source_type = 'management_review' AND source_id = ?", tenantId, previous.id) : [];
  const ncs = await scope.all<{ status: string; severity: string; source: string }>("SELECT status, severity, source FROM isms_nonconformities WHERE tenant_id = ?", tenantId);
  const objectives = await scope.all<{ title: string; target: string; current_value: string; status: string }>("SELECT title, target, current_value, status FROM isms_objectives WHERE tenant_id = ? ORDER BY due_at", tenantId);
  const audits = await scope.all<{ name: string; status: string; closed_at: string | null }>("SELECT name, status, closed_at FROM audit_engagements WHERE tenant_id = ? AND kind = 'internal' ORDER BY period_end DESC LIMIT 5", tenantId);
  const context = await scope.all<{ kind: string; title: string; updated_at: string }>("SELECT kind, title, updated_at FROM isms_context WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 50", tenantId);
  return {
    preparedAt: new Date().toISOString(),
    previousReview: previous ? { heldAt: previous.held_at, actions: actions.length, actionsDone: actions.filter((item) => item.status === "done").length } : null,
    contextChanges: context.filter((item) => !previous || item.updated_at > previous.held_at).map((item) => ({ kind: item.kind, title: item.title })),
    nonconformities: { total: ncs.length, open: ncs.filter((item) => item.status !== "closed").length, majorOpen: ncs.filter((item) => item.status !== "closed" && item.severity === "major").length },
    monitoring: compliance.scores.map((score) => ({ frameworkId: score.frameworkId, score: score.score, readiness: score.readiness, backed: score.assessment.dimensions.backed, blockers: score.assessment.blockers })),
    internalAudits: audits,
    objectives,
    risk: { method: risks.method.method, appetite: risks.method.appetite, open: risks.summary.open, critical: risks.summary.critical, high: risks.summary.high, aboveAppetite: risks.summary.aboveAppetite, untreated: risks.summary.untreated, acceptanceExpired: risks.summary.acceptanceExpired },
    clauses: clauses.map((item) => ({ clause: item.clause, status: item.status })),
  };
}

export async function prepareReview(actor: Actor, input: { heldAt: string; attendees: string }) {
  if (Number.isNaN(Date.parse(input.heldAt))) throw userError("Review date is invalid");
  const inputs = await reviewInputs(actor.tenantId);
  const id = `rev_${randomUUID()}`;
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run("INSERT INTO isms_reviews (id,tenant_id,held_at,attendees,inputs_json,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)", id, actor.tenantId, input.heldAt, input.attendees.trim(), JSON.stringify(inputs), "draft", actor.userId, new Date().toISOString());
    await audit(actor, "isms.review_prepared", "isms_review", id, { heldAt: input.heldAt }, tx);
  });
  return { id, inputs };
}

/** Management approves the review with its decisions; each action it decides becomes a task that the next review will report on. */
export async function approveReview(actor: Actor, input: { id: string; decisions: string; actions?: Array<{ title: string; assigneeId?: string; dueAt?: string }> }) {
  management(actor, "approve a management review");
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    const changed = await tx.run("UPDATE isms_reviews SET status = 'approved', decisions = ?, approved_by = ?, approved_at = ? WHERE tenant_id = ? AND id = ? AND status = 'draft'", input.decisions.trim(), actor.userId, now, actor.tenantId, input.id);
    if (changed.changes !== 1) throw userError("This review was not found or is already approved");
    await audit(actor, "isms.review_approved", "isms_review", input.id, { decisions: input.decisions.trim(), actions: (input.actions ?? []).map((item) => item.title) }, tx);
  });
  const tasks: string[] = [];
  for (const action of input.actions ?? []) {
    const task = await createTask(actor, { title: action.title.slice(0, 200), description: "Decided by the management review.", priority: "medium", assigneeId: action.assigneeId, dueAt: action.dueAt, sourceType: "management_review", sourceId: input.id });
    tasks.push(task.id);
  }
  return { id: input.id, tasks };
}

// Clause 10.2 --------------------------------------------------------------------------------------------------------------

export type NonconformityView = { id: string; ref: string; source: string; severity: string; title: string; description: string; requirement: string; uc_code: string | null; root_cause: string; correction: string; corrective_action: string; owner_id: string | null; due_at: string | null; status: "open" | "action_planned" | "implemented" | "closed"; effectiveness_note: string | null; verified_by: string | null; verified_at: string | null; raised_by: string; raised_at: string };
type NcRow = { id: string; ref: string; status: "open" | "action_planned" | "implemented" | "closed"; severity: string; owner_id: string | null; raised_by: string; root_cause: string; corrective_action: string };

export async function raiseNonconformity(actor: Actor, input: { source: (typeof NC_SOURCES)[number]; severity: (typeof NC_SEVERITIES)[number]; title: string; description?: string; requirement?: string; ucCode?: string; ownerId?: string; dueAt?: string; correction?: string }) {
  if (input.ucCode && !UC_BY_CODE.has(input.ucCode)) throw userError(`Control ${input.ucCode} not found`);
  if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) throw userError("Due date is invalid");
  const ownerId = await activeUser(actor.tenantId, input.ownerId);
  const scope = await db(actor.tenantId);
  const id = `nc_${randomUUID()}`;
  const now = new Date().toISOString();
  let ref = "";
  await scope.transaction(async (tx) => {
    const count = await tx.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM isms_nonconformities WHERE tenant_id = ?", actor.tenantId);
    ref = `NC-${String(Number(count?.n ?? 0) + 1).padStart(3, "0")}`;
    await tx.run("INSERT INTO isms_nonconformities (id,tenant_id,ref,source,severity,title,description,requirement,uc_code,correction,owner_id,due_at,status,raised_by,raised_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, actor.tenantId, ref, input.source, input.severity, input.title.trim(), input.description ?? "", input.requirement ?? "", input.ucCode ?? null, input.correction ?? "", ownerId, input.dueAt ?? null, "open", actor.userId, now, now);
    await audit(actor, "isms.nonconformity_raised", "isms_nonconformity", id, { ref, source: input.source, severity: input.severity, title: input.title, requirement: input.requirement ?? "", ucCode: input.ucCode ?? null }, tx);
  });
  return { id, ref };
}

async function loadNc(actor: Actor, id: string) {
  const row = await (await db(actor.tenantId)).get<NcRow>("SELECT id, ref, status, severity, owner_id, raised_by, root_cause, corrective_action FROM isms_nonconformities WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
  if (!row) throw userError("Nonconformity not found");
  if (row.status === "closed") throw userError("This nonconformity is closed (already final): it can no longer change");
  return row;
}

/** The cause is analysed and an action that removes it is planned, with an owner and a date. A correction alone is not a corrective action. */
export async function planCorrectiveAction(actor: Actor, input: { id: string; rootCause: string; correctiveAction: string; ownerId: string; dueAt: string; correction?: string }) {
  const row = await loadNc(actor, input.id);
  if (Number.isNaN(Date.parse(input.dueAt))) throw userError("Due date is invalid");
  const ownerId = await activeUser(actor.tenantId, input.ownerId);
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE isms_nonconformities SET root_cause = ?, corrective_action = ?, correction = COALESCE(?, correction), owner_id = ?, due_at = ?, status = 'action_planned', updated_at = ? WHERE tenant_id = ? AND id = ?", input.rootCause.trim(), input.correctiveAction.trim(), input.correction ?? null, ownerId, input.dueAt, new Date().toISOString(), actor.tenantId, row.id);
    await audit(actor, "isms.corrective_action_planned", "isms_nonconformity", row.id, { ref: row.ref, rootCause: input.rootCause.trim(), correctiveAction: input.correctiveAction.trim(), dueAt: input.dueAt }, tx);
  });
  return { id: row.id };
}

export async function markImplemented(actor: Actor, input: { id: string; note: string }) {
  const row = await loadNc(actor, input.id);
  if (row.status !== "action_planned") throw userError("Plan the corrective action before marking it implemented");
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE isms_nonconformities SET status = 'implemented', updated_at = ? WHERE tenant_id = ? AND id = ?", new Date().toISOString(), actor.tenantId, row.id);
    await audit(actor, "isms.corrective_action_implemented", "isms_nonconformity", row.id, { ref: row.ref, note: input.note }, tx);
  });
  return { id: row.id };
}

/**
 * Closing reviews whether the action worked. The person who owns the action, or who raised the finding against their own area, is not
 * the one to say so: a second person verifies, and says what they checked.
 */
export async function verifyAndClose(actor: Actor, input: { id: string; effective: boolean; note: string }) {
  const row = await loadNc(actor, input.id);
  if (row.status !== "implemented") throw userError("The corrective action must be implemented before its effectiveness is reviewed");
  if (row.owner_id === actor.userId) throw userError("Separation of duties: the owner of a corrective action cannot verify it");
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    // Not effective: the nonconformity goes back to planning, with the reviewer's note on record.
    if (input.effective) await tx.run("UPDATE isms_nonconformities SET status = 'closed', effectiveness_note = ?, verified_by = ?, verified_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", input.note.trim(), actor.userId, now, now, actor.tenantId, row.id);
    else await tx.run("UPDATE isms_nonconformities SET status = 'open', effectiveness_note = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", input.note.trim(), now, actor.tenantId, row.id);
    await audit(actor, input.effective ? "isms.nonconformity_closed" : "isms.corrective_action_ineffective", "isms_nonconformity", row.id, { ref: row.ref, note: input.note.trim() }, tx);
  });
  return { id: row.id, status: input.effective ? "closed" : "open" };
}

// Everything on one page ---------------------------------------------------------------------------------------------------

export async function ismsSnapshot(tenantId: string) {
  const scope = await db(tenantId);
  const now = new Date().toISOString();
  const [context, scopeRow, objectives, reviews, ncs, audits, clauses] = await Promise.all([
    scope.all<{ id: string; kind: ContextKind; title: string; detail: string; requirement: string; updated_at: string }>("SELECT id, kind, title, detail, requirement, updated_at FROM isms_context WHERE tenant_id = ? ORDER BY kind, title LIMIT 500", tenantId),
    scope.get<{ statement: string; boundaries: string; exclusions: string; version: number; approved_by: string; approved_at: string }>("SELECT statement, boundaries, exclusions, version, approved_by, approved_at FROM isms_scope WHERE tenant_id = ?", tenantId),
    scope.all<{ id: string; title: string; measure: string; target: string; current_value: string; owner_id: string | null; due_at: string; status: ObjectiveStatus; measured_at: string | null }>("SELECT id, title, measure, target, current_value, owner_id, due_at, status, measured_at FROM isms_objectives WHERE tenant_id = ? ORDER BY due_at LIMIT 200", tenantId),
    scope.all<{ id: string; held_at: string; attendees: string; inputs_json: string; decisions: string; status: string; approved_by: string | null; approved_at: string | null }>("SELECT id, held_at, attendees, inputs_json, decisions, status, approved_by, approved_at FROM isms_reviews WHERE tenant_id = ? ORDER BY held_at DESC LIMIT 20", tenantId),
    scope.all<NonconformityView>("SELECT * FROM isms_nonconformities WHERE tenant_id = ? ORDER BY raised_at DESC LIMIT 300", tenantId),
    scope.all<{ id: string; name: string; status: string; period_start: string; period_end: string; closed_at: string | null }>("SELECT id, name, status, period_start, period_end, closed_at FROM audit_engagements WHERE tenant_id = ? AND kind = 'internal' ORDER BY period_end DESC LIMIT 20", tenantId),
    ismsClauses(scope, tenantId),
  ]);
  const met = clauses.filter((item) => item.status === "met").length;
  return {
    clauses,
    summary: { met, partial: clauses.filter((item) => item.status === "partial").length, missing: clauses.filter((item) => item.status === "missing").length, total: clauses.length, next: clauses.filter((item) => item.next).slice(0, 5).map((item) => `${item.clause}: ${item.next}`) },
    context,
    scope: scopeRow ?? null,
    objectives: objectives.map((objective) => ({ ...objective, overdue: !["achieved", "missed"].includes(objective.status) && objective.due_at < now })),
    reviews: reviews.map(({ inputs_json, ...review }) => ({ ...review, inputs: JSON.parse(inputs_json) as unknown })),
    nonconformities: ncs.map((item) => ({ ...item, overdue: item.status !== "closed" && item.due_at !== null && item.due_at < now })),
    internalAudits: audits,
  };
}
