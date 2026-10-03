import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/lib/core/auth";
import { admin, riskOwner, setEnv, isolateDatabase } from "./setup";

isolateDatabase();
setEnv({ NODE_ENV: "production", KONTROL_SEED: "true", KONTROL_AUTH_MODE: undefined, KONTROL_ALLOW_DEMO_IN_PRODUCTION: undefined, KONTROL_SECRETS_KEY: "w".repeat(40), KONTROL_AUTH_SECRET: "a".repeat(40), KONTROL_SIGNING_SECRET: "s".repeat(40) });

const engine = () => import("../src/lib/core/workflow-engine");
const gov = () => import("../src/lib/core/ai-governance");
const db = async () => (await import("../src/lib/db")).getDb();
const MIN = 60_000;

async function runUntil(actor: Actor, id: string, stop: (state: string) => boolean, max = 8) {
  const { runNextWorkflowStep, getWorkflow } = await engine();
  let current = (await getWorkflow(actor.tenantId, id))!;
  for (let i = 0; i < max && !stop(current.state); i += 1) current = (await runNextWorkflowStep(actor, id))!;
  return current;
}
const stepsOf = async (id: string) => (await engine()).workflowDetail(admin.tenantId, id).then((detail) => detail.steps);

test("a workflow cannot start without what its steps need, and the same request does not start it twice", async () => {
  const { startWorkflow } = await engine();
  await assert.rejects(startWorkflow(admin, "continuous_control", {}), /Invalid continuous_control workflow/);
  await assert.rejects(startWorkflow(admin, "continuous_control", { connector: "github" }), /owner and a repository/);
  await assert.rejects(startWorkflow(admin, "ai_release", {}), /useCaseId/);
  await assert.rejects(startWorkflow(admin, "regulatory_change", { framework: "gdpr" }), /citation/);
  const first = (await startWorkflow(admin, "continuous_control", { connector: "okta", demo: true, idempotencyKey: "nightly-okta-2026-10-03" }))!;
  const again = (await startWorkflow(admin, "continuous_control", { connector: "okta", demo: true, idempotencyKey: "nightly-okta-2026-10-03" }))!;
  assert.equal(again.id, first.id);
  const rows = await (await db()).system().all("SELECT id FROM workflows WHERE idempotency_key = ?", "nightly-okta-2026-10-03");
  assert.equal(rows.length, 1);
});

test("continuous control: a sample collection produces evidence, findings and one remediation task per finding, with every step recorded", async () => {
  const { startWorkflow } = await engine();
  const workflow = (await startWorkflow(riskOwner, "continuous_control", { connector: "github", owner: "acme", repository: "lending", assetId: "asset_repo_lending", demo: true }))!;
  const done = await runUntil(riskOwner, workflow.id, (state) => state === "completed");
  assert.equal(done.state, "completed");
  const steps = await stepsOf(workflow.id);
  assert.deepEqual(steps.map((step) => [step.step, step.status]), [["collect", "ok"], ["evaluate", "ok"], ["open_or_close_finding", "ok"], ["complete", "ok"]]);
  const collect = steps[0].output as { mode: string; evaluations: Array<{ controlCode: string; passed: boolean; evidenceId: string | null }> };
  assert.equal(collect.mode, "demo");
  assert.ok(collect.evaluations.length >= 3);
  assert.ok(collect.evaluations.every((item) => item.evidenceId), "every result points at the evidence it produced");
  assert.ok(steps.every((step) => /^[0-9a-f]{64}$/.test(step.outputSha256)));
  const tasks = steps[2].output as { findingsOpen: number; tasks: Array<{ created: boolean }> };
  assert.equal(tasks.tasks.length, tasks.findingsOpen);
  assert.ok(tasks.tasks.every((task) => task.created));

  // The same collection again changes nothing it should not: findings are updated in place and no second task is opened for them.
  const again = (await startWorkflow(riskOwner, "continuous_control", { connector: "github", owner: "acme", repository: "lending", assetId: "asset_repo_lending", demo: true }))!;
  await runUntil(riskOwner, again.id, (state) => state === "completed");
  const second = (await stepsOf(again.id))[2].output as { tasks: Array<{ created: boolean }> };
  assert.ok(second.tasks.length > 0 && second.tasks.every((task) => !task.created), "existing tasks are reused");
  const open = await (await db()).system().all("SELECT id FROM tasks WHERE source_type = 'finding' AND status = 'open'");
  assert.equal(open.length, tasks.tasks.length);
});

