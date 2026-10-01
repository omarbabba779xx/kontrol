import "server-only";

import { randomUUID } from "node:crypto";
import { AuthError, type Actor } from "@/lib/core/auth";
import { demoAuthAllowed } from "@/lib/core/config";
import { DEFAULT_USER_ID, getDb } from "@/lib/db";
import { appendAudit } from "@/lib/core/integrity";
import { syncAws, syncGitHub, syncOkta } from "@/lib/connectors";

type WorkflowKind = "continuous_control" | "ai_release" | "regulatory_change";
type WorkflowRow = { id: string; tenant_id: string; kind: WorkflowKind; state: string; current_step: string; payload_json: string; attempts: number; next_run_at: string | null; approval_token: string | null; created_at: string; updated_at: string };

const steps: Record<WorkflowKind, string[]> = {
  continuous_control: ["collect", "evaluate", "open_or_close_finding", "complete"],
  ai_release: ["inventory", "classify", "evaluate", "await_approval", "complete"],
  regulatory_change: ["ingest", "diff", "map_controls", "await_approval", "complete"],
};

export async function startWorkflow(actor: Actor, kind: WorkflowKind, payload: Record<string, unknown>) {
  const id = `workflow_${randomUUID()}`;
  const now = new Date().toISOString();
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run(`INSERT INTO workflows (id,tenant_id,kind,state,current_step,payload_json,attempts,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, actor.tenantId, kind, "queued", steps[kind][0], JSON.stringify({ ...payload, startedBy: actor.userId }), 0, now, now, now);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "workflow.started", objectType: "workflow", objectId: id, payload: { kind, payload } }, tx);
  });
  return getWorkflow(actor.tenantId, id);
}

export async function getWorkflow(tenantId: string, id: string) {
  return (await getDb()).scope(tenantId).get<WorkflowRow>("SELECT * FROM workflows WHERE tenant_id = ? AND id = ?", tenantId, id);
}

export async function runNextWorkflowStep(actor: Actor, workflowId: string) {
  const db = (await getDb()).scope(actor.tenantId);
  const workflow = await getWorkflow(actor.tenantId, workflowId);
  if (!workflow) throw new Error("Workflow not found");
  if (["completed", "failed", "awaiting_approval"].includes(workflow.state)) return workflow;
  const sequence = steps[workflow.kind];
  const index = sequence.indexOf(workflow.current_step);
  const payload = JSON.parse(workflow.payload_json) as Record<string, unknown>;
  const now = new Date().toISOString();
  await db.run("UPDATE workflows SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", now, workflow.id);

  try {
    let stepResult: unknown = { skipped: false };
    if (workflow.kind === "continuous_control" && workflow.current_step === "collect") {
      const connector = String(payload.connector ?? "github");
      if (connector === "github") stepResult = await syncGitHub(actor, { owner: String(payload.owner ?? "acme"), repository: String(payload.repository ?? "lending-decision-service"), assetId: String(payload.assetId ?? "asset_repo_lending"), demo: Boolean(payload.demo ?? !process.env.GITHUB_TOKEN) });
      if (connector === "aws") stepResult = await syncAws(actor);
      if (connector === "okta") stepResult = await syncOkta(actor);
      payload.collection = stepResult;
    }

    const nextStep = sequence[index + 1] ?? "complete";
    const awaitingApproval = nextStep === "await_approval";
    const completed = nextStep === "complete";
    const approvalToken = awaitingApproval ? `approval:${workflow.id}:${randomUUID()}` : null;
    await db.transaction(async (tx) => {
      await tx.run("UPDATE workflows SET state = ?, current_step = ?, payload_json = ?, approval_token = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
        awaitingApproval ? "awaiting_approval" : completed ? "completed" : "queued", nextStep, JSON.stringify(payload), approvalToken, awaitingApproval || completed ? null : now, now, workflow.id);
      await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "workflow.step_completed", objectType: "workflow", objectId: workflow.id, payload: { step: workflow.current_step, nextStep, result: stepResult } }, tx);
    });
  } catch (error) {
    const attempts = workflow.attempts + 1;
    const failed = attempts >= 3;
    const nextRun = failed ? null : new Date(Date.now() + Math.min(60_000, 2 ** attempts * 1000)).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    await db.transaction(async (tx) => {
      await tx.run("UPDATE workflows SET state = ?, next_run_at = ?, updated_at = ?, payload_json = ? WHERE id = ?", failed ? "failed" : "queued", nextRun, now, JSON.stringify({ ...payload, lastError: message }), workflow.id);
      await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "workflow.step_failed", objectType: "workflow", objectId: workflow.id, payload: { step: workflow.current_step, attempts, failed, error: message } }, tx);
    });
  }
  return getWorkflow(actor.tenantId, workflow.id);
}

export async function approveWorkflow(actor: Actor, workflowId: string, approved: boolean, comment: string) {
  const workflow = await getWorkflow(actor.tenantId, workflowId);
  if (!workflow || workflow.state !== "awaiting_approval") throw new Error("Workflow is not awaiting approval");
  const startedBy = (JSON.parse(workflow.payload_json) as { startedBy?: string }).startedBy;
  const demoOperator = actor.userId === DEFAULT_USER_ID && demoAuthAllowed();
  if (startedBy && startedBy === actor.userId && !demoOperator) throw new AuthError("The requester cannot approve their own workflow (separation of duties)", 403);
  const payload = { ...JSON.parse(workflow.payload_json), approval: { approved, comment, reviewer: actor.userId, at: new Date().toISOString() } };
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    const changed = await tx.run("UPDATE workflows SET state = ?, current_step = ?, payload_json = ?, approval_token = NULL, updated_at = ? WHERE id = ? AND state = 'awaiting_approval'",
      approved ? "queued" : "failed", approved ? "complete" : "rejected", JSON.stringify(payload), new Date().toISOString(), workflow.id);
    if (changed.changes !== 1) throw new Error("Workflow is not awaiting approval");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: approved ? "workflow.approved" : "workflow.rejected", objectType: "workflow", objectId: workflow.id, payload: { comment } }, tx);
  });
  return getWorkflow(actor.tenantId, workflow.id);
}

export async function runDueWorkflows(actor: Actor, limit = 10) {
  const due = await (await getDb()).scope(actor.tenantId).all<{ id: string }>("SELECT id FROM workflows WHERE tenant_id = ? AND state = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY created_at LIMIT ?", actor.tenantId, new Date().toISOString(), limit);
  const results = [];
  for (const item of due) results.push(await runNextWorkflowStep(actor, item.id));
  return results;
}
