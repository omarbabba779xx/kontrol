import assert from "node:assert/strict";
import { test } from "node:test";
import { bandFor, DEFAULT_METHOD, exceedsAppetite, nistRiskLevel, overallLikelihood, validateMethod, type RiskMethod } from "../src/lib/core/risk-method";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const rr = () => import("../src/lib/core/risk-register");
const engine = () => import("../src/lib/core/compliance-engine");
const second = { userId: "usr_second_admin", tenantId: admin.tenantId, email: "second@acme.example", name: "Second Admin", role: "admin" as const };
const matrix = { method: "iso27005" as const, thresholds: { medium: 5, high: 10, critical: 17 }, appetite: "medium" as const, maxAcceptanceDays: 365 };
const nist: RiskMethod = { ...DEFAULT_METHOD, method: "nist_800_30" };

test("NIST SP 800-30: overall likelihood follows Table G-5 and the level of risk follows Table I-2", () => {
  // Table G-5, rows: likelihood of initiation (very low to very high); columns: likelihood of adverse impact.
  assert.deepEqual([1, 2, 3, 4, 5].map((adverse) => overallLikelihood(5, adverse)), [2, 3, 4, 5, 5]);
  assert.deepEqual([1, 2, 3, 4, 5].map((adverse) => overallLikelihood(4, adverse)), [2, 3, 3, 4, 5]);
  assert.deepEqual([1, 2, 3, 4, 5].map((adverse) => overallLikelihood(3, adverse)), [2, 2, 3, 3, 4]);
  assert.deepEqual([1, 2, 3, 4, 5].map((adverse) => overallLikelihood(2, adverse)), [1, 2, 2, 3, 3]);
  assert.deepEqual([1, 2, 3, 4, 5].map((adverse) => overallLikelihood(1, adverse)), [1, 1, 2, 2, 2]);
  // Table I-2, rows: overall likelihood; columns: level of impact.
  assert.deepEqual([1, 2, 3, 4, 5].map((impact) => nistRiskLevel(5, impact)), [1, 2, 3, 4, 5]);
  assert.deepEqual([1, 2, 3, 4, 5].map((impact) => nistRiskLevel(4, impact)), [1, 2, 3, 4, 5]);
  assert.deepEqual([1, 2, 3, 4, 5].map((impact) => nistRiskLevel(3, impact)), [1, 2, 3, 3, 4]);
  assert.deepEqual([1, 2, 3, 4, 5].map((impact) => nistRiskLevel(2, impact)), [1, 2, 2, 2, 3]);
  assert.deepEqual([1, 2, 3, 4, 5].map((impact) => nistRiskLevel(1, impact)), [1, 1, 1, 2, 2]);
  assert.throws(() => overallLikelihood(0, 3), /between 1 and 5/);
  assert.throws(() => nistRiskLevel(3, 6), /between 1 and 5/);
  assert.equal(bandFor(nist, 5, 5), "critical");
  assert.equal(bandFor(nist, 3, 4), "medium", "moderate likelihood and high impact is a moderate risk in SP 800-30");
  assert.equal(bandFor(DEFAULT_METHOD, 3, 4), "high", "the same pair is high on the default matrix: the method matters");
});

test("the matrix method uses the organisation's own thresholds, and the appetite decides what needs a management decision", () => {
  const strict: RiskMethod = { ...DEFAULT_METHOD, thresholds: { medium: 3, high: 6, critical: 12 }, appetite: "low" };
  assert.deepEqual([2, 3, 6, 12].map((score) => bandFor(strict, score, 1)), ["low", "medium", "high", "critical"], "bands start where the organisation said");
  assert.equal(bandFor(strict, 2, 3), "high");
  assert.equal(bandFor(strict, 3, 4), "critical");
  assert.equal(bandFor(DEFAULT_METHOD, 2, 3), "medium");
  assert.equal(exceedsAppetite(strict, "medium"), true);
  assert.equal(exceedsAppetite(DEFAULT_METHOD, "medium"), false);
  assert.equal(exceedsAppetite(DEFAULT_METHOD, "high"), true);
  const labels = ["a", "b", "c", "d", "e"];
  const good = { ...matrix, likelihoodLabels: labels, impactLabels: labels, impactCriteria: ["", "", "", "", ""] };
  assert.equal(validateMethod(good), null);
  assert.match(validateMethod({ ...good, thresholds: { medium: 10, high: 5, critical: 17 } }) ?? "", /must increase/);
  assert.match(validateMethod({ ...good, thresholds: { medium: 1, high: 5, critical: 30 } }) ?? "", /between 2 and 25/);
  assert.match(validateMethod({ ...good, appetite: "critical" as never }) ?? "", /never within appetite/);
  assert.match(validateMethod({ ...good, maxAcceptanceDays: 0 }) ?? "", /between 1 and 730/);
  assert.match(validateMethod({ ...good, impactLabels: ["a"] }) ?? "", /five impact/);
});