test("continuous control: a live collection without credentials fails loudly, is retried with a delay, and stops after three attempts", async () => {
  const { startWorkflow, getWorkflow, runNextWorkflowStep } = await engine();
  const workflow = (await startWorkflow(admin, "continuous_control", { connector: "gitlab", project: "acme/none" }))!;
  const first = (await runNextWorkflowStep(admin, workflow.id))!;
  assert.equal(first.state, "queued");
  assert.ok(first.next_run_at && Date.parse(first.next_run_at) > Date.now(), "the retry waits");
  assert.equal(first.claimed_at, null, "the claim is released after a failure");
  await runNextWorkflowStep(admin, workflow.id);
  const last = (await runNextWorkflowStep(admin, workflow.id))!;
  assert.equal(last.state, "failed");
  const steps = await stepsOf(workflow.id);
  assert.deepEqual(steps.map((step) => [step.attempt, step.status]), [[1, "failed"], [2, "failed"], [3, "failed"]]);
  assert.match(steps[0].error ?? "", /No gitlab credentials are stored/);
  assert.equal((await getWorkflow(admin.tenantId, workflow.id))!.state, "failed");
});

async function releaseFixture() {
  const { createUseCase, classifyUseCase } = await gov();
  const { inviteUser } = await import("../src/lib/core/admin");
  const email = `owner-${Math.random().toString(36).slice(2, 8)}@acme.example`;
  const owner = (await inviteUser(admin, { email, name: "System Owner", role: "control_owner" })).id;
  const made = await createUseCase(admin, { name: "Credit scoring assistant", role: "deployer", ownerId: owner });
  const answers = { role: "deployer" as const, prohibited: [] as string[], annexIIIArea: "essential_services" as const, derogationClaimed: false, profilesPeople: false, annexIProduct: false, interactsWithPeople: false, generatesSyntheticContent: false, emotionRecognitionOrBiometricCategorisation: false, gpaiProvider: false, gpaiSystemic: false, publicService: false };
  await classifyUseCase(admin, { id: made.id, answers });
  return { id: made.id, owner, answers };
}
const card = { intended_purpose: "Rank consumer loan applications for review", out_of_scope: "Not for employment decisions", model_description: "Gradient-boosted model v3.2", training_data: "Five years of applications, rebalanced", evaluation: "AUC 0.81, equal-opportunity gap 2 points", limitations: "Degrades for thin-file applicants", human_oversight: "An underwriter reviews every decline" };
const fria = { description: "Scores consumer credit applications for manual review", affectedGroups: "Loan applicants, including thin-file applicants", rights: [{ right: "Non-discrimination" as const, impact: "medium" as const, note: "Thin-file applicants may be ranked lower" }], mitigations: "Fairness monitoring and a second look", oversight: "Every decline is reviewed", remedy: "Applicants can contest the outcome" };

test("AI release: a high-risk system without its paperwork is blocked at evaluation, with the reasons, and never reaches approval", async () => {
  const { startWorkflow } = await engine();
  const fixture = await releaseFixture();
  const workflow = (await startWorkflow(admin, "ai_release", { useCaseId: fixture.id }))!;
  const done = await runUntil(admin, workflow.id, (state) => ["failed", "awaiting_approval"].includes(state));
  assert.equal(done.state, "failed");
  const steps = await stepsOf(workflow.id);
  assert.deepEqual(steps.map((step) => [step.step, step.status]), [["inventory", "ok"], ["classify", "ok"], ["evaluate", "blocked"]]);
  assert.match(steps[2].error ?? "", /model card is required/);
  assert.match(steps[2].error ?? "", /impact assessment/);
  assert.match(JSON.parse(done.payload_json).blockedReason, /model card/);
  assert.equal(done.approval_token, null);
});

