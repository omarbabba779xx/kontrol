import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const targets = () => import("../src/lib/core/capability-targets");
const engine = () => import("../src/lib/core/compliance-engine");

test("the gap is the distance between the level reached and the level aimed for; nothing reached counts as zero", async () => {
  const { capabilityGap } = await targets();
  const aimed = new Map([["APO12", { target: 4, rationale: "" }], ["APO13", { target: 3, rationale: "" }], ["APO05", { target: 2, rationale: "" }], ["EDM02", { target: 0, rationale: "" }]]);
  const gap = capabilityGap([{ id: "APO12", capability: 2 }, { id: "APO13", capability: 3 }, { id: "APO05", capability: null }, { id: "EDM02" }, { id: "DSS05", capability: 1 }], aimed);
  assert.deepEqual([gap.targeted, gap.met, gap.totalGap], [4, 2, 4]);
  assert.deepEqual(gap.below, [{ id: "APO05", target: 2, reached: 0, gap: 2 }, { id: "APO12", target: 4, reached: 2, gap: 2 }], "the largest gaps first; an objective with no control cannot meet a target");
});

test("targets are a management decision, recorded with their reason, and the framework view reports the gap", async () => {
  const { setCapabilityTargets } = await targets();
  const { adoptFramework, setImplementation, frameworkDetail } = await engine();
  await adoptFramework(admin, { frameworkId: "cobit2019", scope: "IT governance" });
  await setImplementation(admin, { ucCode: "UC-GOV-04", status: "implemented", maturity: 2, notes: "Attested" });
  const rationale = "Risk and security are priority objectives for a regulated lender; portfolio management is out of scope.";
  await assert.rejects(setCapabilityTargets(riskOwner, { frameworkId: "cobit2019", targets: [{ requirementId: "APO12", target: 4 }], rationale }), /Only an administrator/);
  await assert.rejects(setCapabilityTargets(admin, { frameworkId: "cobit2019", targets: [{ requirementId: "XYZ99", target: 3 }], rationale }), /not found in COBIT/);
  await assert.rejects(setCapabilityTargets(admin, { frameworkId: "cobit2019", targets: [{ requirementId: "APO12", target: 6 }], rationale }), /between 0 and 5/);
  assert.deepEqual(await setCapabilityTargets(admin, { frameworkId: "cobit2019", targets: [{ requirementId: "APO12", target: 4 }, { requirementId: "EDM03", target: 2 }, { requirementId: "APO05", target: 0 }], rationale }), { frameworkId: "cobit2019", set: 3 });

  const detail = await frameworkDetail(admin.tenantId, "cobit2019");
  const of = (id: string) => detail.requirements.find((requirement) => requirement.id === id)!;
  assert.deepEqual([of("APO12").capability, of("APO12").capabilityTarget], [2, 4]);
  assert.equal(of("DSS05").capabilityTarget, null, "an objective with no target is not part of the gap");
  assert.deepEqual([detail.capabilityGap.targeted, detail.capabilityGap.met], [3, 2]);
  assert.deepEqual(detail.capabilityGap.below, [{ id: "APO12", target: 4, reached: 2, gap: 2 }]);

  await setCapabilityTargets(admin, { frameworkId: "cobit2019", targets: [{ requirementId: "APO12", target: 2 }], rationale });
  assert.equal((await frameworkDetail(admin.tenantId, "cobit2019")).capabilityGap.below.length, 0, "a target can be revised; the latest decision applies");
  const audit = await (await (await import("../src/lib/db")).getDb()).system().all("SELECT id FROM audit_log WHERE action = 'compliance.capability_targets_set'");
  assert.equal(audit.length, 2);
});
