import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { classify, type Answers } from "@/lib/core/ai-act";
import { aiSnapshot, approveUseCase } from "@/lib/core/ai-governance";
import { AuthError, type Actor } from "@/lib/core/auth";
import { demoAuthAllowed } from "@/lib/core/config";
import { UserError, userError } from "@/lib/core/errors";
import { appendAudit, canonicalJson, sha256 } from "@/lib/core/integrity";
import { log } from "@/lib/core/log";
import { ingestRegulation } from "@/lib/core/regulatory";
import { createTask, createTaskFromFinding } from "@/lib/core/tasks";
import { assertLiveCredentials, POLLED_CONNECTORS, syncConnector, type PolledConnector, type SyncParams } from "@/lib/connectors";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { baseControls } from "@/lib/frameworks/mapping";
import { UC_BY_CODE } from "@/lib/frameworks/unified";
import type { FrameworkId } from "@/lib/frameworks/types";
import { DEFAULT_USER_ID, getDb } from "@/lib/db";

/**
 * Workflows that do the work their steps name. Every step has declared inputs, produces an output that is stored with its hash, and
 * either succeeds, fails (and is retried), or is *blocked* with a reason: a step whose required result is missing never lets the
 * workflow move on. Steps are written to be safe to run again, because a crash between a step's effect and its record repeats the
 * step on resumption: ingest deduplicates by content hash, tasks by their source, approvals by their state.
 *
 * Execution: one runner claims a workflow atomically (state `queued` to `running` with a lease), a stalled claim is released after
 * the lease, each attempt is recorded in `workflow_steps`, failures back off and stop after three attempts, and a workflow can be
 * cancelled while it is waiting. Whoever started a workflow cannot approve it.
 */
export type WorkflowKind = "continuous_control" | "ai_release" | "regulatory_change";
type WorkflowRow = {
  id: string;
  tenant_id: string;
  kind: WorkflowKind;
  state: string;
  current_step: string;
  payload_json: string;
  attempts: number;
  next_run_at: string | null;
  approval_token: string | null;
  claimed_at: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
};
type Payload = Record<string, unknown>;
type Outcome = {
  output: Record<string, unknown>;
  /** Stop here: the required result is missing or the subject must not proceed. */ block?: string;
  /** Nothing to approve: finish the workflow. */ finish?: boolean;
};
type Context = { actor: Actor; workflow: WorkflowRow; payload: Payload; outputs: Record<string, Record<string, unknown>> };

export const STEPS: Record<WorkflowKind, string[]> = {
  continuous_control: ["collect", "evaluate", "open_or_close_finding", "complete"],
  ai_release: ["inventory", "classify", "evaluate", "await_approval", "complete"],
  regulatory_change: ["ingest", "diff", "map_controls", "await_approval", "complete"],
};
export const LEASE_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 3;
const STEP_TIMEOUT_MS = 120_000;
const TERMINAL = ["completed", "failed", "cancelled"];

const startSchemas: Record<WorkflowKind, z.ZodType<Payload>> = {
  continuous_control: z
    .object({
      connector: z.enum(POLLED_CONNECTORS),
      owner: z.string().min(1).max(100).optional(),
      repository: z.string().min(1).max(100).optional(),
      project: z.string().min(1).max(300).optional(),
      assetId: z.string().min(3).optional(),
      demo: z.boolean().optional(),
      idempotencyKey: z.string().min(8).max(120).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.connector === "github" && (!value.owner || !value.repository))
        ctx.addIssue({ code: "custom", message: "GitHub needs an owner and a repository" });
      if (value.connector === "gitlab" && !value.project) ctx.addIssue({ code: "custom", message: "GitLab needs a project path" });
    }) as never,
  ai_release: z.object({ useCaseId: z.string().min(3), idempotencyKey: z.string().min(8).max(120).optional() }) as never,
  regulatory_change: z.object({
    framework: z.string().min(2),
    citation: z.string().min(2),
    title: z.string().min(3),
    text: z.string().min(20).max(100_000),
    sourceUrl: z.string().url(),
    effectiveFrom: z.string().date().optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
  }) as never,
};

const db = async (tenantId: string) => (await getDb()).scope(tenantId);

