import "server-only";

import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Actor } from "@/lib/core/auth";
import { complianceSnapshot } from "@/lib/core/compliance-engine";
import { csvCell } from "@/lib/core/compliance/statement";
import { requirementsOf } from "@/lib/frameworks/scoring";
import { UserError, userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { simulateRisk } from "@/lib/core/risk-engine";
import { bandFor, DEFAULT_METHOD, exceedsAppetite, overallLikelihood, THREAT_SOURCES, validateMethod, type MethodId, type RiskMethod, type ThreatSource } from "@/lib/core/risk-method";
import { heatMap, residual, scoreOf, type Band, type ControlEffect } from "@/lib/core/risk-rating";
import type { scenarioSchema } from "@/lib/core/schemas";
import { createTask } from "@/lib/core/tasks";
import { UC_BY_CODE } from "@/lib/frameworks/unified";
import { getDb } from "@/lib/db";

/**
 * Risk register. Risks have an inherent rating, linked unified controls, a treatment, and (when accepted) a time-boxed acceptance by
 * someone other than the owner. Residual risk is computed from the live compliance posture, so it moves when a control is attested,
 * verified, fails or lapses. A quantified estimate comes from the existing FAIR-inspired simulation and is stored as a range, never
 * as a forecast. See docs/RISK_REGISTER.md.
 */
export const CATEGORIES = ["cyber", "privacy", "third_party", "ai", "resilience", "compliance", "operational"] as const;
export const TREATMENTS = ["undecided", "mitigate", "accept", "transfer", "avoid"] as const;
type Category = (typeof CATEGORIES)[number];
type Treatment = (typeof TREATMENTS)[number];
const DAY = 86_400_000;

type RiskRow = {
  id: string;
  ref: string;
  title: string;
  description: string;
  category: Category;
  asset: string;
  owner_id: string | null;
  likelihood: number;
  impact: number;
  treatment: Treatment;
  treatment_plan: string;
  target_date: string | null;
  status: "identified" | "treating" | "accepted" | "closed";
  accepted_by: string | null;
  accepted_at: string | null;
  accepted_until: string | null;
  acceptance_note: string | null;
  fair_mean: number | null;
  fair_p90: number | null;
  fair_scenario_json: string | null;
  source_type: string;
  source_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_note: string | null;
  threat_source: ThreatSource | null;
  threat_event: string | null;
  vulnerability: string | null;
  predisposing_conditions: string | null;
  likelihood_initiation: number | null;
  likelihood_impact: number | null;
  asset_id: string | null;
};

async function db(tenantId: string) {
  return (await getDb()).scope(tenantId);
}
const inRange = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < 1 || value > 5) throw userError(`${label} must be between 1 and 5`);
};

async function owner(tenantId: string, ownerId: string | null | undefined) {
  if (!ownerId) return null;
  const user = await (
    await db(tenantId)
  ).get<{ id: string; status: string; external: number }>(
    "SELECT id, status, external FROM users WHERE tenant_id = ? AND id = ?",
    tenantId,
    ownerId,
  );
  if (!user || user.external === 1) throw userError("Owner not found");
  if (user.status !== "active") throw userError("Owner is disabled");
  return user.id;
}

/** The method the organisation approved, or the built-in default (which is reported as not approved). */
export async function riskMethod(tenantId: string): Promise<RiskMethod> {
  const row = await (
    await db(tenantId)
  ).get<{ method: MethodId; threshold_medium: number; threshold_high: number; threshold_critical: number; appetite: RiskMethod["appetite"]; max_acceptance_days: number; scales_json: string; version: number; approved_by: string; approved_at: string }>(
    "SELECT * FROM risk_methods WHERE tenant_id = ?",
    tenantId,
  );
  if (!row) return DEFAULT_METHOD;
  const scales = JSON.parse(row.scales_json) as Pick<RiskMethod, "likelihoodLabels" | "impactLabels" | "impactCriteria">;
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
export async function setRiskMethod(actor: Actor, input: Pick<RiskMethod, "method" | "thresholds" | "appetite" | "maxAcceptanceDays"> & Partial<Pick<RiskMethod, "likelihoodLabels" | "impactLabels" | "impactCriteria">>) {
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
      JSON.stringify({ likelihoodLabels: next.likelihoodLabels, impactLabels: next.impactLabels, impactCriteria: next.impactCriteria }), version, actor.userId, now,
    );
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "risk.method_set", objectType: "risk_method", objectId: actor.tenantId, payload: { version, method: next.method, thresholds: next.thresholds, appetite: next.appetite, maxAcceptanceDays: next.maxAcceptanceDays, previous: { method: previous.method, thresholds: previous.thresholds, appetite: previous.appetite } } }, tx);
  });
  return { version, method: next.method };
}

