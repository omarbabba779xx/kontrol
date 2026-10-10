import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { createRisk, CATEGORIES, riskMethod } from "@/lib/core/risk-register";
import { scenarioFor, THREAT_BY_ID, THREATS, type Dimension, type ThreatFamily, type Valuation } from "@/lib/risk/threat-library";
import { getDb } from "@/lib/db";

/**
 * Asset-based risk identification (ISO/IEC 27005): value the assets, pick the threats that apply to them, and record the resulting
 * scenarios as risks. The value of an asset bounds the impact of what can happen to it, so a scenario's impact is derived, per
 * security property, from the valuation; the assessor still judges the likelihood and may lower an impact with a reason.
 */
type Category = (typeof CATEGORIES)[number];
const db = async (tenantId: string) => (await getDb()).scope(tenantId);
const level = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < 1 || value > 5) throw userError(`${label} must be between 1 and 5`);
};

export const ASSET_TYPES = ["service", "application", "data", "infrastructure", "ai_system", "repository", "supplier", "people", "site"] as const;
export const ASSET_CRITICALITIES = ["low", "medium", "high", "critical"] as const;

/**
 * Adds an asset to the inventory by hand. Connectors register the assets they collect from; everything else an organisation
 * depends on (a service, a data set, a supplier) has to be entered by someone, or it can never be valued or assessed.
 */
export async function registerAsset(actor: Actor, input: { name: string; type: (typeof ASSET_TYPES)[number]; criticality: (typeof ASSET_CRITICALITIES)[number]; ownerId?: string | null; description?: string }) {
  const name = input.name.trim();
  if (name.length < 2) throw userError("The asset needs a name");
  const scope = await db(actor.tenantId);
  if (await scope.get("SELECT id FROM assets WHERE tenant_id = ? AND name = ? AND valid_to IS NULL", actor.tenantId, name)) throw userError(`An asset named ${name} already exists`);
  if (input.ownerId && !(await scope.get("SELECT id FROM users WHERE tenant_id = ? AND id = ?", actor.tenantId, input.ownerId))) throw userError("Owner not found");
  const id = `asset_${randomUUID()}`;
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO assets (id,tenant_id,type,name,criticality,owner_id,attributes_json,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id, actor.tenantId, input.type, name, input.criticality, input.ownerId ?? null, JSON.stringify({ managedBy: "manual", description: input.description?.trim() ?? "" }), now, now);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "risk.asset_registered", objectType: "asset", objectId: id, payload: { name, type: input.type, criticality: input.criticality } }, tx);
  });
  return { id, name };
}

/** Takes an asset out of the current inventory. Its history stays; a risk still open on it has to be dealt with first. */
export async function retireAsset(actor: Actor, input: { assetId: string; reason: string }) {
  const scope = await db(actor.tenantId);
  const asset = await scope.get<{ id: string; name: string }>("SELECT id, name FROM assets WHERE tenant_id = ? AND id = ? AND valid_to IS NULL", actor.tenantId, input.assetId);
  if (!asset) throw userError("Asset not found");
  const open = await scope.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM risk_items WHERE tenant_id = ? AND asset_id = ? AND status <> 'closed'", actor.tenantId, asset.id);
  if (Number(open?.n ?? 0) > 0) throw userError(`${asset.name} still has ${open?.n} open risk(s): close or move them first`);
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE assets SET valid_to = ? WHERE tenant_id = ? AND id = ?", now, actor.tenantId, asset.id);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "risk.asset_retired", objectType: "asset", objectId: asset.id, payload: { name: asset.name, reason: input.reason } }, tx);
  });
  return { id: asset.id, retired: true };
}

const CATEGORY_OF: Record<ThreatFamily, Category> = {
  physical: "operational", natural: "resilience", essential_services: "resilience", technical_failure: "operational",
  information_compromise: "cyber", function_compromise: "cyber", human_error: "operational", organisational: "compliance",
};

export async function valueAsset(actor: Actor, input: { assetId: string; confidentiality: number; integrity: number; availability: number; rationale?: string }) {
  level(input.confidentiality, "Confidentiality");
  level(input.integrity, "Integrity");
  level(input.availability, "Availability");
  const scope = await db(actor.tenantId);
  const asset = await scope.get<{ id: string; name: string }>("SELECT id, name FROM assets WHERE tenant_id = ? AND id = ? AND valid_to IS NULL", actor.tenantId, input.assetId);
  if (!asset) throw userError("Asset not found");
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO asset_valuations (asset_id,tenant_id,confidentiality,integrity,availability,rationale,valued_by,valued_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(asset_id) DO UPDATE SET confidentiality = excluded.confidentiality, integrity = excluded.integrity, availability = excluded.availability, rationale = excluded.rationale, valued_by = excluded.valued_by, valued_at = excluded.valued_at",
      asset.id, actor.tenantId, input.confidentiality, input.integrity, input.availability, input.rationale ?? "", actor.userId, now);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "risk.asset_valued", objectType: "asset", objectId: asset.id, payload: { name: asset.name, confidentiality: input.confidentiality, integrity: input.integrity, availability: input.availability } }, tx);
  });
  return { assetId: asset.id, value: Math.max(input.confidentiality, input.integrity, input.availability) };
}

