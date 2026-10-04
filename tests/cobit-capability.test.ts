import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityProfile, controlCapability, requirementCapability } from "../src/lib/frameworks/capability";
import { FRAMEWORK_BY_ID } from "../src/lib/frameworks/catalog";
import { baseControls } from "../src/lib/frameworks/mapping";
import { DEFAULT_STATE, scoreFramework, type ControlState } from "../src/lib/frameworks/scoring";
import { UC_BY_CODE, UNIFIED_CONTROLS } from "../src/lib/frameworks/unified";

const state = (overrides: Partial<ControlState> = {}): ControlState => ({ status: "implemented", maturity: 3, verification: "documented", excepted: false, ...overrides });

test("COBIT 2019 carries its 40 objectives in five domains, and every mapped control exists", () => {
  const cobit = FRAMEWORK_BY_ID.get("cobit2019")!;
  assert.equal(cobit.requirements.length, 40);
  const perDomain = (prefix: string) => cobit.requirements.filter((item) => item.id.startsWith(prefix)).length;
  assert.deepEqual(["EDM", "APO", "BAI", "DSS", "MEA"].map(perDomain), [5, 14, 11, 6, 4]);
  assert.equal(new Set(cobit.requirements.map((item) => item.id)).size, 40);
  for (const requirement of cobit.requirements) for (const code of baseControls("cobit2019", requirement.id)) assert.ok(UC_BY_CODE.has(code), `${requirement.id} -> ${code}`);
  assert.deepEqual(baseControls("cobit2019", "APO12"), ["UC-GOV-04"], "managed risk is the risk assessment and treatment control");
  assert.ok(baseControls("cobit2019", "DSS05").includes("UC-IAM-02"));
  assert.match(cobit.granularity, /licensed content/, "the catalogue says what it does not reproduce");
});

test("objectives outside information security have no control and are never counted as met", () => {
  const all = new Map(UNIFIED_CONTROLS.map((control) => [control.code, state()]));
  const score = scoreFramework("cobit2019", all);
  const portfolio = score.requirements.find((item) => item.id === "APO05")!;
  assert.deepEqual([portfolio.controls, portfolio.score, portfolio.status], [[], 0, "gap"], "an unmapped objective is a gap until it is mapped or excluded");
  assert.ok(score.score < 100, "a fully implemented security library does not make COBIT fully met");
  const excluded = new Map(score.requirements.filter((item) => item.controls.length === 0).map((item) => [item.id, "Outside the scope of the information security programme"]));
  assert.equal(scoreFramework("cobit2019", all, excluded).score, 100, "with those objectives excluded and justified, the mapped ones decide");
});

test("a capability level starts from the declared maturity and is held back by status and by evidence", () => {
  assert.equal(controlCapability(state({ status: "not_applicable" })), null);
  assert.equal(controlCapability(state({ status: "not_started", maturity: 5 })), 0);
  assert.equal(controlCapability(state({ status: "planned", maturity: 4 })), 1);
  assert.equal(controlCapability(state({ status: "partial", maturity: 5 })), 2);
  assert.equal(controlCapability(state({ maturity: 5, verification: "verified" })), 5);
  assert.equal(controlCapability(state({ maturity: 5, verification: "documented" })), 5);
  assert.equal(controlCapability(state({ maturity: 5, verification: "unverified" })), 3, "measured and optimising need evidence, not a claim");
  assert.equal(controlCapability(state({ maturity: 5, verification: "stale" })), 3);
  assert.equal(controlCapability(state({ maturity: 5, verification: "failing" })), 2, "contradicted by evidence");
  assert.equal(controlCapability(state({ maturity: 4, attestationExpired: true })), 2);
  assert.equal(controlCapability(state({ maturity: 4, awaitingCountersignature: true })), 2);
  assert.equal(controlCapability(state({ maturity: 0 })), 1, "an implemented control is at least performed");
  assert.equal(controlCapability(state({ maturity: 2 })), 2);
});

test("an objective is as capable as its weakest control, and the profile summarises the framework", () => {
  const states = new Map<string, ControlState>([["UC-TPM-01", state({ maturity: 4, verification: "verified" })], ["UC-TPM-02", state({ maturity: 2 })], ["UC-TPM-03", state({ status: "not_applicable" })]]);
  assert.equal(requirementCapability(["UC-TPM-01", "UC-TPM-02", "UC-TPM-03"], states, DEFAULT_STATE), 2);
  assert.equal(requirementCapability(["UC-TPM-01", "UC-UNKNOWN"], states, DEFAULT_STATE), 0, "a control nobody has assessed is incomplete");
  assert.equal(requirementCapability(["UC-TPM-03"], states, DEFAULT_STATE), null);
  assert.deepEqual(capabilityProfile([0, 2, 2, 5, null, undefined]), { assessed: 4, distribution: [1, 0, 2, 0, 0, 1], average: 2.3, lowest: 0 });

  const all = new Map(UNIFIED_CONTROLS.map((control) => [control.code, state({ maturity: 3 })]));
  all.set("UC-GOV-04", state({ maturity: 4, verification: "verified" }));
  const score = scoreFramework("cobit2019", all);
  assert.equal(score.requirements.find((item) => item.id === "APO12")?.capability, 4);
  assert.equal(score.requirements.find((item) => item.id === "APO13")?.capability, 3, "held back by the other controls of the objective");
  assert.equal(score.capability.assessed, 29, "objectives with no control have no capability level rather than a flattering or a punishing one");
  assert.equal(score.capability.lowest, 3);
  assert.equal(scoreFramework("iso27001", all).capability.lowest, 3, "the same levels are available for every framework");
});
