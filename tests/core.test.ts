import assert from "node:assert/strict";
import { test } from "node:test";

test("risk simulation is deterministic and ordered", async () => {
  const { simulateRisk } = await import("../src/lib/core/risk-engine");
  const scenario = { name: "Regression", materialDecision: true, sensitiveData: true, humanReview: true, thirdPartyModel: false, crossBorder: true, annualEvents: 50_000, iterations: 1_000 };
  const first = simulateRisk(scenario);
  const second = simulateRisk(scenario);
  assert.deepEqual(first.annualizedLoss, second.annualizedLoss);
  assert.ok(first.annualizedLoss.p50 <= first.annualizedLoss.p90);
  assert.ok(first.annualizedLoss.p90 <= first.annualizedLoss.p95);
});

test("policy engine explains each failed condition", async () => {
  const { evaluatePolicy } = await import("../src/lib/core/policy-engine");
  const result = evaluatePolicy({ all: [{ path: "branch.enabled", op: "eq", value: true }, { path: "branch.reviews", op: "gte", value: 2 }] }, { branch: { enabled: true, reviews: 1 } });
  assert.equal(result.passed, false);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].condition.path, "branch.reviews");
  assert.equal(result.failed[0].actual, 1);
});

test("canonical JSON is stable across key order", async () => {
  const { canonicalJson, sha256 } = await import("../src/lib/core/integrity");
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
  assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256(canonicalJson({ a: 1, b: 2 })));
});

test("evidence trust penalizes demo sources and rewards integrity", async () => {
  const { scoreEvidence } = await import("../src/lib/core/assurance-engine");
  const { sha256 } = await import("../src/lib/core/integrity");
  const content = JSON.stringify({ control: "healthy" });
  const common = { id: "e1", collection_method: "automated connector", content_json: content, content_hash: sha256(content), period_start: "2026-09-01T00:00:00.000Z", period_end: "2026-09-30T00:00:00.000Z", collected_at: new Date().toISOString(), expires_at: null, status: "healthy", control_id: null, asset_id: null };
  const live = scoreEvidence({ ...common, source: "github:api" });
  const demo = scoreEvidence({ ...common, source: "github:demo" });
  assert.ok(live.score > demo.score);
  assert.equal(live.dimensions.integrity, 25);
  assert.ok(demo.issues.includes("demo_source"));
});