type ThreatInput = { threatSource?: ThreatSource; threatEvent?: string; vulnerability?: string; predisposingConditions?: string; likelihoodInitiation?: number; likelihoodImpact?: number; assetId?: string | null };

async function assetOf(tenantId: string, assetId: string | null | undefined) {
  if (!assetId) return null;
  const asset = await (await db(tenantId)).get<{ id: string; name: string }>("SELECT id, name FROM assets WHERE tenant_id = ? AND id = ? AND valid_to IS NULL", tenantId, assetId);
  if (!asset) throw userError("Asset not found");
  return asset;
}

function checkCodes(codes: string[]) {
  for (const code of codes) if (!UC_BY_CODE.has(code)) throw userError(`Control ${code} not found`);
  return [...new Set(codes)];
}

export async function createRisk(
  actor: Actor,
  input: {
    title: string;
    description?: string;
    category: Category;
    asset?: string;
    ownerId?: string;
    /** Required by the matrix method. With NIST SP 800-30 it is derived from the two likelihood parts. */
    likelihood?: number;
    impact: number;
    controls?: string[];
    sourceType?: string;
    sourceId?: string;
  } & ThreatInput,
) {
  const method = await riskMethod(actor.tenantId);
  if (input.threatSource !== undefined && !THREAT_SOURCES.includes(input.threatSource)) throw userError("Unknown threat source");
  const parts = input.likelihoodInitiation !== undefined && input.likelihoodImpact !== undefined;
  if (input.likelihoodInitiation !== undefined) inRange(input.likelihoodInitiation, "Likelihood of initiation");
  if (input.likelihoodImpact !== undefined) inRange(input.likelihoodImpact, "Likelihood of adverse impact");
  // A risk raised from a gap or by another module has no threat description yet; one recorded by a person under SP 800-30 must have it.
  if (method.method === "nist_800_30" && (input.sourceType ?? "manual") === "manual" && (!parts || !input.threatSource || !input.threatEvent?.trim()))
    throw userError("NIST SP 800-30 describes a risk by its threat source, its threat event and the two parts of likelihood");
  const likelihood = method.method === "nist_800_30" && parts ? overallLikelihood(input.likelihoodInitiation!, input.likelihoodImpact!) : input.likelihood;
  if (likelihood === undefined) throw userError("Likelihood is required");
  const asset = await assetOf(actor.tenantId, input.assetId);
  inRange(likelihood, "Likelihood");
  inRange(input.impact, "Impact");
  const ownerId = await owner(actor.tenantId, input.ownerId);
  const codes = checkCodes(input.controls ?? []);
  const scope = await db(actor.tenantId);
  const id = `rsk_${randomUUID()}`;
  const now = new Date().toISOString();
  let ref = "";
  await scope.transaction(async (tx) => {
    const count = await tx.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM risk_items WHERE tenant_id = ?", actor.tenantId);
    ref = `RSK-${String(Number(count?.n ?? 0) + 1).padStart(3, "0")}`;
    await tx.run(
      "INSERT INTO risk_items (id,tenant_id,ref,title,description,category,asset,owner_id,likelihood,impact,treatment,treatment_plan,status,source_type,source_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      actor.tenantId,
      ref,
      input.title.trim(),
      input.description ?? "",
      input.category,
      input.asset ?? asset?.name ?? "",
      ownerId,
      likelihood,
      input.impact,
      "undecided",
      "",
      "identified",
      input.sourceType ?? "manual",
      input.sourceId ?? null,
      actor.userId,
      now,
      now,
    );
    await tx.run(
      "UPDATE risk_items SET threat_source = ?, threat_event = ?, vulnerability = ?, predisposing_conditions = ?, likelihood_initiation = ?, likelihood_impact = ?, asset_id = ? WHERE tenant_id = ? AND id = ?",
      input.threatSource ?? null, input.threatEvent?.trim() || null, input.vulnerability?.trim() || null, input.predisposingConditions?.trim() || null, input.likelihoodInitiation ?? null, input.likelihoodImpact ?? null, asset?.id ?? null, actor.tenantId, id,
    );
    for (const code of codes)
      await tx.run("INSERT INTO risk_item_controls (tenant_id,risk_id,uc_code) VALUES (?,?,?)", actor.tenantId, id, code);
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "risk.created",
        objectType: "risk_item",
        objectId: id,
        payload: {
          ref,
          title: input.title,
          category: input.category,
          likelihood,
          impact: input.impact,
          method: method.method,
          threatSource: input.threatSource ?? null,
          controls: codes,
          source: input.sourceType ?? "manual",
        },
      },
      tx,
    );
  });
  return { id, ref };
}