test("the default method applies until an administrator approves one, and the decision is versioned and audited", async () => {
  const { riskSnapshot, setRiskMethod, riskMethod } = await rr();
  const before = await riskSnapshot(admin.tenantId);
  assert.equal(before.method.approved, false, "criteria nobody approved are reported as such");
  assert.equal(before.method.method, "iso27005");
  await assert.rejects(setRiskMethod(riskOwner, matrix), /Only an administrator/);
  await assert.rejects(setRiskMethod(admin, { ...matrix, thresholds: { medium: 9, high: 9, critical: 17 } }), /must increase/);
  assert.deepEqual(await setRiskMethod(admin, { ...matrix, appetite: "low", impactCriteria: ["Negligible", "Under 10k EUR", "Under 100k EUR", "Under 1M EUR", "Above 1M EUR or a regulated breach"] }), { version: 1, method: "iso27005" });
  const stored = await riskMethod(admin.tenantId);
  assert.equal(stored.appetite, "low");
  assert.equal(stored.approvedBy, admin.userId);
  assert.equal(stored.impactCriteria[4], "Above 1M EUR or a regulated breach");
  assert.equal((await setRiskMethod(admin, matrix)).version, 2);
  assert.equal((await riskSnapshot(admin.tenantId)).method.approved, true);
  const audit = await (await (await import("../src/lib/db")).getDb()).system().all<{ payload_json: string }>("SELECT payload_json FROM audit_log WHERE action = 'risk.method_set' ORDER BY sequence");
  assert.equal(audit.length, 2);
  assert.equal((JSON.parse(audit[1].payload_json) as { previous: { appetite: string } }).previous.appetite, "low", "the change records what it replaced");
});

test("changing the criteria re-rates existing risks at once, and a risk above the appetite needs an administrator and a real reason", async () => {
  const { createRisk, updateRisk, riskSnapshot, setRiskMethod, acceptRisk } = await rr();
  const created = await createRisk(riskOwner, { title: "Unpatched internet-facing service", category: "cyber", likelihood: 3, impact: 4, ownerId: riskOwner.userId });
  const find = async () => (await riskSnapshot(admin.tenantId)).risks.find((risk) => risk.id === created.id)!;
  assert.deepEqual([(await find()).inherent.band, (await find()).aboveAppetite], ["high", true], "score 12 is high and above a medium appetite");
  assert.equal((await riskSnapshot(admin.tenantId)).summary.aboveAppetite, 1);

  await assert.rejects(acceptRisk({ ...riskOwner, userId: "usr_other_owner" }, { id: created.id, days: 30, note: "We accept this for a month while the patch is tested." }), /only an administrator can accept it/);
  await assert.rejects(acceptRisk(second, { id: created.id, days: 30, note: "Fine for now." }), /40 characters minimum/);
  await assert.rejects(acceptRisk(second, { id: created.id, days: 400, note: "x".repeat(60) }), /between 1 and 365 days/);
  await acceptRisk(second, { id: created.id, days: 30, note: "Compensated by the WAF rule set and the vendor fix scheduled for the next maintenance window." });
  assert.equal((await riskSnapshot(admin.tenantId)).summary.acceptedAboveAppetite, 1, "accepted above the appetite stays visible");

  await setRiskMethod(admin, { ...matrix, thresholds: { medium: 6, high: 15, critical: 20 }, appetite: "medium" });
  assert.deepEqual([(await find()).inherent.band, (await find()).aboveAppetite], ["medium", false], "the same risk is medium under the new criteria");
  await setRiskMethod(admin, { ...matrix, thresholds: { medium: 4, high: 8, critical: 12 } });
  assert.equal((await find()).inherent.band, "critical");
  await updateRisk(riskOwner, { id: created.id, impact: 2 });
  assert.equal((await find()).inherent.band, "medium");
  await setRiskMethod(admin, matrix);
});

