import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase } from "./setup";

isolateDatabase();

const failing = { production: true, branchProtection: { enabled: false, requiredReviews: 0 } };
const passing = { production: true, branchProtection: { enabled: true, requiredReviews: 2 } };
const run = async (facts: Record<string, unknown>) => {
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  return evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts, source: "test" });
};
const openFindings = async () => {
  const { getDb } = await import("../src/lib/core/database");
  return (getDb().prepare("SELECT COUNT(*) AS n FROM findings WHERE control_id = 'control_branch_protection' AND status = 'open'").get() as { n: number }).n;
};

test("a failing control opens exactly one finding and re-evaluation updates it", async () => {
  const first = await run(failing);
  const second = await run(failing);
  assert.equal(first.passed, false);
  assert.equal(first.finding, second.finding);
  assert.equal(await openFindings(), 1);
});

test("a passing evaluation closes the open finding", async () => {
  await run(failing);
  const result = await run(passing);
  assert.equal(result.passed, true);
  assert.equal(await openFindings(), 0);
});

test("evidence is stored with a hash that matches its content", async () => {
  const { getDb } = await import("../src/lib/core/database");
  const { sha256 } = await import("../src/lib/core/integrity");
  const result = await run(passing);
  const row = getDb().prepare("SELECT content_json, content_hash FROM evidence WHERE id = ?").get(result.evidenceId) as { content_json: string; content_hash: string };
  assert.equal(sha256(row.content_json), row.content_hash);
});

test("unknown controls and assets are rejected", async () => {
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  assert.throws(() => evaluateControl(admin, { controlCode: "CTL-NOPE", assetId: "asset_repo_lending", facts: {}, source: "t" }), /not found/);
  assert.throws(() => evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_nope", facts: {}, source: "t" }), /not found/);
});

test("controls are tenant scoped", async () => {
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  assert.throws(() => evaluateControl({ ...admin, tenantId: "tenant_other" }, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts: passing, source: "t" }), /not found/);
});

test("policy operators behave as documented", async () => {
  const { evaluatePolicy } = await import("../src/lib/core/policy-engine");
  const facts = { a: 5, tags: ["x", "y"], name: "kontrol" };
  assert.equal(evaluatePolicy({ all: [{ path: "a", op: "gte", value: 5 }, { path: "a", op: "lte", value: 5 }] }, facts).passed, true);
  assert.equal(evaluatePolicy({ all: [{ path: "tags", op: "includes", value: "x" }, { path: "name", op: "includes", value: "tro" }] }, facts).passed, true);
  assert.equal(evaluatePolicy({ all: [{ path: "nested.value", op: "exists" }] }, facts).passed, false);
  assert.equal(evaluatePolicy({ all: [{ path: "nested.value", op: "exists", value: false }] }, facts).passed, true);
  assert.equal(evaluatePolicy({ all: [{ path: "a", op: "gte", value: "5" }] }, facts).passed, false, "type mismatch must not pass");
  assert.equal(evaluatePolicy({ any: [{ path: "a", op: "eq", value: 1 }, { path: "a", op: "eq", value: 5 }] }, facts).passed, true);
  assert.equal(evaluatePolicy({ all: [{ path: "a", op: "eq", value: 5 }], any: [{ path: "a", op: "eq", value: 1 }] }, facts).passed, false);
  assert.equal(evaluatePolicy({ all: [{ path: "a", op: "bogus" as never, value: 1 }] }, facts).passed, false, "unknown operators fail closed");
});