async function load(actor: Actor, id: string) {
  const row = await (await db(actor.tenantId)).get<RiskRow>("SELECT * FROM risk_items WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
  if (!row) throw userError("Risk not found");
  return row;
}
const assertOpen = (row: RiskRow) => {
  if (row.status === "closed") throw userError("This risk is closed (already final): it can no longer change");
};

export async function updateRisk(
  actor: Actor,
  input: {
    id: string;
    title?: string;
    description?: string;
    category?: Category;
    asset?: string;
    ownerId?: string | null;
    likelihood?: number;
    impact?: number;
    controls?: string[];
    treatment?: Treatment;
    treatmentPlan?: string;
    targetDate?: string | null;
  } & ThreatInput,
) {
  const row = await load(actor, input.id);
  assertOpen(row);
  const method = await riskMethod(actor.tenantId);
  if (input.threatSource !== undefined && !THREAT_SOURCES.includes(input.threatSource)) throw userError("Unknown threat source");
  if (input.likelihoodInitiation !== undefined) inRange(input.likelihoodInitiation, "Likelihood of initiation");
  if (input.likelihoodImpact !== undefined) inRange(input.likelihoodImpact, "Likelihood of adverse impact");
  const initiation = input.likelihoodInitiation ?? row.likelihood_initiation;
  const adverse = input.likelihoodImpact ?? row.likelihood_impact;
  // Under SP 800-30 the overall likelihood follows its two parts; it is not set by hand once they exist.
  if (method.method === "nist_800_30" && initiation !== null && adverse !== null && (input.likelihoodInitiation !== undefined || input.likelihoodImpact !== undefined))
    input = { ...input, likelihood: overallLikelihood(initiation, adverse) };
  const asset = input.assetId === undefined ? undefined : await assetOf(actor.tenantId, input.assetId);
  if (input.likelihood !== undefined) inRange(input.likelihood, "Likelihood");
  if (input.impact !== undefined) inRange(input.impact, "Impact");
  if (input.targetDate && Number.isNaN(Date.parse(input.targetDate))) throw userError("Target date is invalid");
  const ownerId = input.ownerId === undefined ? row.owner_id : await owner(actor.tenantId, input.ownerId);
  const codes = input.controls === undefined ? null : checkCodes(input.controls);
  if (input.treatment === "accept")
    throw userError("Use the acceptance decision to accept a risk: it needs a different person, an expiry and a note");
  const reassessed =
    (input.likelihood !== undefined && input.likelihood !== row.likelihood) || (input.impact !== undefined && input.impact !== row.impact);
  // A change to the rating or the treatment voids a standing acceptance: it was granted for a risk that no longer exists as described.
  const voidsAcceptance = row.status === "accepted" && (reassessed || (input.treatment !== undefined && input.treatment !== row.treatment));
  const treatment = voidsAcceptance && input.treatment === undefined ? "undecided" : (input.treatment ?? row.treatment);
  const status = voidsAcceptance ? "identified" : row.status === "identified" && treatment === "mitigate" ? "treating" : row.status;
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run(
      "UPDATE risk_items SET title = ?, description = ?, category = ?, asset = ?, owner_id = ?, likelihood = ?, impact = ?, treatment = ?, treatment_plan = ?, target_date = ?, status = ?, accepted_by = ?, accepted_at = ?, accepted_until = ?, acceptance_note = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      input.title?.trim() ?? row.title,
      input.description ?? row.description,
      input.category ?? row.category,
      input.asset ?? asset?.name ?? row.asset,
      ownerId,
      input.likelihood ?? row.likelihood,
      input.impact ?? row.impact,
      treatment,
      input.treatmentPlan ?? row.treatment_plan,
      input.targetDate === undefined ? row.target_date : input.targetDate,
      status,
      voidsAcceptance ? null : row.accepted_by,
      voidsAcceptance ? null : row.accepted_at,
      voidsAcceptance ? null : row.accepted_until,
      voidsAcceptance ? null : row.acceptance_note,
      new Date().toISOString(),
      actor.tenantId,
      row.id,
    );
    await tx.run(
      "UPDATE risk_items SET threat_source = ?, threat_event = ?, vulnerability = ?, predisposing_conditions = ?, likelihood_initiation = ?, likelihood_impact = ?, asset_id = ? WHERE tenant_id = ? AND id = ?",
      input.threatSource ?? row.threat_source, input.threatEvent === undefined ? row.threat_event : input.threatEvent.trim() || null, input.vulnerability === undefined ? row.vulnerability : input.vulnerability.trim() || null,
      input.predisposingConditions === undefined ? row.predisposing_conditions : input.predisposingConditions.trim() || null, initiation, adverse, asset === undefined ? row.asset_id : (asset?.id ?? null), actor.tenantId, row.id,
    );
    if (codes) {
      await tx.run("DELETE FROM risk_item_controls WHERE tenant_id = ? AND risk_id = ?", actor.tenantId, row.id);
      for (const code of codes)
        await tx.run("INSERT INTO risk_item_controls (tenant_id,risk_id,uc_code) VALUES (?,?,?)", actor.tenantId, row.id, code);
    }
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "risk.updated",
        objectType: "risk_item",
        objectId: row.id,
        payload: {
          ref: row.ref,
          fields: Object.keys(input).filter((key) => key !== "id"),
          acceptanceVoided: voidsAcceptance,
          likelihood: input.likelihood ?? null,
          impact: input.impact ?? null,
          treatment: input.treatment ?? null,
          controls: codes,
        },
      },
      tx,
    );
  });
  return { id: row.id, acceptanceVoided: voidsAcceptance };
}

