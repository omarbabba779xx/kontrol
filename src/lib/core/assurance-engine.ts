import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/core/database";
import { appendAudit, sha256 } from "@/lib/core/integrity";

type EvidenceRow = { id: string; source: string; collection_method: string; content_json: string; content_hash: string; period_start: string | null; period_end: string | null; collected_at: string; expires_at: string | null; status: string; control_id: string | null; asset_id: string | null };

function ageDays(value: string) { return Math.max(0, (Date.now() - new Date(value).getTime()) / 86_400_000); }
function grade(score: number) { return score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "E"; }

export function scoreEvidence(row: EvidenceRow) {
  const age = ageDays(row.collected_at);
  const integrity = sha256(row.content_json) === row.content_hash ? 25 : 0;
  const freshness = Math.max(0, Math.round(25 - age * 1.5));
  const provenance = row.source.includes(":demo") ? 8 : row.source.includes(":api") ? 20 : 14;
  const automation = row.collection_method.includes("automated") ? 15 : 9;
  const coverage = row.period_start && row.period_end ? 15 : 8;
  const score = Math.min(100, integrity + freshness + provenance + automation + coverage);
  const issues = [
    ...(integrity === 0 ? ["content_hash_mismatch"] : []),
    ...(freshness < 15 ? ["stale_evidence"] : []),
    ...(row.source.includes(":demo") ? ["demo_source"] : []),
    ...(!row.period_start || !row.period_end ? ["missing_period_coverage"] : []),
    ...(row.status === "failed" ? ["control_test_failed"] : []),
  ];
  return { score, grade: grade(score), dimensions: { integrity, freshness, provenance, automation, coverage }, issues };
}

function upsertDrift(actor: Actor, item: { fingerprint: string; kind: string; subjectType: string; subjectId: string; severity: string; title: string; details: unknown }) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM drift_events WHERE tenant_id = ? AND fingerprint = ?").get(actor.tenantId, item.fingerprint) as { id: string } | undefined;
  const now = new Date().toISOString();
  if (existing) db.prepare("UPDATE drift_events SET severity=?,title=?,details_json=?,status='open',detected_at=? WHERE id=?").run(item.severity, item.title, JSON.stringify(item.details), now, existing.id);
  else db.prepare("INSERT INTO drift_events (id,tenant_id,fingerprint,kind,subject_type,subject_id,severity,title,details_json,status,detected_at) VALUES (?,?,?,?,?,?,?,?,?,'open',?)").run(`drift_${randomUUID()}`, actor.tenantId, item.fingerprint, item.kind, item.subjectType, item.subjectId, item.severity, item.title, JSON.stringify(item.details), now);
}

function upsertContradiction(actor: Actor, item: { fingerprint: string; left: string; right: string; severity: string; statement: string; explanation: string }) {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM contradictions WHERE tenant_id=? AND fingerprint=?").get(actor.tenantId, item.fingerprint) as { id: string } | undefined;
  if (existing) db.prepare("UPDATE contradictions SET severity=?,statement=?,explanation=?,status='open',detected_at=? WHERE id=?").run(item.severity, item.statement, item.explanation, new Date().toISOString(), existing.id);
  else db.prepare("INSERT INTO contradictions (id,tenant_id,fingerprint,left_ref,right_ref,severity,statement,explanation,status,detected_at) VALUES (?,?,?,?,?,?,?,?,'open',?)").run(`contradiction_${randomUUID()}`, actor.tenantId, item.fingerprint, item.left, item.right, item.severity, item.statement, item.explanation, new Date().toISOString());
}