test("AI release: a prohibited practice, an unknown system and an unclassified one are blocked early", async () => {
  const { startWorkflow } = await engine();
  const { createUseCase, classifyUseCase } = await gov();
  const banned = await createUseCase(admin, { name: "Mood scoring", role: "deployer", ownerId: riskOwner.userId });
  await classifyUseCase(admin, { id: banned.id, answers: { role: "deployer", prohibited: ["emotion_work_school"], annexIIIArea: "none", derogationClaimed: false, profilesPeople: false, annexIProduct: false, interactsWithPeople: false, generatesSyntheticContent: false, emotionRecognitionOrBiometricCategorisation: false, gpaiProvider: false, gpaiSystemic: false, publicService: false } });
  const blocked = await runUntil(admin, (await startWorkflow(admin, "ai_release", { useCaseId: banned.id }))!.id, (state) => state === "failed");
  assert.match(JSON.parse(blocked.payload_json).blockedReason, /prohibited AI practice/);
  const missing = await runUntil(admin, (await startWorkflow(admin, "ai_release", { useCaseId: "ais_nope" }))!.id, (state) => state === "failed");
  assert.match(JSON.parse(missing.payload_json).blockedReason, /does not exist/);
  const unclassified = await createUseCase(admin, { name: "Unclassified", role: "deployer", ownerId: riskOwner.userId });
  const early = await runUntil(admin, (await startWorkflow(admin, "ai_release", { useCaseId: unclassified.id }))!.id, (state) => state === "failed");
  assert.match(JSON.parse(early.payload_json).blockedReason, /not been classified/);
});

test("AI release: with the paperwork and controls it reaches approval; the requester cannot approve; the approver's decision releases the system", async () => {
  const { startWorkflow, approveWorkflow } = await engine();
  const { saveModelCard, saveFria, reviewFria, aiSnapshot } = await gov();
  const { setImplementation } = await import("../src/lib/core/compliance-engine");
  const fixture = await releaseFixture();
  await saveModelCard(admin, { id: fixture.id, content: card });
  await saveFria(admin, { id: fixture.id, content: fria, complete: true });
  await reviewFria(riskOwner, { id: fixture.id });
  for (const code of ["UC-AI-01", "UC-AI-02", "UC-AI-03", "UC-AI-04", "UC-AI-05", "UC-AI-06"]) await setImplementation(admin, { ucCode: code, status: "implemented", maturity: 3, notes: "In place" });

  const workflow = (await startWorkflow(admin, "ai_release", { useCaseId: fixture.id }))!;
  const waiting = await runUntil(admin, workflow.id, (state) => state === "awaiting_approval");
  assert.equal(waiting.state, "awaiting_approval");
  assert.ok(waiting.approval_token);
  const evaluate = (await stepsOf(workflow.id)).find((step) => step.step === "evaluate")!;
  assert.deepEqual((evaluate.output as { blocking: string[] }).blocking, []);

  await assert.rejects(approveWorkflow(admin, workflow.id, true, "Approving my own request"), /separation of duties/);
  const approved = (await approveWorkflow(riskOwner, workflow.id, true, "Paperwork and controls reviewed."))!;
  assert.equal(approved.state, "queued");
  assert.equal((await aiSnapshot(admin.tenantId)).useCases.find((item) => item.id === fixture.id)?.status, "approved", "the system is released by the same decision");
  const finished = await runUntil(admin, workflow.id, (state) => state === "completed");
  assert.equal(finished.state, "completed");
  const complete = (await stepsOf(workflow.id)).find((step) => step.step === "complete")!;
  assert.equal((complete.output as { status: string }).status, "approved");
  await assert.rejects(approveWorkflow(riskOwner, workflow.id, true, "Approving again later"), /not awaiting approval/);
});