/** Accepting a risk is a decision about someone else's exposure: not the owner, not the creator, time-boxed, never for a critical residual. */
export async function acceptRisk(actor: Actor, input: { id: string; days: number; note: string }) {
  const row = await load(actor, input.id);
  assertOpen(row);
  if (row.status === "accepted" && row.accepted_until && row.accepted_until > new Date().toISOString())
    throw userError("This risk is already accepted until " + row.accepted_until.slice(0, 10));
  if (!row.owner_id) throw userError("Assign an owner before the risk can be accepted");
  if (row.owner_id === actor.userId) throw userError("Separation of duties: the owner of a risk cannot accept it");
  if (row.created_by === actor.userId) throw userError("Separation of duties: the person who recorded a risk cannot accept it");
  const method = await riskMethod(actor.tenantId);
  if (input.days < 1 || input.days > method.maxAcceptanceDays) throw userError(`An acceptance lasts between 1 and ${method.maxAcceptanceDays} days`);
  const current = (await assess(actor.tenantId, [row]))[0];
  if (current.residual.band === "critical")
    throw userError(`A critical residual risk (${current.residual.score}) cannot be accepted: treat it, or reduce it first`);
  // Above the appetite, acceptance is a management decision: an administrator, and a note that says why the exposure is tolerable.
  if (exceedsAppetite(method, current.residual.band)) {
    if (actor.role !== "admin") throw new UserError(`This ${current.residual.band} residual risk is above the risk appetite (${method.appetite}): only an administrator can accept it`, 403);
    if (input.note.trim().length < 40) throw userError("Above the risk appetite, the acceptance note must explain the decision (40 characters minimum)");
  }
  const scope = await db(actor.tenantId);
  const now = Date.now();
  await scope.transaction(async (tx) => {
    const changed = await tx.run(
      "UPDATE risk_items SET status = 'accepted', treatment = 'accept', accepted_by = ?, accepted_at = ?, accepted_until = ?, acceptance_note = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status <> 'closed' AND (status <> 'accepted' OR accepted_until <= ?)",
      actor.userId,
      new Date(now).toISOString(),
      new Date(now + input.days * DAY).toISOString(),
      input.note,
      new Date(now).toISOString(),
      actor.tenantId,
      row.id,
      new Date(now).toISOString(),
    );
    if (changed.changes !== 1) throw userError("This risk already changed while you were deciding");
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "risk.accepted",
        objectType: "risk_item",
        objectId: row.id,
        payload: { ref: row.ref, days: input.days, note: input.note, residual: current.residual, aboveAppetite: exceedsAppetite(method, current.residual.band), methodVersion: method.version },
      },
      tx,
    );
  });
  return { id: row.id, until: new Date(now + input.days * DAY).toISOString() };
}

