import assert from "node:assert/strict";
import { test } from "node:test";
import { scenarioFor, THREAT_BY_ID, THREATS } from "../src/lib/risk/threat-library";
import { UC_BY_CODE } from "../src/lib/frameworks/unified";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const assets = () => import("../src/lib/core/risk-assets");
const rr = () => import("../src/lib/core/risk-register");
const ASSET = "asset_repo_lending";

test("the threat library is well formed: unique ids, every family, known controls, and at least one property affected", () => {
  assert.ok(THREATS.length >= 30);
  assert.equal(new Set(THREATS.map((threat) => threat.id)).size, THREATS.length);
  assert.equal(new Set(THREATS.map((threat) => threat.family)).size, 8, "all eight families are represented");
  for (const threat of THREATS) {
    assert.match(threat.id, /^TH-[A-Z]+-\d{2}$/);
    assert.ok(threat.affects.length >= 1 && threat.vulnerabilities.length >= 1 && threat.controls.length >= 1, threat.id);
    for (const code of threat.controls) assert.ok(UC_BY_CODE.has(code), `${threat.id} -> ${code}`);
  }
  for (const dimension of ["confidentiality", "integrity", "availability"] as const) assert.ok(THREATS.some((threat) => threat.affects.includes(dimension)));
});

test("a scenario's impact follows the value of the asset for the properties the threat affects", () => {
  const disclosure = THREAT_BY_ID.get("TH-INF-05")!; // confidentiality only
  const outage = THREAT_BY_ID.get("TH-SVC-01")!; // availability only
  const valuation = { confidentiality: 5, integrity: 3, availability: 2 };
  assert.equal(scenarioFor(disclosure, { name: "CRM", valuation }).impact, 5);
  assert.equal(scenarioFor(outage, { name: "CRM", valuation }).impact, 2, "an outage of an asset that barely needs to be available is a small impact");
  assert.deepEqual(scenarioFor(THREAT_BY_ID.get("TH-TEC-01")!, { name: "CRM", valuation }).impactByDimension, { availability: 2, integrity: 3 });
  assert.equal(scenarioFor(disclosure, { name: "CRM", valuation: null }).impact, null, "no valuation, no derived impact");
  assert.equal(scenarioFor(disclosure, { name: "CRM", valuation }).threatSource, "adversarial");
});

test("an asset is valued on three properties, and a threat cannot be assessed on an asset nobody has valued", async () => {
  const { valueAsset, riskIdentification, createScenario } = await assets();
  const before = await riskIdentification(admin.tenantId);
  assert.equal(before.coverage.valued, 0);
  assert.equal(before.assets.find((asset) => asset.id === ASSET)?.valuation, null);
  await assert.rejects(createScenario(riskOwner, { assetId: ASSET, threatId: "TH-INF-01", likelihood: 3 }), /Value the asset/);
  await assert.rejects(valueAsset(riskOwner, { assetId: ASSET, confidentiality: 6, integrity: 3, availability: 3 }), /between 1 and 5/);
  await assert.rejects(valueAsset(riskOwner, { assetId: "asset_nope", confidentiality: 3, integrity: 3, availability: 3 }), /Asset not found/);
  assert.deepEqual(await valueAsset(riskOwner, { assetId: ASSET, confidentiality: 5, integrity: 4, availability: 2, rationale: "Holds credit decisions and personal data" }), { assetId: ASSET, value: 5 });
  const after = await riskIdentification(admin.tenantId);
  const asset = after.assets.find((item) => item.id === ASSET)!;
  assert.deepEqual(asset.valuation, { confidentiality: 5, integrity: 4, availability: 2 });
  assert.ok(asset.toConsider.includes("TH-INF-06"), "a repository is offered the threats that concern repositories");
  assert.ok(!asset.toConsider.includes("TH-FUN-03"), "and not the ones that concern another kind of asset");
});