export function runAssuranceScan(actor: Actor) {
  const db = getDb();
  const evidence = db.prepare("SELECT * FROM evidence WHERE tenant_id=?").all(actor.tenantId) as EvidenceRow[];
  const scoreStatement = db.prepare("INSERT INTO evidence_scores (evidence_id,tenant_id,score,grade,dimensions_json,issues_json,calculated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(evidence_id) DO UPDATE SET score=excluded.score,grade=excluded.grade,dimensions_json=excluded.dimensions_json,issues_json=excluded.issues_json,calculated_at=excluded.calculated_at");
  const scored = evidence.map((row) => {
    const result = scoreEvidence(row);
    scoreStatement.run(row.id, actor.tenantId, result.score, result.grade, JSON.stringify(result.dimensions), JSON.stringify(result.issues), new Date().toISOString());
    if (result.score < 60) upsertDrift(actor, { fingerprint: `evidence-trust:${row.id}`, kind: "evidence_trust", subjectType: "evidence", subjectId: row.id, severity: result.score < 40 ? "critical" : "high", title: `Evidence trust degraded to ${result.grade}`, details: result });
    if (row.expires_at && new Date(row.expires_at) < new Date()) upsertDrift(actor, { fingerprint: `evidence-expired:${row.id}`, kind: "evidence_expiry", subjectType: "evidence", subjectId: row.id, severity: "high", title: "Evidence has expired", details: { expiresAt: row.expires_at } });
    if (row.status === "failed") upsertDrift(actor, { fingerprint: `control-failed:${row.control_id}:${row.asset_id}`, kind: "control_failure", subjectType: "control", subjectId: row.control_id ?? row.id, severity: "high", title: "Control state differs from expected policy", details: { evidenceId: row.id, assetId: row.asset_id } });
    return { id: row.id, ...result };
  });

  const connectors = db.prepare("SELECT * FROM connectors WHERE tenant_id=?").all(actor.tenantId) as Array<{ id: string; kind: string; last_sync_at: string | null }>;
  for (const connector of connectors) if (!connector.last_sync_at || ageDays(connector.last_sync_at) > 1) upsertDrift(actor, { fingerprint: `connector-stale:${connector.id}`, kind: "connector_stale", subjectType: "connector", subjectId: connector.id, severity: "medium", title: `${connector.kind.toUpperCase()} evidence collection is stale`, details: { lastSyncAt: connector.last_sync_at } });

  const failedEffective = db.prepare("SELECT c.id,c.code,e.id AS evidence_id FROM controls c JOIN evidence e ON e.control_id=c.id WHERE c.tenant_id=? AND c.status='effective' AND e.status='failed' GROUP BY c.id").all(actor.tenantId) as Array<{ id: string; code: string; evidence_id: string }>;
  for (const item of failedEffective) upsertContradiction(actor, { fingerprint: `effective-failed:${item.id}`, left: `control:${item.id}`, right: `evidence:${item.evidence_id}`, severity: "high", statement: `${item.code} is declared effective while its evidence fails`, explanation: "The control status and the latest machine test cannot both be true. A control owner must review and attest the state." });
  const vendors = db.prepare("SELECT * FROM vendors WHERE tenant_id=? AND tier='critical' AND exit_tested=0").all(actor.tenantId) as Array<{ id: string; name: string }>;
  for (const vendor of vendors) upsertContradiction(actor, { fingerprint: `critical-no-exit:${vendor.id}`, left: `vendor:${vendor.id}`, right: "policy:operational-resilience", severity: "high", statement: `${vendor.name} is critical but has no tested exit plan`, explanation: "Critical dependency designation requires credible substitutability and a tested exit path." });
  const failedModels = db.prepare("SELECT m.id,m.name,m.status,e.id AS evaluation_id FROM ai_models m JOIN model_evaluations e ON e.model_id=m.id WHERE m.tenant_id=? AND m.status IN ('approved','conditional') AND e.passed=0").all(actor.tenantId) as Array<{ id: string; name: string; status: string; evaluation_id: string }>;
  for (const model of failedModels) upsertContradiction(actor, { fingerprint: `model-evaluation:${model.id}`, left: `model:${model.id}`, right: `evaluation:${model.evaluation_id}`, severity: model.status === "approved" ? "critical" : "high", statement: `${model.name} is ${model.status} while a required evaluation fails`, explanation: "The deployment approval state conflicts with the latest evaluation result. Release must remain gated until an accountable reviewer resolves the exception." });

  const audit = appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "assurance.scan_completed", objectType: "portfolio", objectId: actor.tenantId, payload: { evidenceScored: scored.length } });
  return { evidenceScored: scored.length, averageTrust: scored.length ? Math.round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length) : 0, audit };
}