export async function closeRisk(actor: Actor, input: { id: string; note: string }) {
  const row = await load(actor, input.id);
  assertOpen(row);
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run(
      "UPDATE risk_items SET status = 'closed', closed_at = ?, close_note = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      new Date().toISOString(),
      input.note,
      new Date().toISOString(),
      actor.tenantId,
      row.id,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "risk.closed",
        objectType: "risk_item",
        objectId: row.id,
        payload: { ref: row.ref, note: input.note },
      },
      tx,
    );
  });
  return { id: row.id };
}

/** Attaches a quantified estimate from the FAIR-inspired simulation. Deterministic for a given scenario, stored as a range. */
export async function quantifyRisk(actor: Actor, input: { id: string; scenario: z.infer<typeof scenarioSchema> }) {
  const row = await load(actor, input.id);
  assertOpen(row);
  const result = simulateRisk(input.scenario);
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run(
      "UPDATE risk_items SET fair_mean = ?, fair_p90 = ?, fair_scenario_json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      result.annualizedLoss.mean,
      result.annualizedLoss.p90,
      JSON.stringify({
        scenario: input.scenario,
        p50: result.annualizedLoss.p50,
        p95: result.annualizedLoss.p95,
        currency: "EUR",
        methodology: result.methodology,
      }),
      new Date().toISOString(),
      actor.tenantId,
      row.id,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "risk.quantified",
        objectType: "risk_item",
        objectId: row.id,
        payload: { ref: row.ref, mean: result.annualizedLoss.mean, p90: result.annualizedLoss.p90 },
      },
      tx,
    );
  });
  return { id: row.id, annualizedLoss: result.annualizedLoss };
}

