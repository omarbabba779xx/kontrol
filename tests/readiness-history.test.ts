import assert from "node:assert/strict";
import { test } from "node:test";
import { UNIFIED_CONTROLS } from "../src/lib/frameworks/unified";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const engine = () => import("../src/lib/core/compliance-engine");
const db = async () => (await import("../src/lib/db")).getDb();
const DAY = 86_400_000;

async function attestEverything() {
  const { setImplementation } = await engine();
  for (const control of UNIFIED_CONTROLS) await setImplementation(admin, { ucCode: control.code, status: "implemented", maturity: 3, notes: "Attested by the control owner" });
}
async function acceptDocuments(codes: string[]) {
  const sys = (await db()).system();
  for (const code of codes) await sys.run("INSERT INTO control_evidence (id,tenant_id,uc_code,title,kind,vault_document_id,content_hash,valid_until,uploaded_by,uploaded_at,status,reviewed_by,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", `ev_${code}`, admin.tenantId, code, `Evidence for ${code}`, "document", null, "a".repeat(64), new Date(Date.now() + 200 * DAY).toISOString(), "usr_maya", new Date().toISOString(), "accepted", admin.userId, new Date().toISOString());
}
const scoreOf = async (framework = "iso27001") => (await (await engine()).complianceSnapshot(admin.tenantId)).scores.find((item) => item.frameworkId === framework)!;

test("everything attested but nothing backed scores high yet is not audit ready, and the snapshot says why", async () => {
  const { adoptFramework, complianceSnapshot } = await engine();
  await adoptFramework(admin, { frameworkId: "iso27001", scope: "Whole organisation" });
  await attestEverything();
  const score = await scoreOf();
  assert.equal(score.score, 100);
  assert.equal(score.declaredBand, "Strong");
  assert.equal(score.readinessLevel, "in_progress");
  assert.equal(score.readiness, "In progress");
  assert.equal(score.assessment.dimensions.backed, 0);
  assert.equal(score.assessment.dimensions.documentary, 0);
  assert.match(score.assessment.nextSteps.join(" "), /only attested/);
  const snapshot = await complianceSnapshot(admin.tenantId);
  assert.equal(snapshot.overall.readiness, "In progress");
});

