import "server-only";

import { userError } from "@/lib/core/errors";
import { sha256 } from "@/lib/core/integrity";
import { PACK } from "@/lib/connectors/pack";
import { getDb } from "@/lib/db";

/**
 * From a control result back to the original evidence, with what is known about how it was collected and what is not. Each record is
 * re-hashed when read, so a stored result that was altered after collection is reported as such instead of being trusted.
 *
 * Outcomes are deliberately more than pass and fail:
 *   compliant      the latest evidence is current and the policy held
 *   non_compliant  the latest evidence is current and the policy did not hold
 *   stale          the latest evidence has expired: it says nothing about today
 *   unknown        the control could not be evaluated (access, plan or missing fact): see the gap
 *   error          the last attempt to collect failed
 *   not_applicable the control has no object for this target
 */
export type Outcome = "compliant" | "non_compliant" | "stale" | "unknown" | "error" | "not_applicable";

type EvidenceRow = { id: string; control_id: string; asset_id: string; name: string; source: string; collection_method: string; content_type: string; content_json: string; content_hash: string; period_start: string | null; period_end: string | null; collected_at: string; expires_at: string | null; status: string; created_by: string };

export function outcomeOf(status: string, expiresAt: string | null, now = Date.now()): Outcome {
  if (expiresAt && Date.parse(expiresAt) <= now) return "stale";
  return status === "healthy" ? "compliant" : "non_compliant";
}

export const hashMatches = (row: Pick<EvidenceRow, "content_json" | "content_hash">) => sha256(row.content_json) === row.content_hash;

function describe(row: EvidenceRow, now: number) {
  const content = JSON.parse(row.content_json) as { provenance?: Record<string, unknown>; result?: { failed?: unknown[] } };
  const provenance = (content.provenance ?? null) as { collector?: { name: string; version: string }; rule?: { policySha256?: string }; scope?: unknown; limits?: string[]; sample?: boolean } | null;
  return {
    id: row.id, assetId: row.asset_id, collectedAt: row.collected_at, expiresAt: row.expires_at, source: row.source, status: row.status,
    outcome: outcomeOf(row.status, row.expires_at, now), sha256: row.content_hash,
    integrity: hashMatches(row) ? "verified" as const : "altered" as const,
    sample: provenance?.sample === true || row.source.endsWith(":demo"),
    collector: provenance?.collector ?? null, rulePolicySha256: provenance?.rule?.policySha256 ?? null, scope: provenance?.scope ?? null, limits: provenance?.limits ?? [],
    // Evidence written before provenance was recorded still counts, but says so.
    provenanceRecorded: provenance !== null,
    failedConditions: content.result?.failed?.length ?? 0,
  };
}