/** Creates one risk per significant control gap, so the register starts from the real posture instead of a blank page. */
export async function createFromGaps(actor: Actor, input: { limit: number }) {
  const snapshot = await complianceSnapshot(actor.tenantId);
  const scope = await db(actor.tenantId);
  const existing = new Set(
    (
      await scope.all<{ source_id: string }>(
        "SELECT source_id FROM risk_items WHERE tenant_id = ? AND source_type = 'gap' AND status <> 'closed'",
        actor.tenantId,
      )
    ).map((row) => row.source_id),
  );
  const category = (code: string): Category => {
    const domain = code.split("-")[1];
    return domain === "PRV"
      ? "privacy"
      : domain === "AI"
        ? "ai"
        : domain === "TPM"
          ? "third_party"
          : domain === "BCP"
            ? "resilience"
            : ["IAM", "OPS", "DAT", "SDL", "PHY", "ASM", "INC", "HR"].includes(domain)
              ? "cyber"
              : "compliance";
  };
  let created = 0;
  const refs: string[] = [];
  for (const item of snapshot.roadmap) {
    if (created >= input.limit) break;
    if (existing.has(item.code) || item.excepted) continue;
    const requirements = item.closes.reduce((sum, entry) => sum + entry.requirements, 0);
    // Likelihood from the state of the control; impact from how many obligations depend on it.
    const likelihood = item.verification === "failing" ? 4 : item.currentStatus === "partial" ? 2 : 3;
    const impact = Math.min(5, 2 + (requirements >= 3 ? 1 : 0) + (requirements >= 8 ? 1 : 0) + (requirements >= 15 ? 1 : 0));
    const made = await createRisk(actor, {
      title: `Gap: ${item.title}`,
      description: `Control ${item.code} is ${item.currentStatus.replace("_", " ")}${item.verification === "failing" ? " and its evidence is failing" : ""}. ${requirements} obligation(s) across ${item.closes.length} framework(s) depend on it.`,
      category: category(item.code),
      likelihood,
      impact,
      controls: [item.code],
      sourceType: "gap",
      sourceId: item.code,
    });
    refs.push(made.ref);
    created += 1;
  }
  return { created, refs };
}

export async function createTreatmentTask(actor: Actor, input: { id: string }) {
  const row = await load(actor, input.id);
  assertOpen(row);
  if (row.treatment !== "mitigate") throw userError("Choose the mitigate treatment before creating its task");
  const existing = await (
    await db(actor.tenantId)
  ).get(
    "SELECT id FROM tasks WHERE tenant_id = ? AND source_type = 'risk' AND source_id = ? AND status IN ('open','in_progress','blocked')",
    actor.tenantId,
    row.id,
  );
  if (existing) throw userError("An open task already exists for this risk (duplicate)");
  const current = (await assess(actor.tenantId, [row]))[0];
  const priority = current.residual.band === "critical" ? "critical" : current.residual.band === "high" ? "high" : "medium";
  return createTask(actor, {
    title: `Treat ${row.ref}: ${row.title}`.slice(0, 200),
    description: row.treatment_plan || "Define and execute the treatment plan for this risk.",
    priority,
    dueAt: row.target_date ?? new Date(Date.now() + 60 * DAY).toISOString(),
    assigneeId: row.owner_id ?? undefined,
    sourceType: "risk",
    sourceId: row.id,
  });
}

type Assessed = ReturnType<typeof present>;
async function assess(tenantId: string, rows: RiskRow[]) {
  const links = await (
    await db(tenantId)
  ).all<{ risk_id: string; uc_code: string }>("SELECT risk_id, uc_code FROM risk_item_controls WHERE tenant_id = ?", tenantId);
  const snapshot = await complianceSnapshot(tenantId);
  const method = await riskMethod(tenantId);
  const posture = new Map(snapshot.controls.map((control) => [control.code, control]));
  return rows.map((row) => {
    const codes = links
      .filter((link) => link.risk_id === row.id)
      .map((link) => link.uc_code)
      .sort();
    const effects: ControlEffect[] = codes.map((code) => {
      const control = posture.get(code);
      return {
        code,
        weight: control ? control.weight : 0,
        backed: control ? ["verified", "documented"].includes(control.verification) : false,
      };
    });
    return present(row, codes, effects, posture, method);
  });
}

