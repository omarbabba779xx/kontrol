import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePolicy, testCondition, type Condition } from "../src/lib/core/policy-engine";

const NOW = Date.parse("2026-01-15T00:00:00Z");
const facts = { n: 5, zero: 0, s: "hello-world", yes: true, list: ["x", "y"], when: "2026-01-10T00:00:00Z", epoch: NOW - 3 * 86_400_000, future: "2026-02-01T00:00:00Z", nested: { deep: { value: 42 } } };
const check = (condition: Condition) => testCondition(facts, condition, NOW);

test("comparison operators", () => {
  assert.ok(check({ path: "n", op: "eq", value: 5 }));
  assert.ok(check({ path: "n", op: "neq", value: 4 }));
  assert.ok(check({ path: "n", op: "gt", value: 4 }) && !check({ path: "n", op: "gt", value: 5 }));
  assert.ok(check({ path: "n", op: "gte", value: 5 }) && check({ path: "n", op: "lte", value: 5 }));
  assert.ok(check({ path: "n", op: "lt", value: 6 }) && !check({ path: "n", op: "lt", value: 5 }));
  assert.ok(check({ path: "n", op: "between", value: [5, 5] }) && !check({ path: "n", op: "between", value: [6, 9] }));
  assert.ok(check({ path: "nested.deep.value", op: "eq", value: 42 }));
});

test("membership, length and existence operators", () => {
  assert.ok(check({ path: "s", op: "in", value: ["hello-world", "z"] }) && !check({ path: "s", op: "in", value: ["z"] }));
  assert.ok(check({ path: "s", op: "not_in", value: ["z"] }) && !check({ path: "s", op: "not_in", value: ["hello-world"] }));
  assert.ok(check({ path: "list", op: "includes", value: "y" }) && check({ path: "s", op: "includes", value: "world" }));
  assert.ok(check({ path: "list", op: "length_gte", value: 2 }) && !check({ path: "list", op: "length_gte", value: 3 }));
  assert.ok(check({ path: "list", op: "length_lte", value: 2 }) && check({ path: "s", op: "length_gte", value: 5 }));
  assert.ok(check({ path: "n", op: "exists" }) && check({ path: "missing", op: "not_exists" }) && check({ path: "missing", op: "exists", value: false }));
  assert.ok(!check({ path: "missing", op: "exists" }));
});

test("recency operators", () => {
  assert.ok(check({ path: "when", op: "within_days", value: 7 }) && !check({ path: "when", op: "within_days", value: 2 }));
  assert.ok(check({ path: "when", op: "older_than_days", value: 2 }) && !check({ path: "when", op: "older_than_days", value: 10 }));
  assert.ok(check({ path: "epoch", op: "within_days", value: 4 }), "epoch milliseconds are accepted");
  assert.ok(!check({ path: "future", op: "within_days", value: 365 }), "a future timestamp is not recent");
  assert.ok(!check({ path: "s", op: "within_days", value: 5 }), "an unparsable timestamp never passes");
});

test("every operator fails closed on missing facts, wrong types and malformed expectations", () => {
  const ops = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "length_gte", "length_lte", "matches", "within_days", "older_than_days"] as const;
  for (const op of ops) assert.equal(check({ path: "does.not.exist", op, value: 1 }), false, `${op} on a missing fact`);
  assert.equal(check({ path: "s", op: "gte", value: 1 }), false);
  assert.equal(check({ path: "n", op: "gte", value: "1" }), false);
  assert.equal(check({ path: "n", op: "between", value: [1] }), false);
  assert.equal(check({ path: "n", op: "in", value: 5 }), false);
  assert.equal(check({ path: "n", op: "length_gte", value: 1 }), false);
  assert.equal(check({ path: "n", op: "unknown" as never, value: 1 }), false);
});

test("regular expressions are anchored by the caller, bounded and protected against catastrophic backtracking", () => {
  assert.ok(check({ path: "s", op: "matches", value: "^hello" }) && !check({ path: "s", op: "matches", value: "^world" }));
  assert.equal(check({ path: "s", op: "matches", value: "(" }), false, "invalid pattern");
  assert.equal(check({ path: "s", op: "matches", value: "(hello)\\1" }), false, "back-reference rejected");
  assert.equal(check({ path: "s", op: "matches", value: "(a+)+$" }), false, "nested quantifier rejected");
  assert.equal(check({ path: "s", op: "matches", value: "x".repeat(121) }), false, "over-long pattern rejected");

  const hostile = { ...facts, s: `${"a".repeat(5000)}!` };
  const started = Date.now();
  assert.equal(testCondition(hostile, { path: "s", op: "matches", value: "(a+)+$" }, NOW), false);
  assert.ok(Date.now() - started < 200, "a classic ReDoS pattern must not hang the engine");
});

test("all, any and none groups combine as documented, and failures are explained", () => {
  const pass = evaluatePolicy({ all: [{ path: "n", op: "eq", value: 5 }], any: [{ path: "n", op: "gt", value: 9 }, { path: "yes", op: "eq", value: true }], none: [{ path: "n", op: "eq", value: 0 }] }, facts, NOW);
  assert.equal(pass.passed, true);
  assert.equal(pass.failed.length, 0);

  const noneBroken = evaluatePolicy({ none: [{ path: "n", op: "eq", value: 5 }] }, facts, NOW);
  assert.equal(noneBroken.passed, false);
  assert.equal(noneBroken.failed.length, 1);

  const anyBroken = evaluatePolicy({ any: [{ path: "n", op: "gt", value: 9 }, { path: "n", op: "lt", value: 1 }] }, facts, NOW);
  assert.equal(anyBroken.passed, false);
  assert.equal(anyBroken.failed.length, 2);

  assert.equal(evaluatePolicy({}, facts, NOW).passed, true, "an empty policy has no violated condition");
});
