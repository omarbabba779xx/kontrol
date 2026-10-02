import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const act = () => import("../src/lib/core/ai-act");
const gov = () => import("../src/lib/core/ai-governance");
const engine = () => import("../src/lib/core/compliance-engine");

const none = { role: "deployer" as const, prohibited: [] as string[], annexIIIArea: "none" as const, derogationClaimed: false, profilesPeople: false, annexIProduct: false, interactsWithPeople: false, generatesSyntheticContent: false, emotionRecognitionOrBiometricCategorisation: false, gpaiProvider: false, gpaiSystemic: false, publicService: false };

test("classification: prohibited practices win over everything and carry no obligations", async () => {
  const { classify } = await act();
  const result = classify({ ...none, prohibited: ["social_scoring"], annexIIIArea: "employment", interactsWithPeople: true });
  assert.equal(result.tier, "prohibited");
  assert.deepEqual(result.obligations, []);
  assert.match(result.reasons[0], /Art\.5\(1\)\(c\)/);
});

test("classification: Annex III areas are high-risk, the Art.6(3) derogation applies only when nothing profiles people", async () => {
  const { classify } = await act();
  assert.equal(classify({ ...none, annexIIIArea: "employment" }).tier, "high");
  const derogated = classify({ ...none, annexIIIArea: "education", derogationClaimed: true });
  assert.equal(derogated.tier, "minimal");
  assert.ok(derogated.needsLegalReview.length > 0, "a derogation is a judgement to confirm");
  const profiled = classify({ ...none, annexIIIArea: "employment", derogationClaimed: true, profilesPeople: true });
  assert.equal(profiled.tier, "high");
  assert.ok(profiled.reasons.some((reason) => /always high-risk/.test(reason)));
  assert.equal(classify({ ...none, annexIProduct: true }).tier, "high");
});

test("classification: obligations depend on the role, and the FRIA only on the deployer and the use", async () => {
  const { classify } = await act();
  const provider = classify({ ...none, role: "provider", annexIIIArea: "essential_services" });
  const deployer = classify({ ...none, role: "deployer", annexIIIArea: "essential_services" });
  assert.ok(provider.obligations.some((item) => item.id === "conformity"));
  assert.ok(!provider.obligations.some((item) => item.id === "fria"));
  assert.ok(deployer.obligations.some((item) => item.id === "monitor_logs"));
  assert.ok(!deployer.obligations.some((item) => item.id === "conformity"));
  assert.equal(deployer.friaRequired, true, "creditworthiness and insurance pricing need a FRIA");
  assert.equal(classify({ ...none, annexIIIArea: "employment" }).friaRequired, false);
  assert.equal(classify({ ...none, annexIIIArea: "employment", publicService: true }).friaRequired, true);
  const both = classify({ ...none, role: "both", annexIIIArea: "employment" });
  assert.ok(both.obligations.some((item) => item.id === "conformity") && both.obligations.some((item) => item.id === "monitor_logs"));
});

test("classification: transparency, minimal risk and general-purpose models", async () => {
  const { classify, GPAI_SYSTEMIC_OBLIGATIONS } = await act();
  assert.equal(classify({ ...none, interactsWithPeople: true }).tier, "limited");
  assert.equal(classify({ ...none, generatesSyntheticContent: true, role: "provider" }).obligations.some((item) => item.id === "mark_synthetic"), true);
  assert.equal(classify(none).tier, "minimal");
  const gpai = classify({ ...none, role: "provider", gpaiProvider: true, gpaiSystemic: true });
  assert.equal(gpai.gpai.systemic, true);
  for (const item of GPAI_SYSTEMIC_OBLIGATIONS) assert.ok(gpai.obligations.some((own) => own.id === item.id));
  assert.equal(classify({ ...none, gpaiSystemic: true }).gpai.systemic, false, "systemic risk only means something for a GPAI provider");
});

test("every obligation maps to a real unified control, and no application date is hard-coded", async () => {
  const { HIGH_RISK_OBLIGATIONS, TRANSPARENCY_OBLIGATIONS, GPAI_OBLIGATIONS, GPAI_SYSTEMIC_OBLIGATIONS, FRIA_OBLIGATION } = await act();
  const { UC_BY_CODE } = await import("../src/lib/frameworks/unified");
  for (const item of [...HIGH_RISK_OBLIGATIONS, ...TRANSPARENCY_OBLIGATIONS, ...GPAI_OBLIGATIONS, ...GPAI_SYSTEMIC_OBLIGATIONS, FRIA_OBLIGATION]) assert.ok(UC_BY_CODE.has(item.ucCode), `${item.id} -> ${item.ucCode}`);
  const source = (await import("node:fs")).readFileSync(new URL("../src/lib/core/ai-act.ts", import.meta.url), "utf8");
  assert.ok(!/20(2[5-9]|30)-\d\d-\d\d/.test(source), "no calendar date is hard-coded");
});

