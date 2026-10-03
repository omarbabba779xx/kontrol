import "server-only";

import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Actor } from "@/lib/core/auth";
import { complianceSnapshot } from "@/lib/core/compliance-engine";
import { userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { simulateRisk } from "@/lib/core/risk-engine";
import { bandOf, heatMap, residual, scoreOf, type Band, type ControlEffect } from "@/lib/core/risk-rating";
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
const MAX_ACCEPTANCE_DAYS = 365;

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
    likelihood: number;
    impact: number;
    controls?: string[];
    sourceType?: string;
    sourceId?: string;
  },
) {
  inRange(input.likelihood, "Likelihood");
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
      input.asset ?? "",
      ownerId,
      input.likelihood,
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
          likelihood: input.likelihood,
          impact: input.impact,
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
  },
) {
  const row = await load(actor, input.id);
  assertOpen(row);
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
      input.asset ?? row.asset,
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
  if (input.days < 1 || input.days > MAX_ACCEPTANCE_DAYS) throw userError(`An acceptance lasts between 1 and ${MAX_ACCEPTANCE_DAYS} days`);
  const current = (await assess(actor.tenantId, [row]))[0];
  if (current.residual.band === "critical")
    throw userError(`A critical residual risk (${current.residual.score}) cannot be accepted: treat it, or reduce it first`);
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
        payload: { ref: row.ref, days: input.days, note: input.note, residual: current.residual },
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
    return present(row, codes, effects, posture);
  });
}

function present(
  row: RiskRow,
  codes: string[],
  effects: ControlEffect[],
  posture: Map<string, { title: string; status: string; verification: string; weight: number | null }>,
) {
  const now = new Date().toISOString();
  const inherentScore = scoreOf(row.likelihood, row.impact);
  const result = residual({ likelihood: row.likelihood, impact: row.impact, controls: effects });
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
    inherent: { score: inherentScore, band: bandOf(inherentScore) as Band },
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
  return {
    risks,
    heat: {
      inherent: heatMap(open.map((risk) => ({ likelihood: risk.likelihood, impact: risk.impact }))),
      residual: heatMap(open.map((risk) => ({ likelihood: risk.residual.likelihood, impact: risk.residual.impact }))),
    },
    summary: {
      open: open.length,
      critical: open.filter((risk) => risk.residual.band === "critical").length,
      high: open.filter((risk) => risk.residual.band === "high").length,
      untreated: open.filter((risk) => risk.effectiveStatus === "identified").length,
      acceptanceExpired: open.filter((risk) => risk.acceptanceExpired).length,
      quantified: open.filter((risk) => risk.fair !== null).length,
      // Sums of per-risk simulations are not a portfolio simulation: the risks are not independent. Shown as an indication only.
      annualLossMean: sum("fair_mean"),
      annualLossP90Indicative: sum("fair_p90"),
    },
  };
}

export type RiskView = Assessed;
