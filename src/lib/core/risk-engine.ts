import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { appendAudit } from "@/lib/core/integrity";
import type { Actor } from "@/lib/core/auth";
import type { z } from "zod";
import type { scenarioSchema } from "@/lib/core/schemas";

type Scenario = z.infer<typeof scenarioSchema>;

function seededRandom(seed: string) {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function normal(random: () => number) {
  const u = Math.max(random(), 1e-12);
  const v = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sorted: number[], value: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(value * (sorted.length - 1)))];
}

export function simulateRisk(scenario: Scenario) {
  const seed = JSON.stringify(scenario);
  const random = seededRandom(seed);
  const frequencyMultiplier = 1 + (scenario.materialDecision ? .34 : 0) + (scenario.sensitiveData ? .18 : 0) + (scenario.thirdPartyModel ? .1 : 0) + (scenario.crossBorder ? .08 : 0) - (scenario.humanReview ? .26 : 0);
  const baseFrequency = Math.max(.4, scenario.annualEvents / 55_000) * frequencyMultiplier;
  const baseMagnitude = 260_000 * (1 + (scenario.materialDecision ? 1.25 : 0) + (scenario.sensitiveData ? .7 : 0) + (scenario.crossBorder ? .25 : 0));
  const losses: number[] = [];

  for (let iteration = 0; iteration < scenario.iterations; iteration += 1) {
    const frequency = Math.max(0, Math.round(baseFrequency + normal(random) * Math.sqrt(baseFrequency)));
    let aggregate = 0;
    for (let event = 0; event < frequency; event += 1) {
      const logNormal = Math.exp(Math.log(baseMagnitude) + .72 * normal(random));
      aggregate += logNormal;
    }
    losses.push(Math.round(aggregate));
  }
  losses.sort((a, b) => a - b);

  const classification = scenario.materialDecision ? "high-risk" : scenario.sensitiveData ? "limited-risk" : "minimal-risk";
  const requiredControls = 12 + (scenario.materialDecision ? 9 : 0) + (scenario.sensitiveData ? 6 : 0) + (scenario.thirdPartyModel ? 4 : 0) + (scenario.crossBorder ? 3 : 0);
  const p50 = percentile(losses, .5);
  const p90 = percentile(losses, .9);
  const p95 = percentile(losses, .95);
  const mean = Math.round(losses.reduce((sum, loss) => sum + loss, 0) / losses.length);

  return {
    methodology: "FAIR-inspired loss event simulation",
    classification,
    iterations: scenario.iterations,
    annualizedLoss: { mean, p50, p90, p95, currency: "EUR" },
    requiredControls,
    factors: { baseFrequency, baseMagnitude, humanReviewReduction: scenario.humanReview ? .26 : 0 },
    histogram: Array.from({ length: 20 }, (_, index) => {
      const start = percentile(losses, index / 20);
      const end = percentile(losses, (index + 1) / 20);
      return { bucket: index, start, end, count: Math.round(losses.length / 20) };
    }),
  };
}

export async function persistRiskSimulation(actor: Actor, scenario: Scenario, result: ReturnType<typeof simulateRisk>): Promise<string> {
  const id = `risk_${randomUUID()}`;
  const now = new Date().toISOString();
  const db = (await getDb()).scope(actor.tenantId);
  await db.run(`INSERT INTO risks (id,tenant_id,title,scenario,asset_id,owner_id,status,likelihood,impact,p50_loss,p90_loss,currency,assumptions_json,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, actor.tenantId, scenario.name, `Loss arising from ${result.classification} AI deployment`, "asset_ai_014", actor.userId, "open", result.factors.baseFrequency, result.factors.baseMagnitude, result.annualizedLoss.p50, result.annualizedLoss.p90, "EUR", JSON.stringify(scenario), now, now,
  );
  await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "risk.simulated", objectType: "risk", objectId: id, payload: { scenario, result } });
  return id;
}