let thirdId = "";
const card = (suffix = "") => ({ intended_purpose: `Rank consumer loan applications for review${suffix}`, out_of_scope: "Not for employment or insurance decisions", model_description: "Gradient-boosted model v3.2 trained in-house", training_data: "Five years of historical applications, rebalanced for age and sex", evaluation: "AUC 0.81, equal-opportunity gap 2.1 points across sex", limitations: "Degrades for thin-file applicants", human_oversight: "An underwriter reviews every decline" });
const fria = (overrides = {}) => ({ description: "Scores consumer credit applications to prioritise manual review", affectedGroups: "Loan applicants, including thin-file and young applicants", rights: [{ right: "Non-discrimination" as const, impact: "medium" as const, note: "Thin-file applicants may be ranked lower unfairly" }], mitigations: "Fairness monitoring and a manual second look for thin-file cases", oversight: "Every decline is reviewed by an underwriter", remedy: "Applicants can request human review and contest the outcome", ...overrides });
const high = { ...none, annexIIIArea: "essential_services" as const };

test("a use case is registered, classified, and a prohibited one is blocked for good", async () => {
  const { createUseCase, classifyUseCase, approveUseCase, aiSnapshot } = await gov();
  await assert.rejects(createUseCase(admin, { name: "Credit scoring", role: "deployer", ownerId: "usr_nobody" }), /Owner not found/);
  const made = await createUseCase(admin, { name: "Credit scoring assistant", purpose: "Rank applications", role: "deployer", ownerId: riskOwner.userId });
  assert.equal(made.ref, "AIS-001");
  thirdId = made.id;
  const result = await classifyUseCase(admin, { id: made.id, answers: high });
  assert.deepEqual([result.tier, result.status], ["high", "classified"]);
  assert.ok(result.classification.friaRequired);

  const banned = await createUseCase(admin, { name: "Workforce mood scoring", role: "deployer", ownerId: riskOwner.userId });
  const blocked = await classifyUseCase(admin, { id: banned.id, answers: { ...none, prohibited: ["emotion_work_school"] } });
  assert.equal(blocked.status, "blocked");
  await assert.rejects(approveUseCase(riskOwner, { id: banned.id, note: "Approve it anyway please" }), /prohibited AI practice/);
  const snapshot = await aiSnapshot(admin.tenantId);
  assert.equal(snapshot.summary.prohibited, 1);
  assert.equal(snapshot.summary.high, 1);
});

