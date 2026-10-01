import assert from "node:assert/strict";
import { test } from "node:test";
import type { AwsClients } from "../src/lib/connectors/collectors";
import { UNIFIED_CONTROLS } from "../src/lib/frameworks/unified";
import { admin, isolateDatabase, riskOwner } from "./setup";

isolateDatabase();

const engine = () => import("../src/lib/core/compliance-engine");
const day = 86_400_000;
const future = (days: number) => new Date(Date.now() + days * day).toISOString();

test("the demo posture loads once, is tagged as sample data and scores adopted frameworks", async () => {
  const { loadDemoPosture, complianceSnapshot } = await engine();
  assert.deepEqual(await loadDemoPosture(admin), { loaded: true });
  assert.deepEqual(await loadDemoPosture(admin), { loaded: false });
  const snapshot = await complianceSnapshot(admin.tenantId);
  assert.equal(snapshot.alerts.demoPosture, true);
  assert.equal(snapshot.adoptions.length, 6);
  assert.equal(snapshot.scores.length, 6);
  assert.ok(snapshot.scores.every((score) => score.score > 0 && score.score < 100));
  assert.ok(snapshot.roadmap.length > 0);
  assert.equal(snapshot.controls.length, UNIFIED_CONTROLS.length);
  assert.ok(snapshot.trend.length >= 6);
});

test("failing live evidence on a linked control is surfaced as a contradiction and lowers the score", async () => {
  const { complianceSnapshot, setImplementation } = await engine();
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  const evaluate = (facts: Record<string, unknown>) => evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts, source: "test" });

  await evaluate({ production: true, branchProtection: { enabled: true, requiredReviews: 2 } });
  const healthy = await complianceSnapshot(admin.tenantId);
  assert.equal(healthy.controls.find((control) => control.code === "UC-SDL-01")?.verification, "verified");
  assert.equal(healthy.alerts.contradictions.length, 0);
  const before = healthy.scores.find((score) => score.frameworkId === "iso27001")!.score;

  await evaluate({ production: true, branchProtection: { enabled: false, requiredReviews: 0 } });
  const failing = await complianceSnapshot(admin.tenantId);
  assert.equal(failing.controls.find((control) => control.code === "UC-SDL-01")?.verification, "failing");
  assert.equal(failing.alerts.contradictions[0]?.code, "UC-SDL-01");
  assert.ok(failing.scores.find((score) => score.frameworkId === "iso27001")!.score < before);

  await assert.rejects(setImplementation(admin, { ucCode: "UC-GOV-01", status: "implemented", maturity: 3, linkedControlCode: "CTL-DOES-NOT-EXIST", notes: "" }), /not found/);
  await assert.rejects(setImplementation(admin, { ucCode: "UC-NOPE-99", status: "implemented", maturity: 3, notes: "" }), /not found/);
});

test("updating an implementation moves the score and records a trend point", async () => {
  const { complianceSnapshot, setImplementation } = await engine();
  const before = await complianceSnapshot(admin.tenantId);
  await setImplementation(admin, { ucCode: "UC-AI-01", status: "implemented", maturity: 4, notes: "AI management system established" });
  const after = await complianceSnapshot(admin.tenantId);
  const pick = (snapshot: typeof before) => snapshot.scores.find((score) => score.frameworkId === "eu_ai_act")!.score;
  assert.ok(pick(after) > pick(before));
  assert.ok(after.trend.length > before.trend.length);
});

test("excluding a requirement needs a justification and shows up escaped in the export", async () => {
  const { setRequirementScope, exportStatement, frameworkDetail } = await engine();
  await assert.rejects(setRequirementScope(admin, { frameworkId: "iso27001", requirementId: "A7.4", applicable: false, justification: "n/a" }), /justification/);
  await assert.rejects(setRequirementScope(admin, { frameworkId: "iso27001", requirementId: "A99.9", applicable: false, justification: "A long enough justification" }), /not found/);
  await setRequirementScope(admin, { frameworkId: "iso27001", requirementId: "A7.4", applicable: false, justification: "=HYPERLINK(\"http://evil\") fully remote company" });
  const detail = await frameworkDetail(admin.tenantId, "iso27001");
  assert.equal(detail.requirements.find((requirement) => requirement.id === "A7.4")?.status, "not_applicable");
  const statement = await exportStatement(admin.tenantId, "iso27001");
  const line = statement.csv.split("\n").find((row) => row.startsWith("A7.4,"))!;
  assert.ok(line.includes("\"'=HYPERLINK") || line.includes("'=HYPERLINK"), "formula must be neutralised");
  assert.equal(statement.csv.split("\n").length, 1 + detail.requirements.length);
  await setRequirementScope(admin, { frameworkId: "iso27001", requirementId: "A7.4", applicable: true });
  assert.notEqual((await frameworkDetail(admin.tenantId, "iso27001")).requirements.find((requirement) => requirement.id === "A7.4")?.status, "not_applicable");
});