export async function startWorkflow(actor: Actor, kind: WorkflowKind, rawPayload: Payload) {
  const parsed = startSchemas[kind].safeParse(rawPayload);
  if (!parsed.success)
    throw userError(
      `Invalid ${kind} workflow: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "payload"} ${issue.message}`).join("; ")}`,
    );
  const payload = parsed.data;
  const key = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : null;
  const scope = await db(actor.tenantId);
  if (key) {
    const existing = await scope.get<WorkflowRow>(
      "SELECT * FROM workflows WHERE tenant_id = ? AND idempotency_key = ?",
      actor.tenantId,
      key,
    );
    if (existing) return existing;
  }
  const id = `workflow_${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await scope.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO workflows (id,tenant_id,kind,state,current_step,payload_json,attempts,next_run_at,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        id,
        actor.tenantId,
        kind,
        "queued",
        STEPS[kind][0],
        JSON.stringify({ ...payload, startedBy: actor.userId }),
        0,
        now,
        key,
        now,
        now,
      );
      await appendAudit(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "workflow.started",
          objectType: "workflow",
          objectId: id,
          payload: {
            kind,
            payload: {
              ...payload,
              text: typeof payload.text === "string" ? `[${payload.text.length} characters, sha256 ${sha256(payload.text)}]` : undefined,
            },
          },
        },
        tx,
      );
    });
  } catch (error) {
    // Two requests with the same key raced: the unique index let one through; answer with that one.
    const winner = key
      ? await scope.get<WorkflowRow>("SELECT * FROM workflows WHERE tenant_id = ? AND idempotency_key = ?", actor.tenantId, key)
      : undefined;
    if (winner) return winner;
    throw error;
  }
  return getWorkflow(actor.tenantId, id);
}

export async function getWorkflow(tenantId: string, id: string) {
  return (await getDb()).scope(tenantId).get<WorkflowRow>("SELECT * FROM workflows WHERE tenant_id = ? AND id = ?", tenantId, id);
}

/** The workflow with the full record of every attempt of every step: what ran, with what result, and how it failed. */
export async function workflowDetail(tenantId: string, id: string) {
  const scope = await db(tenantId);
  const workflow = await getWorkflow(tenantId, id);
  if (!workflow) throw userError("Workflow not found");
  const steps = await scope.all<{
    step: string;
    attempt: number;
    status: string;
    started_at: string;
    finished_at: string;
    output_json: string;
    output_sha256: string;
    error: string | null;
  }>(
    "SELECT step, attempt, status, started_at, finished_at, output_json, output_sha256, error FROM workflow_steps WHERE tenant_id = ? AND workflow_id = ? ORDER BY started_at, attempt",
    tenantId,
    id,
  );
  return {
    workflow,
    steps: steps.map((item) => ({
      step: item.step,
      attempt: item.attempt,
      status: item.status,
      startedAt: item.started_at,
      finishedAt: item.finished_at,
      output: JSON.parse(item.output_json) as Record<string, unknown>,
      outputSha256: item.output_sha256,
      error: item.error,
    })),
  };
}

/* ------------------------------------------------------------ step handlers ------------------------------------------------------------ */

const connectorParams = (payload: Payload): SyncParams => ({
  owner: payload.owner as string | undefined,
  repository: payload.repository as string | undefined,
  project: payload.project as string | undefined,
  assetId: payload.assetId as string | undefined,
  demo: payload.demo === true,
});

async function evidenceSince(ctx: Context, controlCodes: string[], since: string) {
  if (!controlCodes.length) return {} as Record<string, string>;
  const scope = await db(ctx.actor.tenantId);
  const rows = await scope.all<{ code: string; id: string }>(
    `SELECT c.code AS code, e.id AS id FROM evidence e JOIN controls c ON c.id = e.control_id WHERE e.tenant_id = ? AND e.collected_at >= ? AND c.code IN (${controlCodes.map(() => "?").join(",")}) ORDER BY e.collected_at`,
    ctx.actor.tenantId,
    since,
    ...controlCodes,
  );
  return Object.fromEntries(rows.map((row) => [row.code, row.id]));
}