test("AI release: when the system's own rules refuse the approver, the workflow keeps waiting", async () => {
  const { startWorkflow, approveWorkflow, getWorkflow } = await engine();
  const { saveModelCard, saveFria, reviewFria } = await gov();
  const fixture = await releaseFixture();
  await saveModelCard(admin, { id: fixture.id, content: card });
  await saveFria(admin, { id: fixture.id, content: fria, complete: true });
  await reviewFria(riskOwner, { id: fixture.id });
  const workflow = (await startWorkflow(riskOwner, "ai_release", { useCaseId: fixture.id }))!;
  await runUntil(riskOwner, workflow.id, (state) => state === "awaiting_approval");
  // admin registered the system, so the system's separation of duties refuses admin even though a different person started the workflow.
  await assert.rejects(approveWorkflow(admin, workflow.id, true, "Registrant approving"), /Separation of duties/);
  assert.equal((await getWorkflow(admin.tenantId, workflow.id))!.state, "awaiting_approval");
  const rejected = (await approveWorkflow(admin, workflow.id, false, "Rejecting the release for now."))!;
  assert.equal(rejected.state, "failed");
});

const ingestInput = (text: string) => ({ framework: "gdpr", citation: "Art.32", title: "Security of processing", text, sourceUrl: "https://eur-lex.europa.eu/eli/reg/2016/679/oj", effectiveFrom: "2018-05-25" });
const V1 = "The controller and the processor shall implement appropriate technical and organisational measures to ensure a level of security appropriate to the risk, including encryption and pseudonymisation of personal data.";
const V2 = `${V1} They shall also test and evaluate the effectiveness of those measures regularly and document the outcome of each test for the supervisory authority.`;

test("regulatory change: ingest, diff and mapping produce real results, approval by another person creates one review task per control, and finishing twice duplicates nothing", async () => {
  const { startWorkflow, approveWorkflow } = await engine();
  const workflow = (await startWorkflow(admin, "regulatory_change", ingestInput(V1)))!;
  const waiting = await runUntil(admin, workflow.id, (state) => state === "awaiting_approval");
  assert.equal(waiting.state, "awaiting_approval");
  const steps = await stepsOf(workflow.id);
  const ingest = steps.find((step) => step.step === "ingest")!.output as { obligationId: string; duplicate: boolean };
  assert.ok(ingest.obligationId.startsWith("obligation_") && !ingest.duplicate);
  const diff = steps.find((step) => step.step === "diff")!.output as { firstVersion: boolean; material: boolean };
  assert.deepEqual([diff.firstVersion, diff.material], [true, true]);
  const mapped = steps.find((step) => step.step === "map_controls")!.output as { unifiedControls: Array<{ code: string }> };
  assert.ok(mapped.unifiedControls.length > 0, "the published crosswalk links GDPR Art.32 to controls");

  await assert.rejects(approveWorkflow(admin, workflow.id, true, "Approving my own request"), /separation of duties/);
  await approveWorkflow(riskOwner, workflow.id, true, "The affected controls are right.");
  const done = await runUntil(admin, workflow.id, (state) => state === "completed");
  assert.equal(done.state, "completed");
  const tasks = await (await db()).system().all<{ uc_code: string }>("SELECT uc_code FROM tasks WHERE source_type = 'regulatory_change' AND source_id = ?", workflow.id);
  assert.deepEqual(tasks.map((task) => task.uc_code).sort(), mapped.unifiedControls.map((control) => control.code).sort());

  // A crash after the tasks were created but before the step was recorded: running the completion again must not create them twice.
  const sys = (await db()).system();
  await sys.run("DELETE FROM workflow_steps WHERE workflow_id = ? AND step = 'complete'", workflow.id);
  await sys.run("UPDATE workflows SET state = 'queued', current_step = 'complete', next_run_at = ? WHERE id = ?", new Date().toISOString(), workflow.id);
  await runUntil(admin, workflow.id, (state) => state === "completed");
  assert.equal((await sys.all("SELECT id FROM tasks WHERE source_type = 'regulatory_change' AND source_id = ?", workflow.id)).length, tasks.length);
});

