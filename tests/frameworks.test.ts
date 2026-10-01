import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAMEWORKS, FRAMEWORK_BY_ID } from "../src/lib/frameworks/catalog";
import { allLinks, baseControls, isKnownReference, linkBasis } from "../src/lib/frameworks/mapping";
import { UNIFIED_CONTROLS } from "../src/lib/frameworks/unified";
import { buildRoadmap, controlWeight, crosswalk, DEFAULT_STATE, overlapMatrix, scoreFramework, type ControlState } from "../src/lib/frameworks/scoring";

const state = (patch: Partial<ControlState>): ControlState => ({ ...DEFAULT_STATE, ...patch });

test("catalogues have the published sizes and unique ids", () => {
  const count = (id: string, filter: (requirement: { id: string }) => boolean = () => true) => FRAMEWORK_BY_ID.get(id as never)!.requirements.filter(filter).length;
  assert.equal(count("iso27001", (r) => r.id.startsWith("A")), 93);
  assert.equal(count("iso27001", (r) => r.id.startsWith("C")), 23);
  assert.equal(count("nist_csf"), 106);
  assert.equal(FRAMEWORK_BY_ID.get("nist_csf")!.groups?.length, 22);
  assert.equal(count("iso42001", (r) => r.id.startsWith("A.")), 38);
  assert.equal(count("iso42001", (r) => r.id.startsWith("C")), 24);
  assert.equal(count("cis_v8"), 153);
  assert.equal(FRAMEWORK_BY_ID.get("cis_v8")!.groups?.length, 18);
  assert.equal(count("pci_dss"), 63);
  assert.equal(count("gdpr"), 42);
  for (const framework of FRAMEWORKS) {
    const ids = framework.requirements.map((requirement) => requirement.id);
    assert.equal(new Set(ids).size, ids.length, `${framework.id} has duplicate ids`);
    for (const requirement of framework.requirements) if (requirement.parent) assert.ok(framework.groups?.some((item) => item.id === requirement.parent), `${framework.id} ${requirement.id}: unknown parent ${requirement.parent}`);
  }
});

test("every unified control reference points at a real requirement or group", () => {
  for (const control of UNIFIED_CONTROLS) {
    for (const [frameworkId, ids] of Object.entries(control.map)) {
      assert.ok(FRAMEWORK_BY_ID.get(frameworkId as never), `${control.code}: unknown framework ${frameworkId}`);
      for (const id of ids ?? []) assert.ok(isKnownReference(frameworkId as never, id), `${control.code}: ${frameworkId} has no requirement or group ${id}`);
    }
  }
});

test("every requirement of every framework is covered by at least one unified control", () => {
  for (const framework of FRAMEWORKS) {
    const orphans = framework.requirements.filter((requirement) => baseControls(framework.id, requirement.id).length === 0).map((requirement) => requirement.id);
    assert.deepEqual(orphans, [], `${framework.id} has unmapped requirements`);
  }
});

test("every unified control advances requirements in at least one framework", () => {
  const used = new Set(allLinks().map((link) => link.ucCode));
  assert.deepEqual(UNIFIED_CONTROLS.filter((control) => !used.has(control.code)).map((control) => control.code), []);
});

test("NIST CSF links come from NIST's published ISO 27001:2022 references", () => {
  const sub = FRAMEWORK_BY_ID.get("nist_csf")!.requirements.find((requirement) => requirement.id === "PR.AA-03")!;
  assert.ok(sub);
  assert.equal(linkBasis("nist_csf", "PR.AA-03", "UC-IAM-02"), "published");
  assert.ok(baseControls("nist_csf", "PR.AA-03").includes("UC-IAM-02"));
  const published = allLinks().filter((link) => link.frameworkId === "nist_csf" && link.basis === "published").length;
  assert.ok(published > 100, `expected a large published share, got ${published}`);
});

test("sub-requirements inherit their group mapping unless refined", () => {
  assert.ok(baseControls("cis_v8", "CIS.14.2").includes("UC-HR-02"));
  assert.ok(baseControls("cis_v8", "CIS.6.3").includes("UC-IAM-02"));
  assert.ok(!baseControls("cis_v8", "CIS.6.3").includes("UC-IAM-03"));
  assert.ok(baseControls("pci_dss", "Req.12.8").includes("UC-TPM-01"));
  assert.ok(baseControls("iso42001", "A.7.4").includes("UC-AI-03"));
});

