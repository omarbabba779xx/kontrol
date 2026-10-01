import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, riskOwner, setEnv, isolateDatabase } from "./setup";

isolateDatabase();
setEnv({ NODE_ENV: "production", KONTROL_AUTH_MODE: undefined, KONTROL_ALLOW_DEMO_IN_PRODUCTION: undefined });

async function advanceToApproval(actor: typeof admin | typeof riskOwner, kind: "ai_release" | "regulatory_change") {
  const { startWorkflow, runNextWorkflowStep } = await import("../src/lib/core/workflow-engine");
  let workflow = (await startWorkflow(actor, kind, {}))!;
  for (let i = 0; i < 6 && workflow.state !== "awaiting_approval"; i++) workflow = (await runNextWorkflowStep(actor, workflow.id))!;
  assert.equal(workflow.state, "awaiting_approval");
  return workflow;
}

test("release workflows complete only after a different reviewer approves", async () => {
  const { approveWorkflow } = await import("../src/lib/core/workflow-engine");
  const workflow = await advanceToApproval(riskOwner, "ai_release");
  assert.ok(workflow.approval_token);
  await assert.rejects(approveWorkflow(riskOwner, workflow.id, true, "self approval attempt"), /separation of duties/);
  const done = (await approveWorkflow(admin, workflow.id, true, "Reviewed evidence and conditions."))!;
  assert.equal(done.state, "queued");
  assert.equal(done.approval_token, null);
});

test("rejection fails the workflow and approval cannot be replayed", async () => {
  const { approveWorkflow } = await import("../src/lib/core/workflow-engine");
  const workflow = await advanceToApproval(riskOwner, "regulatory_change");
  assert.equal((await approveWorkflow(admin, workflow.id, false, "Mapping is not justified."))!.state, "failed");
  await assert.rejects(approveWorkflow(admin, workflow.id, true, "trying again later"), /not awaiting approval/);
});

test("workflows are tenant scoped", async () => {
  const { startWorkflow, getWorkflow } = await import("../src/lib/core/workflow-engine");
  const workflow = (await startWorkflow(admin, "continuous_control", {}))!;
  assert.equal(await getWorkflow("tenant_other", workflow.id), undefined);
});

test("concurrent approvals cannot both succeed", async () => {
  const { approveWorkflow } = await import("../src/lib/core/workflow-engine");
  const workflow = await advanceToApproval(riskOwner, "ai_release");
  const results = await Promise.allSettled([approveWorkflow(admin, workflow.id, true, "First reviewer approves."), approveWorkflow(admin, workflow.id, true, "Second reviewer approves.")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
});