const handlers: Record<string, (ctx: Context) => Promise<Outcome>> = {
  /* ---- continuous_control ---- */
  async "continuous_control:collect"(ctx) {
    const kind = ctx.payload.connector as PolledConnector;
    const params = connectorParams(ctx.payload);
    // A live collection needs stored credentials. Sample data is used only when the workflow was started in sample mode on purpose.
    if (!params.demo) await assertLiveCredentials(ctx.actor, kind, params);
    const startedAt = new Date().toISOString();
    const result = await syncConnector(ctx.actor, kind, params);
    const evidence = await evidenceSince(
      ctx,
      result.evaluations.map((item) => item.controlCode),
      startedAt,
    );
    const output = {
      connector: kind,
      mode: result.mode,
      collectedAt: result.collectedAt,
      evaluations: result.evaluations.map((item) => ({
        controlCode: item.controlCode,
        passed: item.passed,
        findingId: Array.isArray(item.finding) ? null : item.finding,
        closedFindingIds: Array.isArray(item.finding) ? item.finding : [],
        evidenceId: evidence[item.controlCode] ?? null,
      })),
      skipped: result.skipped,
      notApplicable: result.notApplicable ?? [],
    };
    if (!result.evaluations.length)
      return {
        output,
        block: `No control could be evaluated${result.skipped.length ? `: ${result.skipped.map((item) => `${item.controlCode} needs ${item.missing.join(", ")}`).join("; ")}` : ""}. Check the permissions of the credential.`,
      };
    return { output };
  },
  async "continuous_control:evaluate"(ctx) {
    const collection = ctx.outputs.collect as
      | { evaluations?: Array<{ controlCode: string; passed: boolean; evidenceId: string | null }>; skipped?: unknown[]; mode?: string }
      | undefined;
    if (!collection?.evaluations) return { output: {}, block: "The collection produced no result to evaluate" };
    const failed = collection.evaluations.filter((item) => !item.passed);
    return {
      output: {
        mode: collection.mode,
        evaluated: collection.evaluations.length,
        passed: collection.evaluations.length - failed.length,
        failed: failed.map((item) => ({ controlCode: item.controlCode, evidenceId: item.evidenceId })),
        skipped: collection.skipped?.length ?? 0,
      },
    };
  },
  async "continuous_control:open_or_close_finding"(ctx) {
    const collection = ctx.outputs.collect as {
      evaluations: Array<{ controlCode: string; passed: boolean; findingId: string | null; closedFindingIds: string[] }>;
    };
    const tasks: Array<{ findingId: string; created: boolean }> = [];
    for (const item of collection.evaluations.filter((entry) => !entry.passed && entry.findingId)) {
      try {
        await createTaskFromFinding(ctx.actor, item.findingId!);
        tasks.push({ findingId: item.findingId!, created: true });
      } catch (error) {
        if (error instanceof UserError && /open task already exists/i.test(error.message))
          tasks.push({ findingId: item.findingId!, created: false });
        else throw error;
      }
    }
    const closed = collection.evaluations.flatMap((entry) => entry.closedFindingIds);
    return {
      output: {
        findingsOpen: collection.evaluations.filter((entry) => !entry.passed).length,
        findingsClosed: closed.length,
        closedFindingIds: closed,
        tasks,
      },
    };
  },
  async "continuous_control:complete"(ctx) {
    const evaluated = ctx.outputs.evaluate ?? {};
    return { output: { passed: evaluated.passed ?? 0, failed: Array.isArray(evaluated.failed) ? evaluated.failed.length : 0 } };
  },

  /* ---- ai_release ---- */
  async "ai_release:inventory"(ctx) {
    const useCase = (await aiSnapshot(ctx.actor.tenantId)).useCases.find((item) => item.id === ctx.payload.useCaseId);
    if (!useCase) return { output: {}, block: "The AI system to release does not exist in the register" };
    if (useCase.status === "retired") return { output: { ref: useCase.ref }, block: "The AI system is retired" };
    if (!useCase.ownerId) return { output: { ref: useCase.ref }, block: "The AI system has no owner: assign one before releasing it" };
    return {
      output: {
        useCaseId: useCase.id,
        ref: useCase.ref,
        name: useCase.name,
        role: useCase.role,
        ownerId: useCase.ownerId,
        status: useCase.status,
        modelCardVersion: useCase.modelCard?.version ?? null,
        impactAssessment: useCase.fria?.status ?? null,
      },
    };
  },
  async "ai_release:classify"(ctx) {
    const useCase = (await aiSnapshot(ctx.actor.tenantId)).useCases.find((item) => item.id === ctx.payload.useCaseId);
    if (!useCase?.tier || !useCase.classification)
      return { output: {}, block: "The AI system has not been classified: run the classification first" };
    const fresh = classify({ ...(useCase.answers as Answers), role: useCase.role as Answers["role"] });
    if (fresh.tier !== useCase.tier)
      return {
        output: { recorded: useCase.tier, recomputed: fresh.tier },
        block: `The recorded classification (${useCase.tier}) no longer matches the answers (${fresh.tier}): classify again`,
      };
    if (fresh.tier === "prohibited")
      return { output: { tier: fresh.tier, reasons: fresh.reasons }, block: "A prohibited AI practice cannot be released" };
    return {
      output: {
        tier: fresh.tier,
        friaRequired: fresh.friaRequired,
        obligations: fresh.obligations.map((item) => ({ id: item.id, article: item.article, ucCode: item.ucCode })),
        reasons: fresh.reasons,
        needsLegalReview: fresh.needsLegalReview,
      },
    };
  },
  async "ai_release:evaluate"(ctx) {
    const useCase = (await aiSnapshot(ctx.actor.tenantId)).useCases.find((item) => item.id === ctx.payload.useCaseId);
    const classification = ctx.outputs.classify as { tier: string; friaRequired: boolean } | undefined;
    if (!useCase || !classification) return { output: {}, block: "The classification is missing" };
    const blocking: string[] = [];
    if ((classification.tier === "high" || useCase.classification?.gpai.provider) && !useCase.modelCard)
      blocking.push("A model card is required");
    if (classification.friaRequired && useCase.fria?.status !== "completed")
      blocking.push("A completed fundamental rights impact assessment is required");
    if (classification.friaRequired && useCase.fria?.status === "completed" && !useCase.fria.reviewedBy)
      blocking.push("The impact assessment has not been reviewed");
    const gaps = useCase.obligations
      .filter((item) => item.state !== "met")
      .map((item) => ({ article: item.article, title: item.title, ucCode: item.ucCode, state: item.state }));
    const weak = useCase.obligations.filter((item) => item.weight < 0.5).map((item) => item.ucCode);
    if (classification.tier === "high" && weak.length)
      blocking.push(`Controls not yet partially implemented: ${[...new Set(weak)].join(", ")}`);
    const output = { readiness: useCase.readiness, obligations: useCase.obligations.length, gaps, blocking };
    return blocking.length ? { output, block: blocking.join("; ") } : { output };
  },
  async "ai_release:complete"(ctx) {
    const useCase = (await aiSnapshot(ctx.actor.tenantId)).useCases.find((item) => item.id === ctx.payload.useCaseId);
    return { output: { ref: useCase?.ref ?? null, status: useCase?.status ?? null, approvedBy: useCase?.approvedBy ?? null } };
  },

  /* ---- regulatory_change ---- */
  async "regulatory_change:ingest"(ctx) {
    const { framework, citation, title, text, sourceUrl, effectiveFrom } = ctx.payload as {
      framework: string;
      citation: string;
      title: string;
      text: string;
      sourceUrl: string;
      effectiveFrom?: string;
    };
    try {
      const result = await ingestRegulation(ctx.actor, { framework, citation, title, text, sourceUrl, effectiveFrom });
      return {
        output: {
          obligationId: result.id,
          duplicate: result.duplicate,
          versionHash: sha256(text),
          candidateMappings: "candidateMappings" in result ? (result.candidateMappings?.length ?? 0) : 0,
        },
      };
    } catch (error) {
      // An unapproved source is a decision, not a glitch: retrying changes nothing.
      if (error instanceof Error && /not approved/i.test(error.message)) return { output: { sourceUrl }, block: error.message };
      throw error;
    }
  },
  async "regulatory_change:diff"(ctx) {
    const ingest = ctx.outputs.ingest as { obligationId?: string; duplicate?: boolean } | undefined;
    if (!ingest?.obligationId) return { output: {}, block: "Nothing was ingested to compare" };
    // The same text (same hash) was already on record: there is no change to review.
    if (ingest.duplicate)
      return { output: { unchanged: true, firstVersion: false, material: false, added: [], removed: [], similarity: 1 }, finish: true };
    const scope = await db(ctx.actor.tenantId);
    const current = await scope.get<{ id: string; framework: string; citation: string; text: string; recorded_at: string }>(
      "SELECT id, framework, citation, text, recorded_at FROM obligations WHERE tenant_id = ? AND id = ?",
      ctx.actor.tenantId,
      ingest.obligationId,
    );
    if (!current) return { output: {}, block: "The ingested obligation cannot be found" };
    const previous = await scope.get<{ id: string; text: string }>(
      "SELECT id, text FROM obligations WHERE tenant_id = ? AND framework = ? AND citation = ? AND recorded_at < ? ORDER BY recorded_at DESC LIMIT 1",
      ctx.actor.tenantId,
      current.framework,
      current.citation,
      current.recorded_at,
    );
    if (!previous)
      return { output: { previousObligationId: null, firstVersion: true, material: true, added: [], removed: [], similarity: null } };
    const words = (value: string) =>
      new Set(
        value
          .toLowerCase()
          .replace(/[^a-z0-9à-ÿ]+/g, " ")
          .split(/\s+/)
          .filter((word) => word.length > 3),
      );
    const before = words(previous.text),
      after = words(current.text);
    const added = [...after].filter((word) => !before.has(word)),
      removed = [...before].filter((word) => !after.has(word));
    const similarity =
      Math.round(([...after].filter((word) => before.has(word)).length / Math.max(1, new Set([...before, ...after]).size)) * 1000) / 1000;
    const material = added.length + removed.length > 0 && similarity < 0.98;
    // An unchanged text needs no review: the workflow finishes here instead of asking someone to approve nothing.
    return {
      output: {
        previousObligationId: previous.id,
        firstVersion: false,
        material,
        added: added.slice(0, 50),
        removed: removed.slice(0, 50),
        similarity,
      },
      finish: !material,
    };
  },
  async "regulatory_change:map_controls"(ctx) {
    const { framework, citation } = ctx.payload as { framework: string; citation: string };
    const ingest = ctx.outputs.ingest as { obligationId: string };
    const scope = await db(ctx.actor.tenantId);
    // Published crosswalk first (a framework we model, a requirement id we know); then the tenant's own controls that share vocabulary.
    const published = FRAMEWORK_BY_ID.has(framework as FrameworkId) ? baseControls(framework as FrameworkId, citation) : [];
    const edges = await scope.all<{ target_id: string; confidence: number }>(
      "SELECT target_id, confidence FROM graph_edges WHERE tenant_id = ? AND source_type = 'obligation' AND source_id = ? AND relation = 'candidate_mapping' AND valid_to IS NULL ORDER BY confidence DESC",
      ctx.actor.tenantId,
      ingest.obligationId,
    );
    const candidates = edges.length
      ? await scope.all<{ id: string; code: string }>(
          `SELECT id, code FROM controls WHERE tenant_id = ? AND id IN (${edges.map(() => "?").join(",")})`,
          ctx.actor.tenantId,
          ...edges.map((edge) => edge.target_id),
        )
      : [];
    const output = {
      unifiedControls: published
        .filter((code) => UC_BY_CODE.has(code))
        .map((code) => ({ code, title: UC_BY_CODE.get(code)!.title, basis: "published crosswalk" })),
      candidateControls: candidates.map((control) => ({
        code: control.code,
        confidence: edges.find((edge) => edge.target_id === control.id)?.confidence ?? 0,
        basis: "shared vocabulary (to be confirmed)",
      })),
    };
    return output.unifiedControls.length || output.candidateControls.length
      ? { output }
      : {
          output,
          block: "No control could be mapped to this requirement: map it by hand in the compliance hub, then start the workflow again",
        };
  },
  async "regulatory_change:complete"(ctx) {
    const mapped = ctx.outputs.map_controls as { unifiedControls?: Array<{ code: string; title: string }> } | undefined;
    const scope = await db(ctx.actor.tenantId);
    const tasks: Array<{ ucCode: string; created: boolean }> = [];
    // One review task per affected control. Resuming never duplicates: the task is looked up by its source first.
    for (const control of mapped?.unifiedControls ?? []) {
      const existing = await scope.get(
        "SELECT id FROM tasks WHERE tenant_id = ? AND source_type = 'regulatory_change' AND source_id = ? AND uc_code = ?",
        ctx.actor.tenantId,
        ctx.workflow.id,
        control.code,
      );
      if (existing) {
        tasks.push({ ucCode: control.code, created: false });
        continue;
      }
      await createTask(ctx.actor, {
        title: `Review ${control.code} after a regulatory change`,
        description: `${String(ctx.payload.framework)} ${String(ctx.payload.citation)} changed. Confirm that ${control.title} still meets it, and update the attestation.`,
        priority: "medium",
        sourceType: "regulatory_change",
        sourceId: ctx.workflow.id,
        ucCode: control.code,
        dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });
      tasks.push({ ucCode: control.code, created: true });
    }
    return { output: { tasks } };
  },
};