test("regulatory change: an unchanged text needs no approval, a changed text shows what changed, and an unapproved source is blocked", async () => {
  const { startWorkflow } = await engine();
  const same = await runUntil(admin, (await startWorkflow(admin, "regulatory_change", ingestInput(V1)))!.id, (state) => ["completed", "awaiting_approval", "failed"].includes(state));
  assert.equal(same.state, "completed", "same hash, nothing to review");
  const sameSteps = await stepsOf(same.id);
  assert.equal((sameSteps.find((step) => step.step === "ingest")!.output as { duplicate: boolean }).duplicate, true);
  assert.equal((sameSteps.find((step) => step.step === "diff")!.output as { material: boolean }).material, false);
  assert.ok(!sameSteps.some((step) => step.step === "map_controls"));

  const changed = await runUntil(admin, (await startWorkflow(admin, "regulatory_change", ingestInput(V2)))!.id, (state) => ["completed", "awaiting_approval", "failed"].includes(state));
  assert.equal(changed.state, "awaiting_approval");
  const diff = (await stepsOf(changed.id)).find((step) => step.step === "diff")!.output as { firstVersion: boolean; material: boolean; added: string[]; similarity: number };
  assert.equal(diff.firstVersion, false);
  assert.ok(diff.material && diff.added.includes("evaluate") && diff.similarity < 1);

  const bad = await runUntil(admin, (await startWorkflow(admin, "regulatory_change", { ...ingestInput(`${V2} extra words here`), sourceUrl: "https://example.com/gdpr" }))!.id, (state) => state === "failed");
  assert.match(JSON.parse(bad.payload_json).blockedReason, /not approved/);
  assert.equal((await stepsOf(bad.id))[0].status, "blocked");
});

test("concurrent runners cannot execute the same step twice", async () => {
  const { startWorkflow, runNextWorkflowStep } = await engine();
  const workflow = (await startWorkflow(admin, "continuous_control", { connector: "okta", demo: true }))!;
  const results = await Promise.all([runNextWorkflowStep(admin, workflow.id), runNextWorkflowStep(admin, workflow.id), runNextWorkflowStep(admin, workflow.id)]);
  assert.ok(results.every(Boolean));
  const steps = await stepsOf(workflow.id);
  assert.equal(steps.filter((step) => step.step === "collect").length, 1, "the collection ran once");
  const attempts = (await (await db()).system().get<{ attempts: number }>("SELECT attempts FROM workflows WHERE id = ?", workflow.id))!.attempts;
  assert.equal(Number(attempts), 1);
});

test("a workflow whose runner crashed is released after the lease and resumes without redoing finished steps", async () => {
  const { startWorkflow, runNextWorkflowStep, runDueWorkflows, recoverStalledWorkflows, LEASE_MS } = await engine();
  const sys = (await db()).system();
  const workflow = (await startWorkflow(admin, "continuous_control", { connector: "okta", demo: true }))!;
  await runNextWorkflowStep(admin, workflow.id); // collect done
  // The next runner claims it and dies before recording anything.
  const stale = new Date(Date.now() - LEASE_MS - MIN).toISOString();
  await sys.run("UPDATE workflows SET state = 'running', claimed_at = ? WHERE id = ?", stale, workflow.id);
  assert.equal(((await runNextWorkflowStep(admin, workflow.id))!).state, "running", "nobody else may take a live claim");
  await sys.run("UPDATE workflows SET claimed_at = ? WHERE id = ?", new Date().toISOString(), workflow.id);
  assert.equal(await recoverStalledWorkflows(admin), 0, "a claim inside its lease is left alone");
  await sys.run("UPDATE workflows SET claimed_at = ? WHERE id = ?", stale, workflow.id);
  assert.equal(await recoverStalledWorkflows(admin), 1);
  for (let i = 0; i < 4; i += 1) await runDueWorkflows(admin);
  const done = await runUntil(admin, workflow.id, (state) => state === "completed");
  assert.equal(done.state, "completed");
  const collects = (await stepsOf(workflow.id)).filter((step) => step.step === "collect");
  assert.equal(collects.length, 1, "the finished collection was not repeated");
  const audit = await sys.all<{ action: string }>("SELECT action FROM audit_log WHERE object_id = ? ORDER BY sequence", workflow.id);
  assert.ok(audit.some((entry) => entry.action === "workflow.recovered"));
});

