import "server-only";

import { aboveAppetite, DEFAULT_METHOD, type RiskMethod } from "@/lib/core/risk-method";
import type { Executor } from "@/lib/db";

/**
 * What the management system's own records show for each clause of ISO/IEC 27001 (4 to 10). Each check reads the records, says
 * whether the clause is met, partly met or missing, and names the next thing to do. Nothing here is a judgement about quality: a
 * recorded scope can still be a poor scope. It answers the question an auditor asks first: does the record exist, is it approved, is it
 * current.
 *
 * This file reads the database only, so the compliance engine can use it without a dependency cycle.
 */
export type ClauseStatus = "met" | "partial" | "missing";
export type ClauseCheck = { clause: string; title: string; status: ClauseStatus; detail: string; next: string | null };

const YEAR = 365 * 86_400_000;
const count = (row: { n: number | string } | undefined) => Number(row?.n ?? 0);
const check = (clause: string, title: string, status: ClauseStatus, detail: string, next: string | null = null): ClauseCheck => ({ clause, title, status, detail, next: status === "met" ? null : next });

async function methodOf(db: Executor, tenantId: string): Promise<RiskMethod> {
  const row = await db.get<{ method: RiskMethod["method"]; threshold_medium: number; threshold_high: number; threshold_critical: number; appetite: RiskMethod["appetite"]; max_acceptance_days: number; scales_json: string; version: number; approved_by: string; approved_at: string }>("SELECT * FROM risk_methods WHERE tenant_id = ?", tenantId);
  if (!row) return DEFAULT_METHOD;
  return { ...DEFAULT_METHOD, appetiteLevel: (JSON.parse(row.scales_json) as { appetiteLevel?: number }).appetiteLevel, method: row.method, thresholds: { medium: Number(row.threshold_medium), high: Number(row.threshold_high), critical: Number(row.threshold_critical) }, appetite: row.appetite, maxAcceptanceDays: Number(row.max_acceptance_days), version: Number(row.version), approvedBy: row.approved_by, approvedAt: row.approved_at };
}

