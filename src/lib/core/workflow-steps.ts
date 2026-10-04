import "server-only";

import { assertLiveCredentials, syncConnector, type PolledConnector, type SyncParams } from "@/lib/connectors";
import { classify, type Answers } from "@/lib/core/ai-act";
import { aiSnapshot } from "@/lib/core/ai-governance";
import { UserError } from "@/lib/core/errors";
import { sha256 } from "@/lib/core/integrity";
import { ingestRegulation } from "@/lib/core/regulatory";
import { createTask, createTaskFromFinding } from "@/lib/core/tasks";
import { getDb } from "@/lib/db";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { baseControls } from "@/lib/frameworks/mapping";
import { type FrameworkId } from "@/lib/frameworks/types";
import { UC_BY_CODE } from "@/lib/frameworks/unified";
import type { Context, Outcome, Payload } from "@/lib/core/workflow-engine";

const db = async (tenantId: string) => (await getDb()).scope(tenantId);

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

/** One handler per step, keyed `kind:step`. */
export const handlers: Record<string, (ctx: Context) => Promise<Outcome>> = {
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