type AssetRow = { id: string; name: string; type: string; criticality: string; confidentiality: number | null; integrity: number | null; availability: number | null; rationale: string | null; valued_at: string | null };

async function assets(tenantId: string) {
  const rows = await (await db(tenantId)).all<AssetRow>(
    "SELECT a.id, a.name, a.type, a.criticality, v.confidentiality, v.integrity, v.availability, v.rationale, v.valued_at FROM assets a LEFT JOIN asset_valuations v ON v.asset_id = a.id AND v.tenant_id = a.tenant_id WHERE a.tenant_id = ? AND a.valid_to IS NULL ORDER BY a.name LIMIT 500",
    tenantId);
  return rows.map((row) => {
    const valuation: Valuation | null = row.confidentiality === null ? null : { confidentiality: Number(row.confidentiality), integrity: Number(row.integrity), availability: Number(row.availability) };
    return { id: row.id, name: row.name, type: row.type, criticality: row.criticality, valuation, value: valuation ? Math.max(...Object.values(valuation)) : null, rationale: row.rationale ?? "", valuedAt: row.valued_at };
  });
}

/** The assets with their valuation, the threat library, and which threat was already assessed on which asset. */
export async function riskIdentification(tenantId: string) {
  const inventory = await assets(tenantId);
  const assessed = await (await db(tenantId)).all<{ asset_id: string; threat_id: string; ref: string }>("SELECT asset_id, threat_id, ref FROM risk_items WHERE tenant_id = ? AND status <> 'closed' AND asset_id IS NOT NULL AND threat_id IS NOT NULL", tenantId);
  return {
    assets: inventory.map((asset) => ({
      ...asset,
      // Threats that concern this type of asset and have no open risk on it yet: the ones still to consider.
      toConsider: THREATS.filter((threat) => (threat.assetTypes.length === 0 || threat.assetTypes.includes(asset.type)) && !assessed.some((item) => item.asset_id === asset.id && item.threat_id === threat.id)).map((threat) => threat.id),
      assessed: assessed.filter((item) => item.asset_id === asset.id).map((item) => ({ threatId: item.threat_id, ref: item.ref })),
    })),
    threats: THREATS,
    coverage: { assets: inventory.length, valued: inventory.filter((asset) => asset.valuation).length, scenarios: assessed.length },
  };
}

/**
 * Records the scenario "this threat on this asset" as a risk. The impact per security property comes from the asset's valuation;
 * `impact` may lower it (never raise it) when the assessor gives a reason, for example because only part of the asset is exposed.
 */
export async function createScenario(actor: Actor, input: { assetId: string; threatId: string; likelihood?: number; likelihoodInitiation?: number; likelihoodImpact?: number; impact?: number; impactReason?: string; ownerId?: string }) {
  const threat = THREAT_BY_ID.get(input.threatId);
  if (!threat) throw userError("Threat not found");
  const asset = (await assets(actor.tenantId)).find((item) => item.id === input.assetId);
  if (!asset) throw userError("Asset not found");
  if (!asset.valuation) throw userError("Value the asset (confidentiality, integrity, availability) before assessing a threat on it");
  const scope = await db(actor.tenantId);
  const duplicate = await scope.get<{ ref: string }>("SELECT ref FROM risk_items WHERE tenant_id = ? AND asset_id = ? AND threat_id = ? AND status <> 'closed'", actor.tenantId, asset.id, threat.id);
  if (duplicate) throw userError(`This threat is already assessed on this asset as ${duplicate.ref}`);
  const scenario = scenarioFor(threat, asset);
  const derived = scenario.impact!;
  if (input.impact !== undefined) {
    level(input.impact, "Impact");
    if (input.impact > derived) throw userError(`The impact cannot exceed the value of the asset for the properties this threat affects (${derived})`);
    if (input.impact < derived && (input.impactReason ?? "").trim().length < 15) throw userError("Explain why the impact is lower than the value of the asset (15 characters minimum)");
  }
  const impact = input.impact ?? derived;
  const method = await riskMethod(actor.tenantId);
  const created = await createRisk(actor, {
    title: scenario.title.slice(0, 200),
    description: `Scenario from the threat library (${threat.id}).${input.impact !== undefined && input.impact < derived ? ` Impact lowered from ${derived} to ${input.impact}: ${input.impactReason!.trim()}` : ""}`,
    category: CATEGORY_OF[threat.family],
    assetId: asset.id,
    ownerId: input.ownerId,
    impact,
    controls: scenario.controls,
    threatSource: scenario.threatSource,
    threatEvent: scenario.threatEvent,
    vulnerability: scenario.vulnerability,
    ...(method.method === "nist_800_30" ? { likelihoodInitiation: input.likelihoodInitiation, likelihoodImpact: input.likelihoodImpact } : { likelihood: input.likelihood }),
  });
  const of = (dimension: Dimension) => (threat.affects.includes(dimension) ? Math.min(impact, asset.valuation![dimension]) : null);
  await scope.run("UPDATE risk_items SET threat_id = ?, impact_c = ?, impact_i = ?, impact_a = ? WHERE tenant_id = ? AND id = ?", threat.id, of("confidentiality"), of("integrity"), of("availability"), actor.tenantId, created.id);
  return { ...created, impact, impactByDimension: { confidentiality: of("confidentiality"), integrity: of("integrity"), availability: of("availability") }, controls: scenario.controls };
}
