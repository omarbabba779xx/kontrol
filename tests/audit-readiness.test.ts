import assert from "node:assert/strict";
import { test } from "node:test";
import { assessReadiness, weakestLevel, type ReadinessInputs } from "../src/lib/frameworks/audit-readiness";
import { scoreFramework, type ControlState } from "../src/lib/frameworks/scoring";
import { UNIFIED_CONTROLS } from "../src/lib/frameworks/unified";
import type { FrameworkId } from "../src/lib/frameworks/types";

const FRAMEWORK: FrameworkId = "iso27001";
const state = (overrides: Partial<ControlState> = {}): ControlState => ({ status: "implemented", maturity: 3, verification: "unverified", excepted: false, ...overrides });
const all = (make: (code: string) => ControlState) => new Map(UNIFIED_CONTROLS.map((control) => [control.code, make(control.code)]));

function inputs(states: Map<string, ControlState>, extra: Partial<ReadinessInputs> = {}, notApplicable = new Map<string, string>()): ReadinessInputs {
  const documented = new Set([...states].filter(([, value]) => value.verification === "documented").map(([code]) => code));
  return { score: scoreFramework(FRAMEWORK, states, notApplicable), states, documented, openHighFindings: 0, expiredExceptions: 0, unjustifiedExclusions: 0, requireCountersignature: false, ...extra };
}

test("optimistic attestations alone never reach audit readiness, however high the declared score", () => {
  const result = assessReadiness(inputs(all(() => state({ verification: "unverified" }))));
  assert.equal(result.dimensions.declared, 100);
  assert.equal(result.dimensions.backed, 0);
  assert.notEqual(result.level, "audit_ready");
  assert.equal(result.level, "in_progress");
  assert.match(result.nextSteps.join(" "), /only attested/);
  assert.ok(result.criteria.find((item) => item.id === "backed")?.met === false);
});

test("claims backed by reviewed documents and clean of blockers are audit ready, and the level follows a stated rule", () => {
  const result = assessReadiness(inputs(all(() => state({ verification: "documented" }))));
  assert.equal(result.level, "audit_ready");
  assert.deepEqual([result.blockers, result.reservations], [[], []]);
  assert.equal(result.dimensions.documentary, 100);
  assert.equal(result.dimensions.technical, 0, "documents are not machine verification and are not reported as such");
  const machine = assessReadiness(inputs(all(() => state({ verification: "verified" }))));
  assert.deepEqual([machine.dimensions.technical, machine.dimensions.documentary, machine.level], [100, 0, "audit_ready"]);
});

test("a single blocking problem caps readiness, whatever the scores say", () => {
  const states = all(() => state({ verification: "documented" }));
  const codes = [...states.keys()];
  states.set(codes[0], state({ verification: "failing" }));
  const contradicted = assessReadiness(inputs(states));
  assert.equal(contradicted.level, "in_progress");
  assert.match(contradicted.blockers.join(" "), /contradicted by failing evidence: 1/);

  const findings = assessReadiness(inputs(all(() => state({ verification: "documented" })), { openHighFindings: 2 }));
  assert.equal(findings.level, "in_progress");
  assert.match(findings.blockers.join(" "), /high or critical findings: 2/);

  const expired = all(() => state({ verification: "documented" }));
  expired.set(codes[1], state({ attestationExpired: true }));
  assert.match(assessReadiness(inputs(expired)).blockers.join(" "), /past their review date/);

  const awaiting = all(() => state({ verification: "documented" }));
  awaiting.set(codes[2], state({ awaitingCountersignature: true }));
  assert.equal(assessReadiness(inputs(awaiting, { requireCountersignature: true })).level, "in_progress");
  assert.equal(assessReadiness(inputs(awaiting, { requireCountersignature: false })).level, "audit_ready", "only when the organisation requires the second confirmation");

  assert.equal(assessReadiness(inputs(all(() => state({ verification: "documented" })), { unjustifiedExclusions: 1 })).level, "in_progress");
});

test("reservations (heavy exclusions, lapsed evidence, expired acceptances) allow at most 'ready with reservations'", () => {
  const states = all(() => state({ verification: "documented" }));
  const full = scoreFramework(FRAMEWORK, states);
  const some = full.requirements.filter((requirement) => requirement.applicable).slice(0, Math.ceil(full.requirements.length * 0.5));
  const excluded = new Map(some.map((requirement) => [requirement.id, "Not in the scope of the certificate"]));
  const heavy = assessReadiness(inputs(states, {}, excluded));
  assert.ok(heavy.scope.excludedShare > 40);
  assert.equal(heavy.level, "ready_with_reservations");
  assert.match(heavy.reservations.join(" "), /excluded from scope/);
  assert.match(heavy.nextSteps.join(" "), /scope exclusions/);

  assert.equal(assessReadiness(inputs(states, { expiredExceptions: 1 })).level, "ready_with_reservations");
  const lapsed = all(() => state({ verification: "documented" }));
  lapsed.set([...lapsed.keys()][3], state({ verification: "stale" }));
  assert.equal(assessReadiness(inputs(lapsed)).level, "ready_with_reservations");
});

test("a barely started programme is not ready, and an empty scope is never ready", () => {
  assert.equal(assessReadiness(inputs(all(() => state({ status: "not_started", verification: "unverified" })))).level, "not_ready");
  const partial = assessReadiness(inputs(all(() => state({ status: "partial", verification: "documented" }))));
  assert.ok(partial.dimensions.declared < 70 && partial.level !== "audit_ready");
  const empty = assessReadiness({ ...inputs(all(() => state())), score: { ...scoreFramework(FRAMEWORK, all(() => state())), requirements: [], score: 0 } });
  assert.equal(empty.level, "not_ready");
});

test("the assessment is deterministic and explains itself", () => {
  const states = all((code) => state({ verification: code.endsWith("1") ? "documented" : "unverified" }));
  const first = assessReadiness(inputs(states)), second = assessReadiness(inputs(states));
  assert.deepEqual(first, second);
  assert.ok(first.criteria.every((item) => item.label && item.value !== undefined && item.threshold));
  assert.deepEqual(weakestLevel(["audit_ready", "in_progress", "ready_with_reservations"]), "in_progress");
  assert.equal(weakestLevel([]), null);
});