/** Everything known about one control: its evidence over time, the current outcome per target, and what could not be done. */
export async function evidenceTrail(tenantId: string, input: { controlCode: string; limit?: number }) {
  const db = (await getDb()).scope(tenantId);
  const control = await db.get<{ id: string; code: string; title: string; objective: string }>("SELECT id, code, title, objective FROM controls WHERE tenant_id = ? AND code = ? AND valid_to IS NULL", tenantId, input.controlCode);
  const connector = PACK.find((item) => item.code === input.controlCode)?.connector ?? null;
  if (!control) {
    const gapsOnly = await db.all<{ asset_id: string; kind: string; detail_json: string; recorded_at: string }>("SELECT asset_id, kind, detail_json, recorded_at FROM evidence_gaps WHERE tenant_id = ? AND control_code = ?", tenantId, input.controlCode);
    if (!gapsOnly.length) throw userError("Control not found");
  }
  const now = Date.now();
  const rows = control ? await db.all<EvidenceRow>("SELECT * FROM evidence WHERE tenant_id = ? AND control_id = ? ORDER BY collected_at DESC LIMIT ?", tenantId, control.id, Math.min(200, input.limit ?? 50)) : [];
  const records = rows.map((row) => describe(row, now));
  const gaps = (await db.all<{ asset_id: string; connector: string; kind: string; detail_json: string; source: string; recorded_at: string }>("SELECT asset_id, connector, kind, detail_json, source, recorded_at FROM evidence_gaps WHERE tenant_id = ? AND control_code = ?", tenantId, input.controlCode)).map((gap) => ({ assetId: gap.asset_id, connector: gap.connector, kind: gap.kind, source: gap.source, recordedAt: gap.recorded_at, detail: JSON.parse(gap.detail_json) as Record<string, unknown> }));
  const failedRuns = connector ? (await db.all<{ target: string; started_at: string; error: string | null }>("SELECT target, started_at, error FROM job_runs WHERE tenant_id = ? AND kind = ? AND status = 'failed' ORDER BY started_at DESC LIMIT 5", tenantId, connector)).map((run) => ({ target: run.target, at: run.started_at, error: run.error })) : [];

  // Current outcome per target: the newest of the evidence, the gap and the failed attempt decides.
  const assets = [...new Set([...records.map((record) => record.assetId), ...gaps.map((gap) => gap.assetId)])];
  const current = assets.map((assetId) => {
    const latest = records.find((record) => record.assetId === assetId);
    const gap = gaps.find((item) => item.assetId === assetId);
    if (gap && (!latest || gap.recordedAt > latest.collectedAt)) return { assetId, outcome: (gap.kind === "not_applicable" ? "not_applicable" : "unknown") as Outcome, since: gap.recordedAt, reason: gap.kind === "not_applicable" ? String(gap.detail.reason ?? "") : `could not read ${(gap.detail.missing as string[] | undefined)?.join(", ") ?? "a required fact"}` };
    if (latest) {
      const laterFailure = failedRuns.find((run) => run.at > latest.collectedAt);
      if (laterFailure && latest.outcome !== "stale") return { assetId, outcome: "error" as Outcome, since: laterFailure.at, reason: `the latest collection failed: ${laterFailure.error ?? "unknown error"}; the evidence shown is from ${latest.collectedAt}` };
      return { assetId, outcome: latest.outcome, since: latest.collectedAt, reason: latest.outcome === "stale" ? `the evidence expired on ${latest.expiresAt}` : latest.outcome === "non_compliant" ? `${latest.failedConditions} condition(s) not met` : "the policy held at the last collection" };
    }
    return { assetId, outcome: "unknown" as Outcome, since: null, reason: "no evidence has been collected" };
  });
  return { control: control ? { code: control.code, title: control.title, objective: control.objective, connector } : { code: input.controlCode, title: input.controlCode, objective: "", connector }, current, records, gaps, failedCollections: failedRuns, integrity: { checked: records.length, altered: records.filter((record) => record.integrity === "altered").length } };
}

/** One piece of evidence in full, re-hashed, with the finding it produced and the control it belongs to. */
export async function evidenceRecord(tenantId: string, id: string) {
  const db = (await getDb()).scope(tenantId);
  const row = await db.get<EvidenceRow>("SELECT * FROM evidence WHERE tenant_id = ? AND id = ?", tenantId, id);
  if (!row) throw userError("Evidence not found");
  const control = await db.get<{ code: string; title: string }>("SELECT code, title FROM controls WHERE tenant_id = ? AND id = ?", tenantId, row.control_id);
  const findings = await db.all<{ id: string; title: string; status: string; severity: string }>("SELECT id, title, status, severity FROM findings WHERE tenant_id = ? AND evidence_id = ?", tenantId, id);
  const summary = describe(row, Date.now());
  return { ...summary, control, findings, content: summary.integrity === "verified" ? (JSON.parse(row.content_json) as unknown) : null, warning: summary.integrity === "altered" ? "The stored content does not match the hash recorded at collection: it was changed afterwards and must not be relied on." : null };
}