export function simulateDigitalTwin(actor: Actor, input: { name: string; changeType: "new_vendor" | "ai_release" | "regulatory_change" | "control_removed" | "cloud_incident" | "country_expansion"; magnitude: number; subjectId?: string }) {
  const db = getDb();
  const multipliers = { new_vendor: 1.18, ai_release: 1.34, regulatory_change: 1.12, control_removed: 1.58, cloud_incident: 1.9, country_expansion: 1.27 };
  const base = (db.prepare("SELECT COALESCE(SUM(p90_loss),0) AS value FROM risks WHERE tenant_id=? AND valid_to IS NULL").get(actor.tenantId) as { value: number }).value || 1_200_000;
  const edges = db.prepare("SELECT * FROM graph_edges WHERE tenant_id=? AND valid_to IS NULL AND (? IS NULL OR source_id=? OR target_id=?) LIMIT 50").all(actor.tenantId, input.subjectId ?? null, input.subjectId ?? null, input.subjectId ?? null) as unknown[];
  const factor = multipliers[input.changeType] * Math.max(.25, input.magnitude);
  const projected = Math.round(base * factor);
  const result = { baselineP90: base, projectedP90: projected, delta: projected - base, currency: "EUR", impactedRelations: edges.length, controlsToReview: Math.max(2, Math.round(4 * factor)), estimatedRemediationDays: Math.round(12 * factor), recommendation: factor > 1.5 ? "block_pending_controls" : factor > 1.2 ? "conditional_approval" : "proceed_with_monitoring" };
  const id = `twin_${randomUUID()}`;
  db.prepare("INSERT INTO twin_scenarios (id,tenant_id,name,change_type,input_json,result_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, actor.tenantId, input.name, input.changeType, JSON.stringify(input), JSON.stringify(result), actor.userId, new Date().toISOString());
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "digital_twin.simulated", objectType: "twin_scenario", objectId: id, payload: { input, result } });
  return { id, ...result };
}

export function assessVendors(actor: Actor) {
  const db = getDb();
  const vendors = db.prepare("SELECT * FROM vendors WHERE tenant_id=?").all(actor.tenantId) as Array<{ id: string; tier: string; score: number; subprocessors_json: string; exit_tested: number }>;
  const allSubprocessors = vendors.flatMap((vendor) => JSON.parse(vendor.subprocessors_json) as string[]);
  const assessedAt = new Date().toISOString();
  return vendors.map((vendor) => {
    const subs = JSON.parse(vendor.subprocessors_json) as string[];
    const overlap = subs.filter((sub) => allSubprocessors.filter((value) => value === sub).length > 1).length;
    const inherent = vendor.tier === "critical" ? 88 : vendor.tier === "high" ? 72 : 48;
    const concentration = Math.min(100, 35 + overlap * 20 + subs.length * 4);
    const exit = vendor.exit_tested ? 90 : 28;
    const residual = Math.round(Math.min(100, inherent * .5 + (100 - vendor.score) * .3 + concentration * .2 - exit * .15));
    const findings = [...(!vendor.exit_tested ? ["Exit plan has not been tested"] : []), ...(overlap ? ["Shared fourth-party concentration detected"] : [])];
    db.prepare("INSERT INTO vendor_assessments (id,tenant_id,vendor_id,inherent_risk,residual_risk,concentration_score,exit_readiness,findings_json,assessed_at) VALUES (?,?,?,?,?,?,?,?,?)").run(`va_${randomUUID()}`, actor.tenantId, vendor.id, inherent, residual, concentration, exit, JSON.stringify(findings), assessedAt);
    return { vendorId: vendor.id, inherent, residual, concentration, exit, findings };
  });
}

export function createAuditorRequest(actor: Actor, input: { requesterName: string; requesterEmail: string; subject: string; question: string; scope: string[]; dueAt?: string }) {
  const id = `audit_request_${randomUUID()}`;
  getDb().prepare("INSERT INTO auditor_requests (id,tenant_id,requester_name,requester_email,subject,question,scope_json,status,due_at,created_at) VALUES (?,?,?,?,?,?,?,'open',?,?)").run(id, actor.tenantId, input.requesterName, input.requesterEmail, input.subject, input.question, JSON.stringify(input.scope), input.dueAt ?? null, new Date().toISOString());
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "auditor.request_created", objectType: "auditor_request", objectId: id, payload: input });
  return { id, status: "open" };
}

export function respondToAuditor(actor: Actor, input: { requestId: string; response: string; status: "answered" | "rejected" }) {
  const db = getDb();
  const request = db.prepare("SELECT id FROM auditor_requests WHERE tenant_id=? AND id=?").get(actor.tenantId, input.requestId);
  if (!request) throw new Error("Auditor request not found");
  db.prepare("UPDATE auditor_requests SET response=?,status=?,responded_at=? WHERE id=?").run(input.response, input.status, new Date().toISOString(), input.requestId);
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: `auditor.request_${input.status}`, objectType: "auditor_request", objectId: input.requestId, payload: { response: input.response } });
  return { id: input.requestId, status: input.status };
}

