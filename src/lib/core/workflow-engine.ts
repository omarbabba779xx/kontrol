import "server-only";

import { randomUUID } from "node:crypto";
import { AuthError, type Actor } from "@/lib/core/auth";
import { demoAuthAllowed } from "@/lib/core/config";
import { DEFAULT_USER_ID, getDb } from "@/lib/core/database";
import { appendAudit } from "@/lib/core/integrity";
import { syncAws, syncGitHub, syncOkta } from "@/lib/connectors";

type WorkflowKind = "continuous_control" | "ai_release" | "regulatory_change";
type WorkflowRow = { id: string; tenant_id: string; kind: WorkflowKind; state: string; current_step: string; payload_json: string; attempts: number; next_run_at: string | null; approval_token: string | null; created_at: string; updated_at: string };

const steps: Record<WorkflowKind, string[]> = {
  continuous_control: ["collect", "evaluate", "open_or_close_finding", "complete"],
  ai_release: ["inventory", "classify", "evaluate", "await_approval", "complete"],
  regulatory_change: ["ingest", "diff", "map_controls", "await_approval", "complete"],
};

export function startWorkflow(actor: Actor, kind: WorkflowKind, payload: Record<string, unknown>) {
  const id = `workflow_${randomUUID()}`;
  const now = new Date().toISOString();
  getDb().prepare(`INSERT INTO workflows (id,tenant_id,kind,state,current_step,payload_json,attempts,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, actor.tenantId, kind, "queued", steps[kind][0], JSON.stringify({ ...payload, startedBy: actor.userId }), 0, now, now, now,
  );
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "workflow.started", objectType: "workflow", objectId: id, payload: { kind, payload } });
  return getWorkflow(actor.tenantId, id);
}

export function getWorkflow(tenantId: string, id: string) {
  return getDb().prepare("SELECT * FROM workflows WHERE tenant_id = ? AND id = ?").get(tenantId, id) as WorkflowRow | undefined;
}

export async function runNextWorkflowStep(actor: Actor, workflowId: string) {
  const db = getDb();
  const workflow = getWorkflow(actor.tenantId, workflowId);
  if (!workflow) throw new Error("Workflow not found");
  if (["completed", "failed", "awaiting_approval"].includes(workflow.state)) return workflow;
  const sequence = steps[workflow.kind];
  const index = sequence.indexOf(workflow.current_step);
  const payload = JSON.parse(workflow.payload_json) as Record<string, unknown>;
  const now = new Date().toISOString();
  db.prepare("UPDATE workflows SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now, workflow.id);

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
    db.prepare("UPDATE workflows SET state = ?, current_step = ?, payload_json = ?, approval_token = ?, next_run_at = ?, updated_at = ? WHERE id = ?").run(
      awaitingApproval ? "awaiting_approval" : completed ? "completed" : "queued", nextStep, JSON.stringify(payload), approvalToken, awaitingApproval || completed ? null : now, now, workflow.id,
    );
    appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "workflow.step_completed", objectType: "workflow", objectId: workflow.id, payload: { step: workflow.current_step, nextStep, result: stepResult } });
  } catch (error) {
    const attempts = workflow.attempts + 1;
    const failed = attempts >= 3;
    const nextRun = failed ? null : new Date(Date.now() + Math.min(60_000, 2 ** attempts * 1000)).toISOString();
    db.prepare("UPDATE workflows SET state = ?, next_run_at = ?, updated_at = ?, payload_json = ? WHERE id = ?").run(failed ? "failed" : "queued", nextRun, now, JSON.stringify({ ...payload, lastError: error instanceof Error ? error.message : String(error) }), workflow.id);
    appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "workflow.step_failed", objectType: "workflow", objectId: workflow.id, payload: { step: workflow.current_step, attempts, failed, error: error instanceof Error ? error.message : String(error) } });
  }
  return getWorkflow(actor.tenantId, workflow.id);
}

export function approveWorkflow(actor: Actor, workflowId: string, approved: boolean, comment: string) {
  const workflow = getWorkflow(actor.tenantId, workflowId);
  if (!workflow || workflow.state !== "awaiting_approval") throw new Error("Workflow is not awaiting approval");
  const startedBy = (JSON.parse(workflow.payload_json) as { startedBy?: string }).startedBy;
  const demoOperator = actor.userId === DEFAULT_USER_ID && demoAuthAllowed();
  if (startedBy && startedBy === actor.userId && !demoOperator) throw new AuthError("The requester cannot approve their own workflow (separation of duties)", 403);
  const payload = { ...JSON.parse(workflow.payload_json), approval: { approved, comment, reviewer: actor.userId, at: new Date().toISOString() } };
  getDb().prepare("UPDATE workflows SET state = ?, current_step = ?, payload_json = ?, approval_token = NULL, updated_at = ? WHERE id = ?").run(approved ? "queued" : "failed", approved ? "complete" : "rejected", JSON.stringify(payload), new Date().toISOString(), workflow.id);
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: approved ? "workflow.approved" : "workflow.rejected", objectType: "workflow", objectId: workflow.id, payload: { comment } });
  return getWorkflow(actor.tenantId, workflow.id);
}

export async function runDueWorkflows(actor: Actor, limit = 10) {
  const due = getDb().prepare("SELECT id FROM workflows WHERE tenant_id = ? AND state = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY created_at LIMIT ?").all(actor.tenantId, new Date().toISOString(), limit) as Array<{ id: string }>;
  const results = [];
  for (const item of due) results.push(await runNextWorkflowStep(actor, item.id));
  return results;
}