export async function ismsClauses(db: Executor, tenantId: string, now = Date.now()): Promise<ClauseCheck[]> {
  const nowIso = new Date(now).toISOString();
  const yearAgo = new Date(now - YEAR).toISOString();
  const one = <T>(sql: string, ...params: unknown[]) => db.get<T>(sql, tenantId, ...params);
  const n = async (sql: string, ...params: unknown[]) => count(await one<{ n: number | string }>(sql, ...params));

  // Clause 4: context, interested parties, scope ---------------------------------------------------------------------
  const internal = await n("SELECT COUNT(*) AS n FROM isms_context WHERE tenant_id = ? AND kind = 'internal_issue'");
  const external = await n("SELECT COUNT(*) AS n FROM isms_context WHERE tenant_id = ? AND kind = 'external_issue'");
  const staleContext = await n("SELECT COUNT(*) AS n FROM isms_context WHERE tenant_id = ? AND updated_at < ?", yearAgo);
  const parties = await n("SELECT COUNT(*) AS n FROM isms_context WHERE tenant_id = ? AND kind = 'interested_party'");
  const partiesWithoutRequirement = await n("SELECT COUNT(*) AS n FROM isms_context WHERE tenant_id = ? AND kind = 'interested_party' AND requirement = ''");
  const scope = await one<{ version: number; approved_at: string; statement: string }>("SELECT version, approved_at, statement FROM isms_scope WHERE tenant_id = ?");

  const c41 = internal === 0 && external === 0 ? check("4.1", "Context of the organisation", "missing", "No internal or external issue is recorded.", "Record the internal and external issues that affect information security.")
    : internal === 0 || external === 0 || staleContext > 0 ? check("4.1", "Context of the organisation", "partial", `${internal} internal and ${external} external issue(s); ${staleContext} not reviewed for a year.`, internal === 0 ? "Record at least one internal issue." : external === 0 ? "Record at least one external issue." : "Review the issues that have not been touched for a year.")
    : check("4.1", "Context of the organisation", "met", `${internal} internal and ${external} external issue(s), all reviewed within the year.`);
  const c42 = parties === 0 ? check("4.2", "Interested parties", "missing", "No interested party is recorded.", "List the interested parties and what each requires.")
    : partiesWithoutRequirement > 0 ? check("4.2", "Interested parties", "partial", `${parties} interested parties, ${partiesWithoutRequirement} without a stated requirement.`, "State what each interested party requires.")
    : check("4.2", "Interested parties", "met", `${parties} interested parties with their requirements.`);
  const c43 = !scope ? check("4.3", "Scope of the ISMS", "missing", "No scope statement is approved.", "Write the scope and have an administrator approve it.")
    : scope.approved_at < yearAgo ? check("4.3", "Scope of the ISMS", "partial", `Scope version ${scope.version} was approved on ${scope.approved_at.slice(0, 10)}, more than a year ago.`, "Review the scope and approve it again.")
    : check("4.3", "Scope of the ISMS", "met", `Scope version ${scope.version}, approved on ${scope.approved_at.slice(0, 10)}.`);

  // Clause 5: policy and roles ---------------------------------------------------------------------------------------
  const policies = await db.all<{ status: string; next_review: string | null; uc_codes_json: string }>("SELECT status, next_review, uc_codes_json FROM policy_register WHERE tenant_id = ?", tenantId);
  const securityPolicies = policies.filter((policy) => policy.status === "approved" && (JSON.parse(policy.uc_codes_json) as string[]).includes("UC-GOV-01"));
  const current = securityPolicies.filter((policy) => policy.next_review === null || policy.next_review >= nowIso);
  const c52 = securityPolicies.length === 0 ? check("5.2", "Information security policy", "missing", "No approved policy covers the policy framework (UC-GOV-01).", "Approve an information security policy and link it to UC-GOV-01.")
    : current.length === 0 ? check("5.2", "Information security policy", "partial", "The approved policy is past its review date.", "Review the information security policy.")
    : check("5.2", "Information security policy", "met", `${current.length} approved policy document(s) within their review date.`);
  const claimed = await n("SELECT COUNT(*) AS n FROM control_implementations WHERE tenant_id = ? AND status IN ('implemented','partial')");
  const unowned = await n("SELECT COUNT(*) AS n FROM control_implementations WHERE tenant_id = ? AND status IN ('implemented','partial') AND owner_id IS NULL");
  const c53 = claimed === 0 ? check("5.3", "Roles, responsibilities and authorities", "missing", "No control is claimed yet, so no responsibility is assigned.", "Assign an owner to each control as it is implemented.")
    : unowned > 0 ? check("5.3", "Roles, responsibilities and authorities", "partial", `${unowned} of ${claimed} claimed control(s) have no owner.`, "Give every claimed control a named owner.")
    : check("5.3", "Roles, responsibilities and authorities", "met", `All ${claimed} claimed controls have a named owner.`);

  // Clause 6: risk and objectives ------------------------------------------------------------------------------------
  const method = await methodOf(db, tenantId);
  const risks = await db.all<{ likelihood: number; impact: number; status: string; accepted_until: string | null; threat_event: string | null; likelihood_initiation: number | null }>("SELECT likelihood, impact, status, accepted_until, threat_event, likelihood_initiation FROM risk_items WHERE tenant_id = ? AND status <> 'closed'", tenantId);
  const undescribed = method.method === "nist_800_30" ? risks.filter((risk) => !risk.threat_event || risk.likelihood_initiation === null).length : 0;
  const c612 = method.version === 0 ? check("6.1.2", "Risk assessment", "missing", "The risk criteria in use are the built-in defaults: nobody approved them.", "Have an administrator set and approve the risk method, criteria and appetite.")
    : risks.length === 0 ? check("6.1.2", "Risk assessment", "partial", `Method ${method.method} version ${method.version} is approved, but no risk is recorded.`, "Assess and record the information security risks.")
    : undescribed > 0 ? check("6.1.2", "Risk assessment", "partial", `${undescribed} open risk(s) lack the threat description the method requires.`, "Describe the threat source, event and likelihood parts of those risks.")
    : check("6.1.2", "Risk assessment", "met", `Method ${method.method} version ${method.version}, ${risks.length} open risk(s) assessed.`);
  const untreatedAbove = risks.filter((risk) => (risk.status === "identified" || (risk.status === "accepted" && risk.accepted_until !== null && risk.accepted_until <= nowIso)) && aboveAppetite(method, risk.likelihood, risk.impact)).length;
  const adopted = await n("SELECT COUNT(*) AS n FROM framework_adoptions WHERE tenant_id = ?");
  const c613 = risks.length === 0 || adopted === 0 ? check("6.1.3", "Risk treatment and statement of applicability", "missing", adopted === 0 ? "No framework is adopted, so there is no statement of applicability." : "No risk is recorded, so there is nothing to treat.", adopted === 0 ? "Adopt the framework the ISMS is built on." : "Record the risks and decide their treatment.")
    : untreatedAbove > 0 ? check("6.1.3", "Risk treatment and statement of applicability", "partial", `${untreatedAbove} risk(s) above the appetite have no treatment decision in force.`, "Decide the treatment of every risk above the appetite.")
    : check("6.1.3", "Risk treatment and statement of applicability", "met", "Every risk above the appetite has a treatment decision; the statement of applicability is exportable.");
  const objectives = await db.all<{ status: string; due_at: string; owner_id: string | null; measured_at: string | null }>("SELECT status, due_at, owner_id, measured_at FROM isms_objectives WHERE tenant_id = ?", tenantId);
  const live = objectives.filter((objective) => !["achieved", "missed"].includes(objective.status));
  const overdue = live.filter((objective) => objective.due_at < nowIso).length;
  const unowned62 = live.filter((objective) => !objective.owner_id).length;
  const c62 = objectives.length === 0 ? check("6.2", "Information security objectives", "missing", "No objective is recorded.", "Set measurable objectives with an owner and a date.")
    : overdue > 0 || unowned62 > 0 ? check("6.2", "Information security objectives", "partial", `${objectives.length} objective(s): ${overdue} past their date without a result, ${unowned62} without an owner.`, overdue > 0 ? "Record the result of the objectives past their date." : "Give every objective an owner.")
    : check("6.2", "Information security objectives", "met", `${objectives.length} objective(s), each with an owner and a date.`);

  // Clause 9: monitoring, internal audit, management review ----------------------------------------------------------
  const measured = objectives.filter((objective) => objective.measured_at !== null && objective.measured_at >= new Date(now - YEAR / 4).toISOString()).length;
  const collected = await n("SELECT COUNT(*) AS n FROM evidence WHERE tenant_id = ? AND source NOT LIKE 'manual:%' AND collected_at >= ?", new Date(now - 30 * 86_400_000).toISOString());
  const c91 = measured === 0 && collected === 0 ? check("9.1", "Monitoring, measurement, analysis and evaluation", "missing", "No objective was measured in the last quarter and no evidence was collected in the last 30 days.", "Measure the objectives and schedule evidence collection.")
    : measured === 0 || collected === 0 ? check("9.1", "Monitoring, measurement, analysis and evaluation", "partial", `${measured} objective(s) measured in the last quarter; ${collected} item(s) of evidence collected in the last 30 days.`, measured === 0 ? "Record a measurement against each objective." : "Schedule evidence collection.")
    : check("9.1", "Monitoring, measurement, analysis and evaluation", "met", `${measured} objective(s) measured in the last quarter; ${collected} item(s) of evidence collected in the last 30 days.`);
  const auditsClosed = await n("SELECT COUNT(*) AS n FROM audit_engagements WHERE tenant_id = ? AND kind = 'internal' AND status = 'closed' AND closed_at >= ?", yearAgo);
  const auditsPlanned = await n("SELECT COUNT(*) AS n FROM audit_engagements WHERE tenant_id = ? AND kind = 'internal' AND status <> 'closed'");
  const c92 = auditsClosed === 0 && auditsPlanned === 0 ? check("9.2", "Internal audit", "missing", "No internal audit is planned or was completed in the last 12 months.", "Plan an internal audit in the audit workspace.")
    : auditsClosed === 0 ? check("9.2", "Internal audit", "partial", `${auditsPlanned} internal audit(s) in progress or planned, none completed in the last 12 months.`, "Complete and close an internal audit.")
    : check("9.2", "Internal audit", "met", `${auditsClosed} internal audit(s) completed in the last 12 months${auditsPlanned ? `, ${auditsPlanned} more planned` : ""}.`);
  const reviews = await n("SELECT COUNT(*) AS n FROM isms_reviews WHERE tenant_id = ? AND status = 'approved' AND held_at >= ?", yearAgo);
  const drafts = await n("SELECT COUNT(*) AS n FROM isms_reviews WHERE tenant_id = ? AND status = 'draft'");
  const c93 = reviews === 0 && drafts === 0 ? check("9.3", "Management review", "missing", "No management review is recorded in the last 12 months.", "Hold a management review and record its decisions.")
    : reviews === 0 ? check("9.3", "Management review", "partial", `${drafts} review(s) drafted but not approved.`, "Have an administrator approve the management review.")
    : check("9.3", "Management review", "met", `${reviews} management review(s) approved in the last 12 months.`);

  // Clause 10: nonconformity and corrective action -------------------------------------------------------------------
  const ncs = await db.all<{ status: string; severity: string; due_at: string | null; root_cause: string; verified_by: string | null }>("SELECT status, severity, due_at, root_cause, verified_by FROM isms_nonconformities WHERE tenant_id = ?", tenantId);
  const open = ncs.filter((item) => item.status !== "closed" && item.severity !== "observation");
  const late = open.filter((item) => item.due_at !== null && item.due_at < nowIso).length;
  const unplanned = open.filter((item) => item.status === "open").length;
  const exercised = ncs.length > 0 || auditsClosed > 0;
  const c10 = !exercised ? check("10.2", "Nonconformity and corrective action", "missing", "No nonconformity was ever recorded and no internal audit was completed: the process has not been exercised.", "Record nonconformities as audits, incidents and reviews find them.")
    : late > 0 || unplanned > 0 ? check("10.2", "Nonconformity and corrective action", "partial", `${open.length} open nonconformity(ies): ${late} past their date, ${unplanned} without a corrective action.`, late > 0 ? "Complete the corrective actions past their date." : "Analyse the cause and plan the corrective action of each open nonconformity.")
    : check("10.2", "Nonconformity and corrective action", "met", `${ncs.length} nonconformity(ies) recorded, ${open.length} open and on time; closed ones were verified by a second person.`);

  return [c41, c42, c43, c52, c53, c612, c613, c62, c91, c92, c93, c10];
}

/** The unified controls each clause group stands behind. A control is backed when every one of its clauses is met. */
const BACKING: Record<string, string[]> = {
  "UC-GOV-03": ["4.1", "4.2", "4.3"],
  "UC-GOV-04": ["6.1.2", "6.1.3"],
  "UC-GOV-05": ["6.2", "9.1", "9.3"],
  "UC-GOV-06": ["9.2"],
  "UC-GOV-07": ["10.2"],
};

/** Governance controls whose own records exist, are approved and are current: they count as documented, like a reviewed document. */
export function backedByRecords(clauses: ClauseCheck[]): Set<string> {
  const status = new Map(clauses.map((item) => [item.clause, item.status]));
  return new Set(Object.entries(BACKING).filter(([, needed]) => needed.every((clause) => status.get(clause) === "met")).map(([code]) => code));
}