function present(
  row: RiskRow,
  codes: string[],
  effects: ControlEffect[],
  posture: Map<string, { title: string; status: string; verification: string; weight: number | null }>,
  method: RiskMethod,
) {
  const now = new Date().toISOString();
  const inherentScore = scoreOf(row.likelihood, row.impact);
  const rate = (likelihood: number, impact: number) => bandFor(method, likelihood, impact);
  const result = residual({ likelihood: row.likelihood, impact: row.impact, controls: effects, rate });
  const describedByThreat = Boolean(row.threat_source && row.threat_event && row.likelihood_initiation && row.likelihood_impact);
  const acceptanceExpired = row.status === "accepted" && row.accepted_until !== null && row.accepted_until <= now;
  return {
    ...row,
    fair:
      row.fair_p90 === null
        ? null
        : {
            mean: row.fair_mean,
            p90: row.fair_p90,
            ...(JSON.parse(row.fair_scenario_json ?? "{}") as { p50?: number; p95?: number; currency?: string }),
          },
    fair_scenario_json: undefined,
    inherent: { score: inherentScore, band: rate(row.likelihood, row.impact) as Band },
    aboveAppetite: row.status !== "closed" && exceedsAppetite(method, result.band),
    /** Under SP 800-30, an open risk without its threat description has not been assessed by the method. */
    needsThreatDescription: method.method === "nist_800_30" && row.status !== "closed" && !describedByThreat,
    residual: result,
    controls: codes.map((code) => ({
      code,
      title: posture.get(code)?.title ?? code,
      status: posture.get(code)?.status ?? "not_started",
      verification: posture.get(code)?.verification ?? "unverified",
    })),
    acceptanceExpired,
    treatmentOverdue: row.status === "treating" && row.target_date !== null && row.target_date < now,
    /** An accepted risk whose acceptance lapsed counts as untreated again. */
    effectiveStatus: acceptanceExpired ? "identified" : row.status,
  };
}

export async function riskSnapshot(tenantId: string) {
  const rows = await (await db(tenantId)).all<RiskRow>("SELECT * FROM risk_items WHERE tenant_id = ? ORDER BY ref", tenantId);
  const risks = await assess(tenantId, rows);
  const open = risks.filter((risk) => risk.status !== "closed");
  const sum = (field: "fair_mean" | "fair_p90") => open.reduce((total, risk) => total + (risk[field] ?? 0), 0);
  const method = await riskMethod(tenantId);
  return {
    risks,
    method: { ...method, approved: method.version > 0 },
    heat: {
      inherent: heatMap(open.map((risk) => ({ likelihood: risk.likelihood, impact: risk.impact }))),
      residual: heatMap(open.map((risk) => ({ likelihood: risk.residual.likelihood, impact: risk.residual.impact }))),
    },
    summary: {
      open: open.length,
      critical: open.filter((risk) => risk.residual.band === "critical").length,
      high: open.filter((risk) => risk.residual.band === "high").length,
      untreated: open.filter((risk) => risk.effectiveStatus === "identified").length,
      aboveAppetite: open.filter((risk) => risk.aboveAppetite).length,
      acceptedAboveAppetite: open.filter((risk) => risk.aboveAppetite && risk.effectiveStatus === "accepted").length,
      needsThreatDescription: open.filter((risk) => risk.needsThreatDescription).length,
      acceptanceExpired: open.filter((risk) => risk.acceptanceExpired).length,
      quantified: open.filter((risk) => risk.fair !== null).length,
      // Sums of per-risk simulations are not a portfolio simulation: the risks are not independent. Shown as an indication only.
      annualLossMean: sum("fair_mean"),
      annualLossP90Indicative: sum("fair_p90"),
    },
  };
}

export type RiskView = Assessed;

/**
 * The thread an auditor pulls: from an asset and a threat to the risk, from the risk to its treatment and controls, and from each
 * control to the requirements it satisfies in the adopted frameworks. And back: which risks a control is there to treat. It also names
 * what breaks the thread, so the gaps are a list to work through rather than something to be discovered in an audit.
 */