test("a scenario becomes a risk with its threat, its controls and its impact per property; the impact can be lowered with a reason, never raised", async () => {
  const { createScenario, riskIdentification } = await assets();
  const { riskSnapshot } = await rr();
  const { riskTraceability } = await import("../src/lib/core/risk-traceability");
  await assert.rejects(createScenario(riskOwner, { assetId: ASSET, threatId: "TH-NOPE-01", likelihood: 3 }), /Threat not found/);
  await assert.rejects(createScenario(riskOwner, { assetId: ASSET, threatId: "TH-SVC-01", likelihood: 3, impact: 4 }), /cannot exceed the value of the asset .* \(2\)/);
  await assert.rejects(createScenario(riskOwner, { assetId: ASSET, threatId: "TH-INF-01", likelihood: 3, impact: 2 }), /Explain why the impact is lower/);

  const created = await createScenario(riskOwner, { assetId: ASSET, threatId: "TH-INF-06", likelihood: 3, ownerId: riskOwner.userId });
  assert.equal(created.impact, 5, "secrets in source control damage confidentiality, which this asset values at 5");
  assert.deepEqual(created.impactByDimension, { confidentiality: 5, integrity: null, availability: null });
  const risk = (await riskSnapshot(admin.tenantId)).risks.find((item) => item.id === created.id)!;
  assert.deepEqual([risk.threat_id, risk.threat_source, risk.asset_id, risk.impact, risk.impact_c, risk.impact_a], ["TH-INF-06", "accidental", ASSET, 5, 5, null]);
  assert.deepEqual(risk.controls.map((control) => control.code), ["UC-DAT-04", "UC-SDL-01"]);
  assert.equal(risk.category, "cyber");

  const lowered = await createScenario(riskOwner, { assetId: ASSET, threatId: "TH-INF-01", likelihood: 2, impact: 3, impactReason: "Only the staging environment is reachable from the internet." });
  assert.equal(lowered.impact, 3);
  assert.deepEqual(lowered.impactByDimension, { confidentiality: 3, integrity: 3, availability: 2 }, "no property is rated above its own value");
  await assert.rejects(createScenario(riskOwner, { assetId: ASSET, threatId: "TH-INF-06", likelihood: 2 }), /already assessed on this asset as RSK-/);

  const identification = await riskIdentification(admin.tenantId);
  const asset = identification.assets.find((item) => item.id === ASSET)!;
  assert.deepEqual(asset.assessed.map((item) => item.threatId).sort(), ["TH-INF-01", "TH-INF-06"]);
  assert.ok(!asset.toConsider.includes("TH-INF-06"), "an assessed threat leaves the list of those still to consider");
  assert.equal(identification.coverage.scenarios, 2);
  const trace = await riskTraceability(admin.tenantId);
  assert.equal(trace.risks.find((item) => item.id === created.id)?.asset?.name, "lending-decision-service");
  assert.deepEqual(trace.breaks.risksWithoutAsset, []);
});

test("under SP 800-30 a scenario takes the two parts of likelihood, and impact criteria can be stated per property", async () => {
  const { createScenario } = await assets();
  const { setRiskMethod, riskMethod, riskSnapshot } = await rr();
  const five = (prefix: string) => [1, 2, 3, 4, 5].map((n) => `${prefix} level ${n}`);
  const base = { thresholds: { medium: 5, high: 10, critical: 17 }, appetite: "medium" as const, maxAcceptanceDays: 365 };
  await assert.rejects(setRiskMethod(admin, { ...base, method: "iso27005", impactCriteriaByDimension: { confidentiality: five("C"), integrity: ["only one"], availability: five("A") } }), /five integrity criteria/);
  await setRiskMethod(admin, { ...base, method: "nist_800_30", impactCriteriaByDimension: { confidentiality: five("C"), integrity: five("I"), availability: five("A") } });
  assert.equal((await riskMethod(admin.tenantId)).impactCriteriaByDimension?.availability[4], "A level 5");
  await assert.rejects(createScenario(riskOwner, { assetId: ASSET, threatId: "TH-INF-02", likelihood: 3 }), /two parts of likelihood/);
  const created = await createScenario(riskOwner, { assetId: ASSET, threatId: "TH-INF-02", likelihoodInitiation: 4, likelihoodImpact: 3 });
  const risk = (await riskSnapshot(admin.tenantId)).risks.find((item) => item.id === created.id)!;
  assert.deepEqual([risk.likelihood, risk.threat_source, risk.needsThreatDescription], [3, "adversarial", false]);
});

test("the API exposes identification, valuation and scenarios to those who manage risks", async () => {
  const { GET, POST } = await import("../src/app/api/risk-register/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const headers = async (actor: typeof admin | typeof riskOwner) => ({ authorization: `Bearer ${await issueSessionToken(actor)}`, "content-type": "application/json" });
  const view = await GET(new Request("http://localhost/api/risk-register?view=identification", { headers: await headers({ ...admin, role: "viewer" } as never) }));
  assert.equal(view.status, 200);
  assert.ok(((await view.json()) as { threats: unknown[] }).threats.length >= 30);
  const post = async (actor: typeof admin, body: unknown) => POST(new Request("http://localhost/api/risk-register", { method: "POST", headers: await headers(actor), body: JSON.stringify(body) }));
  assert.equal((await post({ ...admin, role: "viewer" } as never, { action: "value_asset", assetId: ASSET, confidentiality: 3, integrity: 3, availability: 3 })).status, 403);
  assert.equal((await post(admin, { action: "value_asset", assetId: ASSET, confidentiality: 5, integrity: 4, availability: 3 })).status, 200);
  assert.equal((await post(admin, { action: "scenario", assetId: ASSET, threatId: "not-a-threat", likelihood: 3 })).status, 400);
});