test("reviewed documents lift readiness; an open high finding takes it away again, with the blocker named", async () => {
  const sys = (await db()).system();
  const codes = UNIFIED_CONTROLS.map((control) => control.code);
  await acceptDocuments(codes);
  const backed = await scoreOf();
  assert.equal(backed.assessment.dimensions.documentary, 100);
  assert.equal(backed.assessment.dimensions.technical, 0, "documents are not reported as machine verification");
  assert.equal(backed.readinessLevel, "audit_ready");
  assert.deepEqual(backed.assessment.blockers, []);

  await sys.run("INSERT INTO controls (id,tenant_id,code,title,objective,automation,frequency,policy_json,status,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "control_x", admin.tenantId, "CTL-X-1", "Test control", "Objective", "automated", "daily", "{}", "unverified", new Date().toISOString(), new Date().toISOString());
  await sys.run("INSERT INTO findings (id,tenant_id,control_id,asset_id,evidence_id,title,severity,status,reason,remediation,owner_id,due_at,opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", "finding_x", admin.tenantId, "control_x", null, null, "Branch protection failed", "high", "open", "[]", "Fix it", admin.userId, null, new Date().toISOString());
  const blocked = await scoreOf();
  assert.equal(blocked.readinessLevel, "in_progress");
  assert.match(blocked.assessment.blockers.join(" "), /high or critical findings: 1/);
  assert.equal(blocked.score, 100, "the declared score did not move: only readiness did");

  await sys.run("UPDATE findings SET status = 'closed' WHERE id = 'finding_x'");
  assert.equal((await scoreOf()).readinessLevel, "audit_ready");
});

test("an attestation past its review date without backing blocks readiness", async () => {
  const sys = (await db()).system();
  await sys.run("DELETE FROM control_evidence WHERE uc_code = 'UC-GOV-01'");
  await sys.run("UPDATE control_implementations SET review_due = ? WHERE uc_code = 'UC-GOV-01'", new Date(Date.now() - DAY).toISOString());
  const result = await scoreOf();
  assert.equal(result.readinessLevel, "in_progress");
  assert.match(result.assessment.blockers.join(" "), /past their review date without other backing: 1/);
  assert.ok(result.assessment.criteria.some((item) => item.id === "expired_attestations" && !item.met));
});

test("the history keeps the level at each point and the controls that changed between points", async () => {
  const { recordComplianceSnapshot, setImplementation } = await engine();
  await recordComplianceSnapshot(admin);
  await setImplementation(admin, { ucCode: "UC-GOV-02", status: "partial", maturity: 2, notes: "Downgraded after review" });
  const snapshot = await recordComplianceSnapshot(admin);
  const points = snapshot.trend.filter((point) => point.framework_id === "iso27001");
  assert.ok(points.length >= 3);
  assert.ok(points.every((point) => point.readiness), "every point records the level it had");
  const latest = points[0];
  assert.ok(latest.changes, "the latest point explains itself");
  assert.equal(latest.changes?.levelTo, latest.readiness);
  // The change was recorded at the moment it was made, by the point that followed it.
  const moved = points.flatMap((point) => point.changes?.controls ?? []).find((item) => item.code === "UC-GOV-02" && item.to.startsWith("partial|"));
  assert.ok(moved && moved.from.startsWith("implemented|"), "the control that moved is named with its before and after");
  assert.ok(points.some((point) => point.changes?.levelFrom && point.changes.levelFrom !== point.changes.levelTo), "a change of level is recorded with both levels");
});

test("overall readiness is the weakest framework's, not an average", async () => {
  const { adoptFramework, complianceSnapshot } = await engine();
  await adoptFramework(admin, { frameworkId: "nis2", scope: "Essential services" });
  const snapshot = await complianceSnapshot(admin.tenantId);
  const levels = snapshot.scores.map((item) => item.readinessLevel);
  assert.equal(snapshot.scores.length, 2);
  const order = ["not_ready", "in_progress", "ready_with_reservations", "audit_ready"];
  const weakest = levels.reduce((a, b) => (order.indexOf(a) <= order.indexOf(b) ? a : b));
  const labels: Record<string, string> = { not_ready: "Not ready", in_progress: "In progress", ready_with_reservations: "Ready with reservations", audit_ready: "Audit ready" };
  assert.equal(snapshot.overall.readiness, labels[weakest]);
});

test("the effect of scope exclusions on the score is stated, not hidden", async () => {
  const { setRequirementScope } = await engine();
  const before = await scoreOf();
  assert.equal(before.assessment.scope.exclusionEffect, 0, "no exclusion, no effect");
  assert.equal(before.assessment.scope.scoreWithoutExclusions, before.score);

  // Make one control weak, then exclude every requirement it advances: the score improves only because the scope shrank.
  const { setImplementation } = await engine();
  await setImplementation(admin, { ucCode: "UC-HR-01", status: "not_started", maturity: 0, notes: "Not done yet" });
  const weak = await scoreOf();
  const detail = await (await engine()).frameworkDetail(admin.tenantId, "iso27001");
  const linked = detail.requirements.filter((requirement) => requirement.controls.length === 1 && requirement.controls[0] === "UC-HR-01").slice(0, 3);
  assert.ok(linked.length > 0, "some requirements depend only on UC-HR-01");
  for (const requirement of linked) await setRequirementScope(admin, { frameworkId: "iso27001", requirementId: requirement.id, applicable: false, justification: "Outside the scope of the certificate" });
  const after = await scoreOf();
  assert.equal(after.assessment.scope.excluded, linked.length);
  assert.ok(after.score > weak.score, "excluding the weak requirements raises the declared score");
  assert.equal(after.assessment.scope.scoreWithoutExclusions, weak.score);
  assert.equal(after.assessment.scope.exclusionEffect, Math.round((after.score - weak.score) * 10) / 10);
  assert.ok(after.assessment.scope.exclusionEffect > 0);
});