export async function riskTraceability(tenantId: string) {
  const rows = await (await db(tenantId)).all<RiskRow>("SELECT * FROM risk_items WHERE tenant_id = ? AND status <> 'closed' ORDER BY ref", tenantId);
  const risks = await assess(tenantId, rows);
  const snapshot = await complianceSnapshot(tenantId);
  const adopted = snapshot.adoptions.map((adoption) => adoption.frameworkId);
  const assets = await (await db(tenantId)).all<{ id: string; name: string; type: string; criticality: string }>("SELECT id, name, type, criticality FROM assets WHERE tenant_id = ? AND valid_to IS NULL", tenantId);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const requirementsFor = (code: string) => Object.fromEntries(adopted.map((frameworkId) => [frameworkId, requirementsOf(code, frameworkId)]).filter(([, ids]) => (ids as string[]).length > 0)) as Record<string, string[]>;
  const chain = risks.map((risk) => ({
    ref: risk.ref, id: risk.id, title: risk.title, category: risk.category,
    asset: risk.asset_id && assetById.has(risk.asset_id) ? assetById.get(risk.asset_id)! : risk.asset ? { id: null, name: risk.asset, type: null, criticality: null } : null,
    threat: risk.threat_event ? { source: risk.threat_source, event: risk.threat_event, vulnerability: risk.vulnerability, predisposingConditions: risk.predisposing_conditions } : null,
    inherent: risk.inherent, residual: { score: risk.residual.score, band: risk.residual.band }, aboveAppetite: risk.aboveAppetite,
    treatment: risk.treatment, treatmentPlan: risk.treatment_plan, status: risk.effectiveStatus,
    controls: risk.controls.map((control) => ({ ...control, requirements: requirementsFor(control.code) })),
  }));
  const byControl = new Map<string, string[]>();
  for (const risk of chain) for (const control of risk.controls) byControl.set(control.code, [...(byControl.get(control.code) ?? []), risk.ref]);
  const claimed = snapshot.controls.filter((control) => control.status === "implemented" || control.status === "partial");
  return {
    adoptedFrameworks: adopted,
    risks: chain,
    controls: [...byControl.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([code, refs]) => ({ code, title: UC_BY_CODE.get(code)?.title ?? code, risks: refs, requirements: requirementsFor(code) })),
    breaks: {
      risksWithoutControl: chain.filter((risk) => risk.controls.length === 0 && risk.treatment !== "accept" && risk.treatment !== "avoid").map((risk) => risk.ref),
      risksWithoutAsset: chain.filter((risk) => risk.asset === null).map((risk) => risk.ref),
      mitigationWithoutPlan: chain.filter((risk) => risk.treatment === "mitigate" && !risk.treatmentPlan.trim()).map((risk) => risk.ref),
      untreated: chain.filter((risk) => risk.status === "identified").map((risk) => risk.ref),
      // A control that is claimed but treats no recorded risk is not wrong, but its inclusion rests on the framework alone.
      controlsNotLinkedToARisk: claimed.filter((control) => !byControl.has(control.code)).map((control) => control.code),
    },
  };
}

/** The risk treatment plan (ISO/IEC 27001 6.1.3 e) as a spreadsheet: one line per open risk, with who does what by when. */
export async function treatmentPlanCsv(tenantId: string) {
  const trace = await riskTraceability(tenantId);
  const rows = await (await db(tenantId)).all<{ ref: string; owner: string | null; target_date: string | null; accepted_until: string | null }>(
    "SELECT r.ref AS ref, u.name AS owner, r.target_date AS target_date, r.accepted_until AS accepted_until FROM risk_items r LEFT JOIN users u ON u.id = r.owner_id WHERE r.tenant_id = ? AND r.status <> 'closed'", tenantId);
  const extra = new Map(rows.map((row) => [row.ref, row]));
  const header = ["ref", "risk", "asset", "threat_event", "inherent", "residual", "above_appetite", "treatment", "plan", "controls", "owner", "target_date", "status", "accepted_until"];
  const lines = trace.risks.map((risk) => [
    risk.ref, risk.title, risk.asset?.name ?? "", risk.threat?.event ?? "", `${risk.inherent.band} (${risk.inherent.score})`, `${risk.residual.band} (${risk.residual.score})`, risk.aboveAppetite ? "yes" : "no",
    risk.treatment, risk.treatmentPlan, risk.controls.map((control) => `${control.code}=${control.status}`).join(" "), extra.get(risk.ref)?.owner ?? "", extra.get(risk.ref)?.target_date?.slice(0, 10) ?? "", risk.status, extra.get(risk.ref)?.accepted_until?.slice(0, 10) ?? "",
  ]);
  return [header, ...lines].map((row) => row.map(csvCell).join(",")).join("\n");
}