/* ------------------------------------------------------------ execution ------------------------------------------------------------ */

const withTimeout = <T>(work: Promise<T>) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The step did not finish within ${STEP_TIMEOUT_MS / 1000} seconds`)), STEP_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

async function stepOutputs(tenantId: string, workflowId: string) {
  const rows = await (
    await db(tenantId)
  ).all<{ step: string; output_json: string }>(
    "SELECT step, output_json FROM workflow_steps WHERE tenant_id = ? AND workflow_id = ? AND status = 'ok' ORDER BY started_at",
    tenantId,
    workflowId,
  );
  return Object.fromEntries(rows.map((row) => [row.step, JSON.parse(row.output_json) as Record<string, unknown>]));
}

export async function runNextWorkflowStep(actor: Actor, workflowId: string) {
  const scope = await db(actor.tenantId);
  const current = await getWorkflow(actor.tenantId, workflowId);
  if (!current) throw userError("Workflow not found");
  if (TERMINAL.includes(current.state) || current.state === "awaiting_approval") return current;

  // Atomic claim: only one runner moves a queued workflow to running; the others see it taken and leave it alone.
  const now = new Date().toISOString();
  const claim = await scope.run(
    "UPDATE workflows SET state = 'running', claimed_at = ?, attempts = attempts + 1, updated_at = ? WHERE tenant_id = ? AND id = ? AND state = 'queued'",
    now,
    now,
    actor.tenantId,
    workflowId,
  );
  if (claim.changes !== 1) return getWorkflow(actor.tenantId, workflowId);
  const workflow = (await getWorkflow(actor.tenantId, workflowId))!;

  const sequence = STEPS[workflow.kind];
  const step = workflow.current_step;
  const index = sequence.indexOf(step);
  const payload = JSON.parse(workflow.payload_json) as Payload;
  const started = new Date().toISOString();
  const handler = handlers[`${workflow.kind}:${step}`];

  try {
    if (!handler || index < 0) throw new Error(`Step ${step} is not defined for ${workflow.kind}`);
    const outputs = await stepOutputs(actor.tenantId, workflow.id);
    // Resumption: a step that already succeeded is not run again, its recorded output is reused.
    const recorded = outputs[step];
    const outcome: Outcome = recorded ? { output: recorded } : await withTimeout(handler({ actor, workflow, payload, outputs }));
    const finished = new Date().toISOString();
    const serialised = canonicalJson(outcome.output);

    if (outcome.block) {
      await scope.transaction(async (tx) => {
        await tx.run(
          "INSERT INTO workflow_steps (id,tenant_id,workflow_id,step,attempt,status,started_at,finished_at,output_json,output_sha256,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          `wfs_${randomUUID()}`,
          actor.tenantId,
          workflow.id,
          step,
          workflow.attempts,
          "blocked",
          started,
          finished,
          serialised,
          sha256(serialised),
          outcome.block,
        );
        await tx.run(
          "UPDATE workflows SET state = 'failed', claimed_at = NULL, next_run_at = NULL, payload_json = ?, updated_at = ? WHERE id = ?",
          JSON.stringify({ ...payload, blockedAt: step, blockedReason: outcome.block }),
          finished,
          workflow.id,
        );
        await appendAudit(
          {
            tenantId: actor.tenantId,
            actorId: actor.userId,
            action: "workflow.step_blocked",
            objectType: "workflow",
            objectId: workflow.id,
            payload: { step, reason: outcome.block, outputSha256: sha256(serialised) },
          },
          tx,
        );
      });
      log.warn("workflow.blocked", { tenantId: actor.tenantId, workflowId: workflow.id, kind: workflow.kind, step, reason: outcome.block });
      return getWorkflow(actor.tenantId, workflow.id);
    }

    const nextStep = outcome.finish ? "complete" : (sequence[index + 1] ?? "complete");
    const awaitingApproval = nextStep === "await_approval";
    const completed = step === "complete";
    const approvalToken = awaitingApproval ? `approval:${workflow.id}:${randomUUID()}` : null;
    await scope.transaction(async (tx) => {
      if (!recorded)
        await tx.run(
          "INSERT INTO workflow_steps (id,tenant_id,workflow_id,step,attempt,status,started_at,finished_at,output_json,output_sha256,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          `wfs_${randomUUID()}`,
          actor.tenantId,
          workflow.id,
          step,
          workflow.attempts,
          "ok",
          started,
          finished,
          serialised,
          sha256(serialised),
          null,
        );
      const state = completed ? "completed" : awaitingApproval ? "awaiting_approval" : "queued";
      await tx.run(
        "UPDATE workflows SET state = ?, current_step = ?, approval_token = ?, claimed_at = NULL, next_run_at = ?, updated_at = ? WHERE id = ?",
        state,
        completed ? "complete" : nextStep,
        approvalToken,
        state === "queued" ? finished : null,
        finished,
        workflow.id,
      );
      await appendAudit(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "workflow.step_completed",
          objectType: "workflow",
          objectId: workflow.id,
          payload: { step, nextStep: completed ? null : nextStep, outputSha256: sha256(serialised), resumed: Boolean(recorded) },
        },
        tx,
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = workflow.attempts >= MAX_ATTEMPTS;
    const finished = new Date().toISOString();
    const nextRun = failed ? null : new Date(Date.now() + Math.min(60_000, 2 ** workflow.attempts * 1000)).toISOString();
    await scope.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO workflow_steps (id,tenant_id,workflow_id,step,attempt,status,started_at,finished_at,output_json,output_sha256,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        `wfs_${randomUUID()}`,
        actor.tenantId,
        workflow.id,
        step,
        workflow.attempts,
        "failed",
        started,
        finished,
        "{}",
        sha256("{}"),
        message.slice(0, 500),
      );
      await tx.run(
        "UPDATE workflows SET state = ?, claimed_at = NULL, next_run_at = ?, updated_at = ?, payload_json = ? WHERE id = ?",
        failed ? "failed" : "queued",
        nextRun,
        finished,
        JSON.stringify({ ...payload, lastError: message.slice(0, 500) }),
        workflow.id,
      );
      await appendAudit(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "workflow.step_failed",
          objectType: "workflow",
          objectId: workflow.id,
          payload: { step, attempt: workflow.attempts, failed, error: message.slice(0, 500) },
        },
        tx,
      );
    });
    log.warn("workflow.step_failed", {
      tenantId: actor.tenantId,
      workflowId: workflow.id,
      kind: workflow.kind,
      step,
      attempt: workflow.attempts,
      final: failed,
      error: message,
    });
  }
  return getWorkflow(actor.tenantId, workflow.id);
}

/** Releases workflows whose runner disappeared (a crash, a restart): after the lease they go back to the queue and resume at the same step. */
export async function recoverStalledWorkflows(actor: Actor, now = Date.now()) {
  const scope = await db(actor.tenantId);
  const stalled = await scope.all<{ id: string }>(
    "SELECT id FROM workflows WHERE tenant_id = ? AND state = 'running' AND claimed_at < ?",
    actor.tenantId,
    new Date(now - LEASE_MS).toISOString(),
  );
  let recovered = 0;
  for (const item of stalled) {
    const changed = await scope.run(
      "UPDATE workflows SET state = 'queued', claimed_at = NULL, next_run_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND state = 'running' AND claimed_at < ?",
      new Date(now).toISOString(),
      new Date(now).toISOString(),
      actor.tenantId,
      item.id,
      new Date(now - LEASE_MS).toISOString(),
    );
    if (changed.changes === 1) {
      recovered += 1;
      await appendAudit({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "workflow.recovered",
        objectType: "workflow",
        objectId: item.id,
        payload: { reason: "the runner stopped without finishing" },
      });
      log.warn("workflow.recovered", { tenantId: actor.tenantId, workflowId: item.id });
    }
  }
  return recovered;
}

export async function cancelWorkflow(actor: Actor, workflowId: string, reason: string) {
  const scope = await db(actor.tenantId);
  const workflow = await getWorkflow(actor.tenantId, workflowId);
  if (!workflow) throw userError("Workflow not found");
  if (TERMINAL.includes(workflow.state)) throw userError(`This workflow is already ${workflow.state}`);
  if (workflow.state === "running")
    throw userError("This workflow is being executed right now: cancel it once the step ends, or wait for the lease to expire");
  await scope.transaction(async (tx) => {
    const changed = await tx.run(
      "UPDATE workflows SET state = 'cancelled', approval_token = NULL, next_run_at = NULL, updated_at = ?, payload_json = ? WHERE id = ? AND state IN ('queued','awaiting_approval')",
      new Date().toISOString(),
      JSON.stringify({ ...JSON.parse(workflow.payload_json), cancelledBy: actor.userId, cancelReason: reason }),
      workflow.id,
    );
    if (changed.changes !== 1) throw userError("This workflow changed while you were cancelling it (already running)");
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "workflow.cancelled",
        objectType: "workflow",
        objectId: workflow.id,
        payload: { reason, step: workflow.current_step },
      },
      tx,
    );
  });
  return getWorkflow(actor.tenantId, workflow.id);
}

export async function approveWorkflow(actor: Actor, workflowId: string, approved: boolean, comment: string) {
  const workflow = await getWorkflow(actor.tenantId, workflowId);
  if (!workflow || workflow.state !== "awaiting_approval") throw userError("Workflow is not awaiting approval");
  const payload = JSON.parse(workflow.payload_json) as Payload;
  const startedBy = payload.startedBy as string | undefined;
  const demoOperator = actor.userId === DEFAULT_USER_ID && demoAuthAllowed();
  if (startedBy && startedBy === actor.userId && !demoOperator)
    throw new AuthError("The requester cannot approve their own workflow (separation of duties)", 403);

  // Releasing an AI system is the approval of that system: its own rules (owner, registrant, paperwork, controls) apply too, and if they
  // refuse, the workflow stays waiting. A second attempt after a partial failure finds the system already approved by this person.
  if (approved && workflow.kind === "ai_release") {
    const useCase = (await aiSnapshot(actor.tenantId)).useCases.find((item) => item.id === payload.useCaseId);
    if (!(useCase?.status === "approved" && useCase.approvedBy === actor.userId))
      await approveUseCase(actor, {
        id: String(payload.useCaseId),
        note: comment.length >= 10 ? comment : `${comment} (workflow ${workflow.id})`.padEnd(10, "."),
      });
  }

  const decided = { ...payload, approval: { approved, comment, reviewer: actor.userId, at: new Date().toISOString() } };
  await (
    await db(actor.tenantId)
  ).transaction(async (tx) => {
    const changed = await tx.run(
      "UPDATE workflows SET state = ?, current_step = ?, payload_json = ?, approval_token = NULL, next_run_at = ?, updated_at = ? WHERE id = ? AND state = 'awaiting_approval'",
      approved ? "queued" : "failed",
      approved ? "complete" : "rejected",
      JSON.stringify(decided),
      approved ? new Date().toISOString() : null,
      new Date().toISOString(),
      workflow.id,
    );
    if (changed.changes !== 1) throw userError("Workflow is not awaiting approval (it already changed)");
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: approved ? "workflow.approved" : "workflow.rejected",
        objectType: "workflow",
        objectId: workflow.id,
        payload: { comment },
      },
      tx,
    );
  });
  return getWorkflow(actor.tenantId, workflow.id);
}

export async function runDueWorkflows(actor: Actor, limit = 10) {
  await recoverStalledWorkflows(actor);
  const due = await (
    await db(actor.tenantId)
  ).all<{ id: string }>(
    "SELECT id FROM workflows WHERE tenant_id = ? AND state = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY created_at LIMIT ?",
    actor.tenantId,
    new Date().toISOString(),
    limit,
  );
  const results = [];
  for (const item of due) results.push(await runNextWorkflowStep(actor, item.id));
  return results;
}