test("risk acceptances need a different approver, a bounded lifetime and can be decided only once", async () => {
  const { requestException, decideException, complianceSnapshot } = await engine();
  const input = { ucCode: "UC-OPS-02", title: "Defer kernel patch on legacy host", justification: "Vendor has not certified the patch for this appliance yet.", compensatingControls: "Host is isolated on a dedicated VLAN with IDS.", riskLevel: "medium" as const };
  await assert.rejects(requestException(admin, { ...input, expiresAt: future(-1) }), /future/);
  await assert.rejects(requestException(admin, { ...input, expiresAt: future(400) }), /longer than/);

  const { id } = await requestException(admin, { ...input, expiresAt: future(60) });
  await assert.rejects(decideException(admin, { id, approve: true, note: "I approve my own request" }), /Separation of duties/);
  const results = await Promise.allSettled([
    decideException(riskOwner, { id, approve: true, note: "Compensating controls reviewed." }),
    decideException(riskOwner, { id, approve: false, note: "Competing decision attempt." }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(decideException(riskOwner, { id, approve: true, note: "Replay of an old approval." }), /already been decided/);

  const snapshot = await complianceSnapshot(admin.tenantId);
  assert.equal(snapshot.exceptions.find((row) => row.id === id)?.status === "approved" || snapshot.exceptions.find((row) => row.id === id)?.status === "rejected", true);
});

test("policies keep a content hash and flag overdue reviews", async () => {
  const { upsertPolicy, complianceSnapshot } = await engine();
  const { id } = await upsertPolicy(admin, { title: "Cryptography Standard", version: "1.0", status: "approved", nextReview: future(-5), ucCodes: ["UC-DAT-03"], content: "Use AES-256-GCM and TLS 1.2+." });
  const policy = (await complianceSnapshot(admin.tenantId)).policies.find((row) => row.id === id)!;
  assert.equal(policy.document_hash?.length, 64);
  assert.equal(policy.overdue, true);
  await assert.rejects(upsertPolicy(admin, { title: "Bad", version: "1", status: "draft", ucCodes: ["UC-XXX-99"] }), /not found/);
});

test("every compliance write is chained in the tamper-evident audit log", async () => {
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  const { getDb } = await import("../src/lib/db");
  const verdict = await verifyAuditChain(admin.tenantId);
  assert.equal(verdict.valid, true);
  const actions = await (await getDb()).scope(admin.tenantId).all<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE tenant_id = ? AND action LIKE 'compliance.%'", admin.tenantId);
  const names = new Set(actions.map((row) => row.action));
  for (const expected of ["compliance.demo_posture_loaded", "compliance.implementation_updated", "compliance.requirement_excluded", "compliance.exception_requested", "compliance.policy_saved"]) assert.ok(names.has(expected), `missing ${expected}`);
});

test("compliance data is isolated per tenant", async () => {
  const { getDb } = await import("../src/lib/db");
  const system = (await getDb()).system();
  await system.run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", "tenant_other", "Other Corp", "EU", new Date().toISOString());
  const { complianceSnapshot } = await engine();
  const other = await complianceSnapshot("tenant_other");
  assert.equal(other.adoptions.length, 0);
  assert.equal(other.exceptions.length, 0);
  assert.equal(other.policies.length, 0);
  assert.equal(other.overall.score, 0);
});

test("crosswalk links can be validated, rejected and added per tenant, with full traceability", async () => {
  const { reviewMapping, frameworkDetail, complianceSnapshot } = await engine();
  const base = { frameworkId: "iso27001" as const, requirementId: "A8.15", ucCode: "UC-OPS-05" };

  const before = await frameworkDetail(admin.tenantId, "iso27001");
  const requirement = (detail: typeof before) => detail.requirements.find((item) => item.id === "A8.15")!;
  assert.equal(requirement(before).links.find((link) => link.ucCode === "UC-OPS-05")?.basis, "editorial");

  await assert.rejects(reviewMapping(admin, { ...base, decision: "validated" }), /note/);
  await assert.rejects(reviewMapping(admin, { ...base, ucCode: "UC-GOV-01", decision: "validated", note: "Not part of the crosswalk" }), /built-in/);
  await assert.rejects(reviewMapping(admin, { ...base, decision: "added", note: "Already exists in the crosswalk" }), /already exists/);

  await reviewMapping(riskOwner, { ...base, decision: "validated", note: "Reviewed against ISO 27002 guidance." });
  const validated = requirement(await frameworkDetail(admin.tenantId, "iso27001")).links.find((link) => link.ucCode === "UC-OPS-05")!;
  assert.equal(validated.review, "validated");
  assert.equal(validated.reviewer, riskOwner.userId);

  // A rejected link stops counting toward the requirement.
  await reviewMapping(riskOwner, { ...base, decision: "rejected", note: "Logging is covered by a different control here." });
  const rejected = requirement(await frameworkDetail(admin.tenantId, "iso27001"));
  assert.ok(!rejected.controls.includes("UC-OPS-05"));
  // ...and no longer advances that requirement in the control library.
  const snapshot = await complianceSnapshot(admin.tenantId);
  const stats = snapshot.mapping.find((item) => item.frameworkId === "iso27001")!;
  assert.equal(stats.rejected, 1);

  // A tenant can add its own link, and remove it again.
  await reviewMapping(riskOwner, { frameworkId: "iso27001", requirementId: "A8.15", ucCode: "UC-GOV-05", decision: "added", note: "Log review is part of our management review." });
  assert.ok(requirement(await frameworkDetail(admin.tenantId, "iso27001")).controls.includes("UC-GOV-05"));
  await reviewMapping(riskOwner, { frameworkId: "iso27001", requirementId: "A8.15", ucCode: "UC-GOV-05", decision: "reset" });
  await reviewMapping(riskOwner, { ...base, decision: "reset" });
  const restored = requirement(await frameworkDetail(admin.tenantId, "iso27001"));
  assert.ok(restored.controls.includes("UC-OPS-05"));
  assert.ok(!restored.controls.includes("UC-GOV-05"));
});

test("purging the sample posture removes only sample data and leaves real work intact", async () => {
  const { purgeDemoPosture, complianceSnapshot, setImplementation, upsertPolicy, adoptFramework, loadDemoPosture } = await engine();
  // Real work done alongside the sample posture.
  await setImplementation(admin, { ucCode: "UC-GOV-01", status: "implemented", maturity: 4, notes: "Real attestation by the CISO" });
  const real = await upsertPolicy(admin, { title: "Real Policy", version: "1.0", status: "approved", ucCodes: ["UC-GOV-01"] });
  await adoptFramework(admin, { frameworkId: "iso27001", scope: "Real scope, whole organisation" });

  const result = await purgeDemoPosture(admin);
  assert.ok(result.purged.controls > 40);
  assert.equal(result.purged.exceptions, 1);

  const after = await complianceSnapshot(admin.tenantId);
  assert.equal(after.alerts.demoPosture, false);
  assert.equal(after.controls.filter((control) => control.source === "demo").length, 0);
  assert.deepEqual(after.controls.filter((control) => control.source === "attested").map((control) => control.code).sort(), ["UC-AI-01", "UC-GOV-01"]);
  assert.equal(after.controls.find((control) => control.code === "UC-GOV-01")?.status, "implemented");
  assert.ok(after.policies.some((policy) => policy.id === real.id));
  assert.equal(after.policies.some((policy) => policy.title === "AI Governance Policy"), false);
  assert.deepEqual(after.adoptions.map((item) => item.frameworkId), ["iso27001"]);
  assert.equal(after.adoptions[0].scope, "Real scope, whole organisation");

  // Sample data cannot be loaded back on top of real data.
  assert.deepEqual(await loadDemoPosture(admin), { loaded: false });
});

test("evidence links aggregate several executable controls: one failing control fails the unified control", async () => {
  const { linkEvidence, complianceSnapshot, linkedCodes } = await engine();
  const { syncAws, syncOkta } = await import("../src/lib/connectors");
  assert.deepEqual(linkedCodes(" CTL-A, CTL-B ,,CTL-A"), ["CTL-A", "CTL-B"]);

  // Nothing to link until the executable controls exist in the tenant.
  assert.deepEqual((await linkEvidence(admin)).linked.map((item) => item.ucCode).includes("UC-OPS-05"), false);

  const healthyAws = { send: async (command: { constructor: { name: string } }) => ({
    GetAccountSummaryCommand: { SummaryMap: { AccountMFAEnabled: 1, AccountAccessKeysPresent: 0 } },
    GetAccountPasswordPolicyCommand: { PasswordPolicy: { MinimumPasswordLength: 14, PasswordReusePrevention: 24 } },
    ListBucketsCommand: { Buckets: [] },
    GetComplianceSummaryByConfigRuleCommand: { ComplianceSummary: { CompliantResourceCount: { CappedCount: 1 }, NonCompliantResourceCount: { CappedCount: 0 } } },
    DescribeTrailsCommand: { trailList: [{ Name: "t", TrailARN: "arn:t", IsMultiRegionTrail: true, LogFileValidationEnabled: true }] },
    GetTrailStatusCommand: { IsLogging: true },
  } as Record<string, unknown>)[command.constructor.name] };
  const clients = { iam: healthyAws, s3: healthyAws, config: healthyAws, cloudtrail: healthyAws } as unknown as AwsClients;
  await syncAws(admin, "eu-west-1", clients);
  await syncOkta(admin); // demo facts: one administrator lacks MFA, so CTL-OKTA-001 fails

  const result = await linkEvidence(admin);
  assert.ok(result.linked.some((item) => item.ucCode === "UC-IAM-02" && item.controls.includes("CTL-AWS-001") && item.controls.includes("CTL-OKTA-001")));
  assert.deepEqual((await linkEvidence(admin)).linked, [], "linking is idempotent");

  const snapshot = await complianceSnapshot(admin.tenantId);
  const byCode = (code: string) => snapshot.controls.find((control) => control.code === code)!;
  assert.equal(byCode("UC-OPS-05").verification, "verified", "CloudTrail control passes");
  assert.equal(byCode("UC-IAM-02").verification, "failing", "Okta administrator MFA fails");
  assert.equal(byCode("UC-IAM-02").status, "not_started", "linking evidence never changes the attested status");
  assert.ok(byCode("UC-IAM-02").linkedControlCode?.includes(","));
});