test("scores scale with implementation and an empty posture scores zero", () => {
  const empty = scoreFramework("iso27001", new Map());
  assert.equal(empty.score, 0);
  assert.equal(empty.readiness, "Early stage");
  const all = new Map(UNIFIED_CONTROLS.map((control) => [control.code, state({ status: "implemented", verification: "verified" })]));
  const full = scoreFramework("iso27001", all);
  assert.equal(full.score, 100);
  assert.equal(full.verifiedShare, 100);
  assert.equal(full.readiness, "Audit ready");
  const half = scoreFramework("iso27001", new Map(UNIFIED_CONTROLS.map((control) => [control.code, state({ status: "partial" })])));
  assert.equal(half.score, 50);
  for (const framework of FRAMEWORKS) assert.equal(scoreFramework(framework.id, all).score, 100, `${framework.id} fully implemented`);
});

test("failing live evidence caps an attested implementation", () => {
  assert.equal(controlWeight(state({ status: "implemented", verification: "failing" })), 0.5);
  assert.equal(controlWeight(state({ status: "implemented", verification: "verified" })), 1);
  assert.equal(controlWeight(state({ status: "not_applicable" })), null);
});

test("not-applicable requirements leave the denominator and need no controls", () => {
  const states = new Map(UNIFIED_CONTROLS.map((control) => [control.code, state({ status: "implemented" })]));
  const result = scoreFramework("iso27001", states, new Map([["A7.4", "Fully remote company, no premises"]]));
  assert.equal(result.notApplicable, 1);
  assert.equal(result.requirements.find((requirement) => requirement.id === "A7.4")?.status, "not_applicable");
  assert.equal(result.applicable, FRAMEWORK_BY_ID.get("iso27001")!.requirements.length - 1);
});

test("one control implemented lifts several frameworks (crosswalk reuse)", () => {
  const states = new Map([["UC-OPS-05", state({ status: "implemented" })]]);
  const touched = ["iso27001", "nist_csf", "soc2", "dora", "pci_dss", "cis_v8"] as const;
  for (const id of touched) assert.ok(scoreFramework(id, states).score > 0, `${id} should gain from UC-OPS-05`);
  const link = crosswalk("iso27001", "A8.15");
  assert.ok(link.related.some((entry) => entry.frameworkId === "pci_dss" && entry.requirements.some((requirement) => requirement.id.startsWith("Req.10."))));
});

test("roadmap ranks multi-framework controls above single-framework ones and skips finished work", () => {
  const states = new Map([["UC-OPS-05", state({ status: "implemented", verification: "verified" })]]);
  const roadmap = buildRoadmap(["iso27001", "nist_csf", "soc2", "gdpr", "dora"], states);
  assert.ok(!roadmap.some((item) => item.code === "UC-OPS-05"));
  assert.ok(roadmap.length > 10);
  const priorities = roadmap.map((item) => item.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
  const failing = buildRoadmap(["iso27001"], new Map([["UC-OPS-05", state({ status: "implemented", verification: "failing" })]]));
  assert.ok(failing.some((item) => item.code === "UC-OPS-05"));
});

test("overlap matrix reports a high ISO 27001 to SOC 2 reuse", () => {
  const row = overlapMatrix().find((entry) => entry.base === "iso27001")!;
  const soc2 = row.targets.find((target) => target.target === "soc2")!;
  assert.ok(soc2.share >= 70, `expected strong overlap, got ${soc2.share}%`);
});

test("official crosswalks corroborate links with a named source and propose the links they imply", async () => {
  const { allSuggestions, linkSource } = await import("../src/lib/frameworks/mapping");
  const links = allLinks();
  const published = (framework: string) => links.filter((link) => link.frameworkId === framework && link.basis === "published");

  assert.ok(published("nis2").length >= 8, "ENISA's table corroborates NIS2 links");
  assert.match(linkSource("nis2", "Art.21(2)(h)", "UC-DAT-03") ?? "", /ENISA/);
  assert.ok(published("pci_dss").length > 5 && published("cis_v8").length > 10, "NIST's PCI DSS and CIS references corroborate links");
  assert.match(published("cis_v8")[0].source ?? "", /NIST CSF 2\.0/);
  for (const link of links.filter((item) => item.basis === "published")) assert.ok(link.source, `${link.frameworkId} ${link.requirementId} ${link.ucCode} names its source`);
  for (const link of links.filter((item) => item.basis === "editorial")) assert.equal(link.source, null);

  const suggestions = allSuggestions();
  assert.ok(suggestions.length > 0);
  for (const item of suggestions) {
    assert.ok(!baseControls(item.frameworkId, item.requirementId).includes(item.ucCode), `${item.requirementId} already links ${item.ucCode}`);
    assert.ok(UNIFIED_CONTROLS.some((control) => control.code === item.ucCode));
    assert.ok(item.source.length > 10);
  }
});
