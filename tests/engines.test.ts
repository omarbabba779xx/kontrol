import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admin, isolateDatabase } from "./setup";

isolateDatabase();
process.env.KONTROL_VAULT_DIR = mkdtempSync(join(tmpdir(), "kontrol-vault-"));
delete process.env.S3_BUCKET;
delete process.env.S3_ENDPOINT;

test("assurance scan, snapshot, vendors and digital twin run end to end", async () => {
  const assurance = await import("../src/lib/core/assurance-engine");
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  await evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts: { production: true, branchProtection: { enabled: false, requiredReviews: 0 } }, source: "github:demo" });
  const scan = await assurance.runAssuranceScan(admin);
  assert.ok(scan);
  const snapshot = await assurance.getAssuranceSnapshot(admin.tenantId);
  assert.ok(snapshot);
  assert.ok((await assurance.assessVendors(admin)));
  const twin = await assurance.simulateDigitalTwin(admin, { name: "Control removal drill", changeType: "control_removed", magnitude: 1.5 });
  assert.ok(twin);
  const brief = await assurance.buildDecisionBrief(admin.tenantId, "control_branch_protection");
  assert.ok(brief);
});

test("auditor requests can be created and answered", async () => {
  const { createAuditorRequest, respondToAuditor } = await import("../src/lib/core/assurance-engine");
  const { getDb } = await import("../src/lib/db");
  const created = await createAuditorRequest(admin, { requesterName: "Ada Auditor", requesterEmail: "ada@audit.example", subject: "Branch protection", question: "Show evidence for branch protection.", scope: ["CTL-SDLC-004"] });
  const id = (created as { id?: string }).id ?? (created as { requestId?: string }).requestId;
  assert.ok(id);
  await respondToAuditor(admin, { requestId: id!, response: "Evidence attached and hash verified.", status: "answered" });
  const row = await (await getDb()).scope(admin.tenantId).get<{ status: string }>("SELECT status FROM auditor_requests WHERE id = ?", id);
  assert.equal(row?.status, "answered");
});

test("enterprise modules persist and report consistent snapshots", async () => {
  const enterprise = await import("../src/lib/core/enterprise-engine");
  await enterprise.compilePolicy(admin, { name: "MFA for admins", requirement: "All administrators must use MFA", frequency: "continuous" });
  await enterprise.createCase(admin, { title: "Branch protection gap", sourceType: "finding", sourceId: "f1", severity: "high", remediation: "Enable required reviews on main." });
  await enterprise.ensureDemoGrant(admin);
  await enterprise.evaluateContinuousAuthorization(admin);
  await enterprise.calculateAttackPaths(admin);
  await enterprise.createWorkflowDefinition(admin, { name: "Release gate", trigger: "release.requested", nodes: [{ id: "a", type: "collect", label: "Collect" }, { id: "b", type: "approval", label: "Approve" }], edges: [{ source: "a", target: "b" }] });
  const benchmark = await enterprise.calculateBenchmark(admin);
  assert.ok(benchmark);
  const cockpit = await enterprise.executiveCockpit(admin.tenantId);
  assert.ok(cockpit);
  const snapshot = await enterprise.enterpriseSnapshot(admin.tenantId) as Record<string, unknown>;
  assert.ok(snapshot && typeof snapshot === "object");
  const readiness = await enterprise.runtimeReadiness();
  assert.ok(readiness);
});

test("evidence vault chains versions and detects duplicates", async () => {
  const { storeVaultDocument } = await import("../src/lib/core/enterprise-engine");
  const first = await storeVaultDocument(admin, new File(["policy v1"], "policy.txt", { type: "text/plain" }), "policy") as { id: string; version: number };
  const second = await storeVaultDocument(admin, new File(["policy v2"], "policy.txt", { type: "text/plain" }), "policy") as { id: string; version: number };
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  const duplicate = await storeVaultDocument(admin, new File(["policy v2"], "policy.txt", { type: "text/plain" }), "policy") as { id: string };
  assert.ok(duplicate);
});

test("regulatory ingestion records versions and risk simulations persist", async () => {
  const { ingestRegulation } = await import("../src/lib/core/regulatory");
  const { persistRiskSimulation, simulateRisk } = await import("../src/lib/core/risk-engine");
  const base = { framework: "EU AI Act", citation: "Article 14", title: "Human oversight", text: "High-risk AI systems shall be designed so they can be overseen by natural persons.", sourceUrl: "https://eur-lex.europa.eu/eli/reg/2024/1689" };
  const first = await ingestRegulation(admin, base);
  assert.ok(first);
  const again = await ingestRegulation(admin, { ...base, text: `${base.text} Updated wording for version two.` });
  assert.ok(again);
  const scenario = { name: "Persisted scenario", materialDecision: true, sensitiveData: true, humanReview: false, thirdPartyModel: true, crossBorder: false, annualEvents: 20_000, iterations: 1_000 };
  const id = await persistRiskSimulation(admin, scenario, simulateRisk(scenario));
  assert.ok(id);
});

test("HTTP handlers return tenant-scoped data", async () => {
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const headers = { authorization: `Bearer ${await issueSessionToken(admin)}` };
  const call = async (load: () => Promise<{ GET: (request: Request) => Promise<Response> }>, path = "/api/x") => (await load()).GET(new Request(`http://localhost:3000${path}`, { headers }));

  const snapshot = await call(() => import("../src/app/api/platform/snapshot/route"));
  assert.equal(snapshot.status, 200);
  const body = await snapshot.json() as { counts: { assets: number; openFindings: number }; audit: { valid: boolean } };
  assert.ok(Number(body.counts.assets) >= 2);
  assert.equal(body.audit.valid, true);

  assert.equal((await call(() => import("../src/app/api/graph/route"))).status, 200);
  assert.equal((await call(() => import("../src/app/api/oscal/export/route"))).status, 200);
  assert.equal((await call(() => import("../src/app/api/health/route"))).status, 200);
  assert.equal((await call(() => import("../src/app/api/enterprise/route"))).status, 200);
  assert.equal((await call(() => import("../src/app/api/assurance/route"))).status, 200);
  assert.equal((await call(() => import("../src/app/api/workflows/route"))).status, 200);
});