test("a step already recorded is reused rather than redone when the state did not advance", async () => {
  const { startWorkflow, runNextWorkflowStep } = await engine();
  const sys = (await db()).system();
  const workflow = (await startWorkflow(admin, "continuous_control", { connector: "okta", demo: true }))!;
  await runNextWorkflowStep(admin, workflow.id);
  // Simulate a crash between recording the step and advancing the workflow.
  await sys.run("UPDATE workflows SET state = 'queued', current_step = 'collect' WHERE id = ?", workflow.id);
  const before = Number((await sys.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence"))!.n);
  await runNextWorkflowStep(admin, workflow.id);
  assert.equal(Number((await sys.get<{ n: number }>("SELECT COUNT(*) AS n FROM evidence"))!.n), before, "no new evidence was collected");
  assert.equal((await stepsOf(workflow.id)).filter((step) => step.step === "collect").length, 1);
  const audit = await sys.all<{ payload_json: string }>("SELECT payload_json FROM audit_log WHERE object_id = ? AND action = 'workflow.step_completed' ORDER BY sequence", workflow.id);
  assert.equal(JSON.parse(audit[audit.length - 1].payload_json).resumed, true);
});

test("a waiting workflow can be cancelled by someone who may run workflows, a running or finished one cannot, and nothing leaks across tenants", async () => {
  const { startWorkflow, cancelWorkflow, runNextWorkflowStep, getWorkflow, workflowDetail } = await engine();
  const waiting = (await startWorkflow(admin, "continuous_control", { connector: "okta", demo: true }))!;
  const cancelled = (await cancelWorkflow(riskOwner, waiting.id, "Superseded by the nightly run"))!;
  assert.equal(cancelled.state, "cancelled");
  assert.equal(((await runNextWorkflowStep(admin, waiting.id))!).state, "cancelled", "a cancelled workflow does not run");
  await assert.rejects(cancelWorkflow(admin, waiting.id, "Cancelling a second time"), /already cancelled/);

  const running = (await startWorkflow(admin, "continuous_control", { connector: "okta", demo: true }))!;
  await (await db()).system().run("UPDATE workflows SET state = 'running', claimed_at = ? WHERE id = ?", new Date().toISOString(), running.id);
  await assert.rejects(cancelWorkflow(admin, running.id, "Cancelling while running"), /being executed/);

  assert.equal(await getWorkflow("tenant_other", waiting.id), undefined);
  await assert.rejects(workflowDetail("tenant_other", waiting.id), /not found/);
});

test("the API exposes the step history and refuses writes without the permission", async () => {
  const { GET } = await import("../src/app/api/workflows/[id]/route");
  const { POST } = await import("../src/app/api/workflows/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const { startWorkflow } = await engine();
  const workflow = (await startWorkflow(admin, "continuous_control", { connector: "okta", demo: true }))!;
  const header = async (role: "viewer" | "admin") => ({ authorization: `Bearer ${await issueSessionToken({ ...admin, role })}`, "content-type": "application/json" });
  const read = await GET(new Request("http://localhost/x", { headers: await header("viewer") }), { params: Promise.resolve({ id: workflow.id }) });
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { workflow: { id: string } }).workflow.id, workflow.id);
  const denied = await POST(new Request("http://localhost/api/workflows", { method: "POST", headers: await header("viewer"), body: JSON.stringify({ kind: "continuous_control", payload: { connector: "okta", demo: true } }) }));
  assert.equal(denied.status, 403);
  const invalid = await POST(new Request("http://localhost/api/workflows", { method: "POST", headers: await header("admin"), body: JSON.stringify({ kind: "continuous_control", payload: {} }) }));
  assert.equal(invalid.status, 400);
});
