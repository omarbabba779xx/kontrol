import "server-only";

import type { Actor } from "@/lib/core/auth";
import { UserError, userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { DEFAULT_METHOD, validateMethod, type MethodId, type RiskMethod } from "@/lib/core/risk-method";
import { getDb } from "@/lib/db";

const db = async (tenantId: string) => (await getDb()).scope(tenantId);

/** The method the organisation approved, or the built-in default (which is reported as not approved). */
export async function riskMethod(tenantId: string): Promise<RiskMethod> {
  const row = await (
    await db(tenantId)
  ).get<{ method: MethodId; threshold_medium: number; threshold_high: number; threshold_critical: number; appetite: RiskMethod["appetite"]; max_acceptance_days: number; scales_json: string; version: number; approved_by: string; approved_at: string }>(
    "SELECT * FROM risk_methods WHERE tenant_id = ?",
    tenantId,
  );
  if (!row) return DEFAULT_METHOD;
  const scales = JSON.parse(row.scales_json) as Pick<RiskMethod, "likelihoodLabels" | "impactLabels" | "impactCriteria" | "appetiteLevel" | "impactCriteriaByDimension">;
  return {
    method: row.method,
    thresholds: { medium: Number(row.threshold_medium), high: Number(row.threshold_high), critical: Number(row.threshold_critical) },
    appetite: row.appetite,
    maxAcceptanceDays: Number(row.max_acceptance_days),
    ...scales,
    version: Number(row.version),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

/**
 * Sets the risk method. It is a management decision, so only an administrator can take it, and it is recorded with its version.
 * Existing risks are re-rated by the new criteria at once (ratings are computed, not stored), and standing acceptances are kept:
 * the acceptance list shows any that now sit above the new appetite.
 */
export async function setRiskMethod(actor: Actor, input: Pick<RiskMethod, "method" | "thresholds" | "appetite" | "maxAcceptanceDays"> & Partial<Pick<RiskMethod, "likelihoodLabels" | "impactLabels" | "impactCriteria" | "appetiteLevel" | "impactCriteriaByDimension">>) {
  if (actor.role !== "admin") throw new UserError("Only an administrator can set the risk method: it is a management decision", 403);
  const next = { ...input, likelihoodLabels: input.likelihoodLabels ?? DEFAULT_METHOD.likelihoodLabels, impactLabels: input.impactLabels ?? DEFAULT_METHOD.impactLabels, impactCriteria: input.impactCriteria ?? DEFAULT_METHOD.impactCriteria };
  const problem = validateMethod(next);
  if (problem) throw userError(problem);
  const previous = await riskMethod(actor.tenantId);
  const version = previous.version + 1;
  const now = new Date().toISOString();
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO risk_methods (tenant_id,method,threshold_medium,threshold_high,threshold_critical,appetite,max_acceptance_days,scales_json,version,approved_by,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id) DO UPDATE SET method = excluded.method, threshold_medium = excluded.threshold_medium, threshold_high = excluded.threshold_high, threshold_critical = excluded.threshold_critical, appetite = excluded.appetite, max_acceptance_days = excluded.max_acceptance_days, scales_json = excluded.scales_json, version = excluded.version, approved_by = excluded.approved_by, approved_at = excluded.approved_at`,
      actor.tenantId, next.method, next.thresholds.medium, next.thresholds.high, next.thresholds.critical, next.appetite, next.maxAcceptanceDays,
      JSON.stringify({ likelihoodLabels: next.likelihoodLabels, impactLabels: next.impactLabels, impactCriteria: next.impactCriteria, impactCriteriaByDimension: next.impactCriteriaByDimension, appetiteLevel: next.method === "nist_800_30" ? next.appetiteLevel : undefined }), version, actor.userId, now,
    );
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "risk.method_set", objectType: "risk_method", objectId: actor.tenantId, payload: { version, method: next.method, thresholds: next.thresholds, appetite: next.appetite, appetiteLevel: next.appetiteLevel ?? null, maxAcceptanceDays: next.maxAcceptanceDays, previous: { method: previous.method, thresholds: previous.thresholds, appetite: previous.appetite } } }, tx);
  });
  return { version, method: next.method };
}