test("under SP 800-30 a risk is described by its threat, its likelihood is derived, and older risks are listed as needing the description", async () => {
  const { createRisk, updateRisk, riskSnapshot, setRiskMethod } = await rr();
  await setRiskMethod(admin, { ...matrix, method: "nist_800_30" });
  await assert.rejects(createRisk(riskOwner, { title: "Phishing of finance staff", category: "cyber", likelihood: 4, impact: 4 }), /threat source, its threat event and the two parts of likelihood/);
  const created = await createRisk(riskOwner, {
    title: "Phishing of finance staff", category: "cyber", impact: 4, ownerId: riskOwner.userId,
    threatSource: "adversarial", threatEvent: "Spear phishing leading to payment fraud", vulnerability: "No out-of-band check on bank detail changes", predisposingConditions: "Supplier invoices handled by email",
    likelihoodInitiation: 4, likelihoodImpact: 3, assetId: "asset_repo_lending",
  });
  const snapshot = await riskSnapshot(admin.tenantId);
  const risk = snapshot.risks.find((item) => item.id === created.id)!;
  assert.equal(risk.likelihood, 3, "Table G-5: high initiation and moderate adverse impact give a moderate likelihood");
  assert.equal(risk.inherent.band, "medium", "Table I-2: moderate likelihood and high impact give a moderate risk");
  assert.equal(risk.threat_source, "adversarial");
  assert.equal(risk.asset, "lending-decision-service", "the risk points at an asset of the inventory");
  assert.equal(risk.needsThreatDescription, false);
  assert.equal(snapshot.summary.needsThreatDescription, 1, "the risk recorded under the matrix method has no threat description yet");

  await updateRisk(riskOwner, { id: created.id, likelihoodImpact: 5 });
  assert.equal((await riskSnapshot(admin.tenantId)).risks.find((item) => item.id === created.id)!.likelihood, 5, "the overall likelihood follows its parts");
  await assert.rejects(createRisk(riskOwner, { title: "Bad asset", category: "cyber", impact: 3, threatSource: "accidental", threatEvent: "Misconfiguration", likelihoodInitiation: 2, likelihoodImpact: 2, assetId: "asset_nope" }), /Asset not found/);
  const fromGap = await createRisk(admin, { title: "Raised from a gap", category: "compliance", likelihood: 3, impact: 3, sourceType: "gap", sourceId: "UC-GOV-04" });
  assert.ok(fromGap.ref, "a risk raised by the system is not refused for lacking a threat description: it is listed as needing one");
  await setRiskMethod(admin, matrix);
});

test("traceability runs from asset and threat to risk, control and requirement, and names where the thread breaks", async () => {
  const { createRisk, updateRisk, riskTraceability, treatmentPlanCsv } = await rr();
  const { adoptFramework, setImplementation, exportStatement } = await engine();
  await adoptFramework(admin, { frameworkId: "iso27001", scope: "Whole organisation" });
  await adoptFramework(admin, { frameworkId: "cobit2019", scope: "IT governance" });
  await setImplementation(admin, { ucCode: "UC-IAM-02", status: "implemented", maturity: 3, notes: "MFA enforced" });
  await setImplementation(admin, { ucCode: "UC-OPS-05", status: "partial", maturity: 2, notes: "Logging in place" });
  const treated = await createRisk(riskOwner, { title: "Account takeover of an administrator", category: "cyber", likelihood: 4, impact: 5, ownerId: riskOwner.userId, controls: ["UC-IAM-02"], assetId: "asset_repo_lending" });
  await updateRisk(riskOwner, { id: treated.id, treatment: "mitigate" });
  const trace = await riskTraceability(admin.tenantId);
  const risk = trace.risks.find((item) => item.id === treated.id)!;
  assert.equal(risk.asset?.name, "lending-decision-service");
  const control = risk.controls.find((item) => item.code === "UC-IAM-02")!;
  assert.ok(control.requirements.iso27001.includes("A8.5"), "the control leads to the Annex A requirement it satisfies");
  assert.ok(control.requirements.cobit2019.includes("DSS05"), "and to the COBIT objective");
  assert.deepEqual(trace.controls.find((item) => item.code === "UC-IAM-02")?.risks, [treated.ref], "and back from the control to the risk");
  assert.ok(trace.breaks.mitigationWithoutPlan.includes(treated.ref), "a mitigation with no plan is named");
  assert.ok(trace.breaks.controlsNotLinkedToARisk.includes("UC-OPS-05"), "a claimed control that treats no recorded risk is named");
  assert.ok(trace.breaks.risksWithoutControl.length >= 1);

  const csv = await treatmentPlanCsv(admin.tenantId);
  assert.match(csv.split("\n")[0], /^ref,risk,asset,threat_event,inherent,residual,above_appetite,treatment,plan,controls,owner,target_date,status,accepted_until$/);
  assert.ok(csv.includes(`${treated.ref},Account takeover of an administrator,lending-decision-service`));

  const statement = await exportStatement(admin.tenantId, "iso27001");
  const header = statement.csv.split("\n")[0].split(",");
  assert.deepEqual(header.slice(-2), ["risks_treated", "inclusion_reason"]);
  const line = statement.csv.split("\n").find((row) => row.startsWith("A8.5,"))!;
  assert.ok(line.includes(treated.ref) && line.includes("risk treatment and framework requirement"), "the statement of applicability justifies the control by the risk it treats");
});

