import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, riskOwner, isolateDatabase } from "./setup";

isolateDatabase();

const input = { subjectType: "risk", subjectId: "risk_1", outcome: "approved", conditions: ["quarterly review"], rationale: "Residual exposure is within appetite after controls.", evidenceIds: [] as string[] };

test("a recorded decision verifies and is chained into the audit log", async () => {
  const { recordDecision, verifyDecision } = await import("../src/lib/core/decisions");
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  const decision = recordDecision(riskOwner, input);
  assert.equal(verifyDecision(riskOwner.tenantId, decision.id).valid, true);
  assert.equal(verifyAuditChain(riskOwner.tenantId).valid, true);
});

test("tampering with a decision invalidates its signature", async () => {
  const { recordDecision, verifyDecision } = await import("../src/lib/core/decisions");
  const { getDb } = await import("../src/lib/core/database");
  const decision = recordDecision(riskOwner, input);
  getDb().prepare("UPDATE decisions SET outcome = 'rejected' WHERE id = ?").run(decision.id);
  assert.equal(verifyDecision(riskOwner.tenantId, decision.id).valid, false);
});

test("decisions cannot be verified across tenants", async () => {
  const { recordDecision, verifyDecision } = await import("../src/lib/core/decisions");
  const decision = recordDecision(admin, input);
  const result = verifyDecision("tenant_other", decision.id);
  assert.equal(result.valid, false);
  assert.equal((result as { reason?: string }).reason, "not_found");
});

test("decisions reject evidence that does not exist for the tenant", async () => {
  const { recordDecision } = await import("../src/lib/core/decisions");
  assert.throws(() => recordDecision(admin, { ...input, evidenceIds: ["evidence_missing"] }), /missing or belong to another tenant/);
});

test("decisions seal the evidence manifest", async () => {
  const { recordDecision } = await import("../src/lib/core/decisions");
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  const evaluation = evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts: { production: true, branchProtection: { enabled: true, requiredReviews: 2 } }, source: "test" });
  const decision = recordDecision(admin, { ...input, evidenceIds: [evaluation.evidenceId] });
  assert.equal(decision.manifest.count, 1);
  assert.equal(typeof decision.manifest.rootHash, "string");
});