test("approval of a high-risk system needs the paperwork, the review, the controls and a different person", async () => {
  const { approveUseCase, saveModelCard, saveFria, reviewFria, createUseCase, classifyUseCase } = await gov();
  const { setImplementation } = await engine();
  await assert.rejects(approveUseCase(admin, { id: thirdId, note: "Creator approving own system" }), /Separation of duties: the person who registered/);
  await assert.rejects(approveUseCase(riskOwner, { id: thirdId, note: "Owner approving own system" }), /Separation of duties: the owner/);

  // Another owner, so that the risk owner can be the approver.
  const { inviteUser } = await import("../src/lib/core/admin");
  const nora = (await inviteUser(admin, { email: "nora@acme.example", name: "Nora Owner", role: "control_owner" })).id;
  const system = await createUseCase(admin, { name: "Loan decision copilot", role: "deployer", ownerId: nora });
  await classifyUseCase(admin, { id: system.id, answers: high });
  await assert.rejects(approveUseCase(riskOwner, { id: system.id, note: "No paperwork yet at all" }), /model card is required/);

  await assert.rejects(saveModelCard(admin, { id: system.id, content: { intended_purpose: "short" } }), /required sections/);
  await assert.rejects(saveModelCard(admin, { id: system.id, content: { ...card(), surprise: "x" } }), /Unknown model card field/);
  assert.deepEqual((await saveModelCard(admin, { id: system.id, content: card() })).version, 1);
  await assert.rejects(saveModelCard(admin, { id: system.id, content: card() }), /unchanged/);
  assert.equal((await saveModelCard(admin, { id: system.id, content: card(" (updated)") })).version, 2);

  await assert.rejects(approveUseCase(riskOwner, { id: system.id, note: "Missing the impact assessment" }), /impact assessment is required/);
  await assert.rejects(saveFria(admin, { id: system.id, content: fria({ remedy: "" }), complete: true }), /needs a description/);
  await assert.rejects(saveFria(admin, { id: system.id, content: fria({ rights: [{ right: "Non-discrimination", impact: "high", note: "" }] }), complete: true }), /Explain every medium or high/);
  await saveFria(admin, { id: system.id, content: fria(), complete: true });
  await assert.rejects(approveUseCase(riskOwner, { id: system.id, note: "FRIA not reviewed yet" }), /must be reviewed/);
  await assert.rejects(reviewFria(admin, { id: system.id }), /Separation of duties/);
  await reviewFria(riskOwner, { id: system.id });

  await assert.rejects(approveUseCase(riskOwner, { id: system.id, note: "Controls are not in place yet" }), /Controls behind the obligations/);
  for (const code of ["UC-AI-01", "UC-AI-02", "UC-AI-03", "UC-AI-04", "UC-AI-05", "UC-AI-06"]) await setImplementation(admin, { ucCode: code, status: "implemented", maturity: 3, notes: "In place" });
  await approveUseCase(riskOwner, { id: system.id, note: "Reviewed the pack and the controls" });
  await assert.rejects(approveUseCase(riskOwner, { id: system.id, note: "Approving again later" }), /already approved/);

  // Editing the impact assessment clears its review, and a change of tier voids the approval.
  await saveFria(admin, { id: system.id, content: fria({ oversight: "Every decline is reviewed by two underwriters" }), complete: true });
  const { aiSnapshot } = await gov();
  assert.equal((await aiSnapshot(admin.tenantId)).useCases.find((item) => item.id === system.id)?.fria?.reviewedBy, null);
  const changed = await classifyUseCase(admin, { id: system.id, answers: { ...none, interactsWithPeople: true } });
  assert.equal(changed.approvalVoided, true);
  assert.equal(changed.status, "classified");
  const same = await classifyUseCase(admin, { id: system.id, answers: { ...none, interactsWithPeople: true } });
  assert.equal(same.approvalVoided, false);
});

test("a minimal-risk system is approved without a model card, and retiring is final", async () => {
  const { createUseCase, classifyUseCase, approveUseCase, retireUseCase } = await gov();
  const { inviteUser } = await import("../src/lib/core/admin");
  const ivan = (await inviteUser(admin, { email: "ivan@acme.example", name: "Ivan Owner", role: "control_owner" })).id;
  const made = await createUseCase(admin, { name: "Spam filter", role: "deployer", ownerId: ivan });
  await assert.rejects(approveUseCase(riskOwner, { id: made.id, note: "Not classified yet at all" }), /Classify the use case/);
  await classifyUseCase(admin, { id: made.id, answers: none });
  await approveUseCase(riskOwner, { id: made.id, note: "Low risk, standard vendor filter" });
  await retireUseCase(admin, { id: made.id, note: "Replaced by the mail provider filter" });
  await assert.rejects(retireUseCase(admin, { id: made.id, note: "Retiring it one more time" }), /already final/);
  await assert.rejects(classifyUseCase(admin, { id: made.id, answers: none }), /retired/);
});

test("the API needs ai:manage to write, decisions:approve to approve, and reads are open to viewers", async () => {
  const { GET, POST } = await import("../src/app/api/ai-governance/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const call = async (role: "viewer" | "control_owner" | "auditor", body: unknown) => POST(new Request("http://localhost/api/ai-governance", { method: "POST", headers: { authorization: `Bearer ${await issueSessionToken({ ...admin, role })}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await call("viewer", { action: "create", name: "Nope assistant", role: "deployer" })).status, 403);
  assert.equal((await call("control_owner", { action: "create", name: "Support chatbot", role: "deployer" })).status, 201);
  assert.equal((await call("control_owner", { action: "approve", id: "ais_x", note: "Not allowed to approve" })).status, 403);
  assert.equal((await call("auditor", { action: "classify", id: "ais_x", answers: {} })).status, 400);
  const read = await GET(new Request("http://localhost/api/ai-governance", { headers: { authorization: `Bearer ${await issueSessionToken({ ...admin, role: "viewer" })}` } }));
  assert.equal(read.status, 200);
  assert.ok(((await read.json()) as { library: { prohibited: unknown[] } }).library.prohibited.length === 8);
});