test("the API exposes the method, the traceability view and the treatment plan, and only an administrator sets the method", async () => {
  const { GET, POST } = await import("../src/app/api/risk-register/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const token = async (actor: typeof admin | typeof riskOwner) => issueSessionToken(actor);
  const get = async (query: string) => GET(new Request(`http://localhost/api/risk-register${query}`, { headers: { authorization: `Bearer ${await token(riskOwner)}` } }));
  assert.equal((await get("?view=traceability")).status, 200);
  const plan = await get("?format=treatment-plan");
  assert.match(plan.headers.get("content-type") ?? "", /text\/csv/);
  const body = { action: "set_method", ...matrix };
  const post = async (actor: typeof admin | typeof riskOwner) => POST(new Request("http://localhost/api/risk-register", { method: "POST", headers: { authorization: `Bearer ${await token(actor)}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await post(riskOwner)).status, 403);
  assert.equal((await post(admin)).status, 200);
});

test("under SP 800-30 the five NIST levels stay distinct: very low is not low, in the rating, in the appetite and in the decision", async () => {
  const { aboveAppetite, levelFor, appetiteLevelOf } = await import("../src/lib/core/risk-method");
  const { createRisk, riskSnapshot, setRiskMethod, acceptRisk } = await rr();
  assert.deepEqual(levelFor(nist, 1, 3), { level: 1, label: "Very low" });
  assert.deepEqual(levelFor(nist, 2, 2), { level: 2, label: "Low" });
  assert.equal(levelFor(DEFAULT_METHOD, 2, 2), null, "the matrix method has no NIST level");
  assert.equal(appetiteLevelOf(nist), 3, "without a stated level the appetite band is used");
  const veryLowAppetite: RiskMethod = { ...nist, appetiteLevel: 1 };
  assert.equal(aboveAppetite(veryLowAppetite, 1, 3), false, "a very low risk is within a very low appetite");
  assert.equal(aboveAppetite(veryLowAppetite, 2, 2), true, "a low risk is above it: the two levels are not merged");
  assert.equal(aboveAppetite({ ...nist, appetiteLevel: 2 }, 2, 2), false);

  await assert.rejects(setRiskMethod(admin, { ...matrix, appetiteLevel: 2 }), /applies to NIST SP 800-30/);
  await assert.rejects(setRiskMethod(admin, { ...matrix, method: "nist_800_30", appetiteLevel: 5 }), /between 1 \(very low\) and 4 \(high\)/);
  await setRiskMethod(admin, { ...matrix, method: "nist_800_30", appetiteLevel: 1 });
  const threat = { threatSource: "accidental" as const, threatEvent: "Misdirected email", ownerId: riskOwner.userId, category: "privacy" as const };
  const veryLow = await createRisk(riskOwner, { ...threat, title: "Very low risk", impact: 3, likelihoodInitiation: 1, likelihoodImpact: 1 });
  const low = await createRisk(riskOwner, { ...threat, title: "Low risk", impact: 2, likelihoodInitiation: 2, likelihoodImpact: 2 });
  const snapshot = await riskSnapshot(admin.tenantId);
  assert.equal(snapshot.method.appetiteLevel, 1);
  const view = (id: string) => snapshot.risks.find((risk) => risk.id === id)!;
  assert.deepEqual([view(veryLow.id).inherent.level?.label, view(veryLow.id).residual.level?.label, view(veryLow.id).aboveAppetite], ["Very low", "Very low", false]);
  assert.deepEqual([view(low.id).inherent.level?.label, view(low.id).aboveAppetite], ["Low", true]);
  assert.equal(view(low.id).inherent.band, view(veryLow.id).inherent.band, "the method-neutral band is the same for both, and decides nothing here");

  const note = "Accepted for the quarter while the mail gateway rule is rolled out to all staff.";
  await assert.rejects(acceptRisk({ ...riskOwner, userId: "usr_other_owner" }, { id: low.id, days: 30, note }), /This low residual risk is above the risk appetite \(very low\)/);
  await acceptRisk({ ...riskOwner, userId: "usr_other_owner" }, { id: veryLow.id, days: 30, note });
  await acceptRisk(second, { id: low.id, days: 30, note });
  await setRiskMethod(admin, matrix);
  assert.equal((await riskSnapshot(admin.tenantId)).method.appetiteLevel, undefined, "the matrix method has no appetite level");
});
