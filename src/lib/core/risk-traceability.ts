import "server-only";

import { complianceSnapshot } from "@/lib/core/compliance-engine";
import { csvCell } from "@/lib/core/compliance/statement";
import { assess, type RiskRow } from "@/lib/core/risk-register";
import { requirementsOf } from "@/lib/frameworks/scoring";
import { UC_BY_CODE } from "@/lib/frameworks/unified";
import { getDb } from "@/lib/db";

const db = async (tenantId: string) => (await getDb()).scope(tenantId);

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
