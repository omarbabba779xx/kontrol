import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase } from "./setup";

isolateDatabase();

test("OSCAL export is structurally valid and includes findings and evidence", async () => {
  const { exportOscalAssessmentResults } = await import("../src/lib/core/oscal");
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts: { production: true, branchProtection: { enabled: false, requiredReviews: 0 } }, source: "test" });
  const doc = exportOscalAssessmentResults(admin.tenantId) as { "assessment-results": { uuid: string; metadata: { "oscal-version": string }; results: Array<Record<string, unknown>> } };
  const root = doc["assessment-results"];
  assert.match(root.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(root.metadata["oscal-version"], "1.1.3");
  assert.ok(root.results.length >= 1);
  assert.ok(JSON.stringify(root.results[0]).includes("CTL-SDLC-004"));
});

test("risk exposure grows with riskier scenarios", async () => {
  const { simulateRisk } = await import("../src/lib/core/risk-engine");
  const base = { name: "Base scenario", materialDecision: false, sensitiveData: false, humanReview: true, thirdPartyModel: false, crossBorder: false, annualEvents: 10_000, iterations: 2_000 };
  const risky = { ...base, materialDecision: true, sensitiveData: true, humanReview: false, thirdPartyModel: true, crossBorder: true };
  assert.ok(simulateRisk(risky).annualizedLoss.p90 > simulateRisk(base).annualizedLoss.p90);
});