export function buildDecisionBrief(tenantId: string, subjectId: string) {
  const db = getDb();
  const edges = db.prepare("SELECT * FROM graph_edges WHERE tenant_id=? AND valid_to IS NULL AND (source_id=? OR target_id=?)").all(tenantId, subjectId, subjectId) as Array<{ source_id: string; target_id: string }>;
  const related = [...new Set(edges.flatMap((edge) => [edge.source_id, edge.target_id]))];
  const placeholders = related.map(() => "?").join(",") || "''";
  const controls = db.prepare(`SELECT id,code,title,status FROM controls WHERE tenant_id=? AND id IN (${placeholders})`).all(tenantId, ...related);
  const evidence = db.prepare(`SELECT e.id,e.name,e.status,e.content_hash,s.score,s.grade FROM evidence e LEFT JOIN evidence_scores s ON s.evidence_id=e.id WHERE e.tenant_id=? AND (e.asset_id=? OR e.control_id IN (${placeholders})) ORDER BY e.collected_at DESC`).all(tenantId, subjectId, ...related);
  const findings = db.prepare("SELECT id,title,severity,status FROM findings WHERE tenant_id=? AND (asset_id=? OR control_id IN (SELECT id FROM controls WHERE tenant_id=?)) AND status!='closed'").all(tenantId, subjectId, tenantId);
  const contradictions = db.prepare("SELECT id,severity,statement FROM contradictions WHERE tenant_id=? AND status='open' AND (left_ref LIKE ? OR right_ref LIKE ?)").all(tenantId, `%${subjectId}%`, `%${subjectId}%`);
  const highSignals = (findings as Array<{ severity: string }>).filter((item) => ["high", "critical"].includes(item.severity)).length + (contradictions as Array<{ severity: string }>).filter((item) => ["high", "critical"].includes(item.severity)).length;
  return { subjectId, generatedAt: new Date().toISOString(), controls, evidence, findings, contradictions, recommendation: highSignals ? "conditional_or_block" : "proceed_with_monitoring", conditions: highSignals ? ["Resolve high-severity findings", "Obtain accountable human approval", "Refresh weak or stale evidence"] : ["Continue continuous monitoring"], highSignals };
}

export function getAssuranceSnapshot(tenantId: string) {
  const db = getDb();
  const query = (sql: string) => db.prepare(sql).all(tenantId);
  return {
    evidence: query("SELECT e.id,e.name,e.source,e.status,e.collected_at,e.content_hash,s.score,s.grade,s.dimensions_json,s.issues_json FROM evidence e LEFT JOIN evidence_scores s ON s.evidence_id=e.id WHERE e.tenant_id=? ORDER BY e.collected_at DESC"),
    drift: query("SELECT * FROM drift_events WHERE tenant_id=? AND status='open' ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,detected_at DESC"),
    contradictions: query("SELECT * FROM contradictions WHERE tenant_id=? AND status='open' ORDER BY detected_at DESC"),
    vendors: query("SELECT v.*,a.residual_risk,a.concentration_score,a.exit_readiness,a.findings_json,a.assessed_at AS assessment_at FROM vendors v LEFT JOIN vendor_assessments a ON a.id=(SELECT id FROM vendor_assessments WHERE tenant_id=v.tenant_id AND vendor_id=v.id ORDER BY assessed_at DESC LIMIT 1) WHERE v.tenant_id=?"),
    auditorRequests: query("SELECT * FROM auditor_requests WHERE tenant_id=? ORDER BY created_at DESC"),
    twins: query("SELECT * FROM twin_scenarios WHERE tenant_id=? ORDER BY created_at DESC LIMIT 10"),
    controls: query("SELECT c.*, (SELECT status FROM evidence WHERE tenant_id=c.tenant_id AND control_id=c.id ORDER BY collected_at DESC LIMIT 1) AS evidence_status FROM controls c WHERE c.tenant_id=? AND c.valid_to IS NULL"),
    risks: query("SELECT * FROM risks WHERE tenant_id=? AND valid_to IS NULL ORDER BY p90_loss DESC"),
    models: query("SELECT m.*,e.passed AS latest_evaluation_passed,e.evaluated_at FROM ai_models m LEFT JOIN model_evaluations e ON e.id=(SELECT id FROM model_evaluations WHERE model_id=m.id ORDER BY evaluated_at DESC LIMIT 1) WHERE m.tenant_id=?"),
    decisions: query("SELECT id,subject_type,subject_id,outcome,rationale,decided_by,decided_at,signature FROM decisions WHERE tenant_id=? ORDER BY decided_at DESC"),
  };
}
