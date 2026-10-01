"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Database, RefreshCw } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Domain = "controls" | "evidence" | "vendors" | "audits" | "intelligence" | "models" | "risks";
type RecordValue = Record<string, unknown>;
type Snapshot = { controls: RecordValue[]; evidence: RecordValue[]; vendors: RecordValue[]; auditorRequests: RecordValue[]; drift: RecordValue[]; contradictions: RecordValue[]; models: RecordValue[]; risks: RecordValue[]; decisions: RecordValue[] };

const config: Record<Domain, { index: string; title: string; description: string; source: keyof Snapshot; columns: Array<[string, string]> }> = {
  controls: { index: "03", title: "Control graph", description: "Contrôles normalisés, statut réel de leurs preuves et règles exécutables.", source: "controls", columns: [["code","Control"],["title","Objective"],["automation","Automation"],["frequency","Cadence"],["evidence_status","Latest evidence"]] },
  models: { index: "04", title: "Model registry", description: "Versions, empreintes, classifications et résultats d’évaluation des systèmes IA.", source: "models", columns: [["name","Model"],["version","Version"],["classification","Classification"],["status","Status"],["latest_evaluation_passed","Evaluation"]] },
  evidence: { index: "05", title: "Evidence ledger", description: "Provenance, intégrité et score de confiance des éléments de preuve.", source: "evidence", columns: [["name","Evidence"],["source","Source"],["status","Status"],["score","Trust"],["grade","Grade"]] },
  vendors: { index: "06", title: "Dependencies", description: "Risque résiduel, concentration de quatrième niveau et capacité de sortie.", source: "vendors", columns: [["name","Provider"],["tier","Tier"],["residual_risk","Residual"],["concentration_score","Concentration"],["exit_readiness","Exit readiness"]] },
  audits: { index: "07", title: "Reviews", description: "Demandes d’audit sécurisées et décisions signées avec leur état courant.", source: "auditorRequests", columns: [["subject","Request"],["requester_name","Requester"],["status","Status"],["due_at","Due"],["created_at","Created"]] },
  intelligence: { index: "08", title: "Change intelligence", description: "Dérives et contradictions détectées en continu dans le portefeuille.", source: "drift", columns: [["title","Signal"],["kind","Kind"],["subject_type","Subject"],["severity","Severity"],["detected_at","Detected"]] },
  risks: { index: "02", title: "Risk portfolio", description: "Scénarios quantifiés et pertes annualisées issues du moteur Monte Carlo.", source: "risks", columns: [["title","Scenario"],["status","Status"],["likelihood","Frequency"],["p50_loss","P50"],["p90_loss","P90"]] },
};

export function LiveDomainPage({ domain }: { domain: Domain }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState("Synchronisation…");
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const details = config[domain];

  useEffect(() => {
    const controller = new AbortController();
    fetchJson<Snapshot>("/api/assurance", { signal: controller.signal })
      .then((next) => { setData(next); setFailed(false); setStatus("Données opérationnelles"); })
      .catch((error: unknown) => { if (isAbort(error)) return; setFailed(true); setStatus(errorMessage(error, "Données indisponibles")); });
    return () => controller.abort();
  }, [reloadKey]);

  function load() {
    setStatus("Synchronisation…");
    setReloadKey((key) => key + 1);
  }

  const rows = data?.[details.source] ?? [];
  const loading = data === null && !failed;
  return <div><PageHeading index={details.index} title={details.title} description={details.description} meta={status} action={<Button type="button" onClick={load} variant="outline" className="h-8 rounded-none border-[#171713] bg-transparent text-[9px]"><RefreshCw className="me-1.5 h-3 w-3" />Actualiser</Button>} /><section className="p-5 sm:p-7 lg:p-9" aria-busy={loading}><div className="mb-4 flex items-end justify-between"><div><MicroLabel>Live system of record</MicroLabel><p className="mt-2 text-[10px] text-[#77746c]" role="status">{data ? `${rows.length} objet(s) dans le tenant actif` : failed ? "Données non chargées" : "Chargement…"}</p></div><Link href="/assurance" className="flex items-center gap-2 text-[9px] font-medium">Ouvrir Assurance studio <ArrowUpRight className="h-3 w-3" aria-hidden="true" /></Link></div>{failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[9px] text-[#9f2923]">{status}</div> : null}<div className="overflow-x-auto border border-[#cbc7bd]"><table className="w-full min-w-[760px] border-collapse text-left"><caption className="sr-only">{details.title}</caption><thead><tr className="bg-[#e9e5db]">{details.columns.map(([, label]) => <th scope="col" key={label} className="border-b border-e border-[#cbc7bd] px-4 py-3 font-mono text-[7px] uppercase tracking-wider text-[#77746c]">{label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)} className="hover:bg-[#eeeadf]">{details.columns.map(([key]) => <td key={key} className="max-w-[340px] border-b border-e border-[#d8d4ca] px-4 py-4 text-[9px]"><Cell name={key} value={row[key]} /></td>)}</tr>)}</tbody></table>{data && rows.length === 0 ? <div className="grid min-h-52 place-items-center text-[9px] text-[#85827a]"><Database className="mb-2 h-5 w-5" aria-hidden="true" />Aucun objet enregistré</div> : null}{loading ? <div className="grid min-h-52 place-items-center text-[9px] text-[#85827a]">Chargement…</div> : null}</div></section></div>;
}

function Cell({ name, value }: { name: string; value: unknown }) {
  if (value === null || value === undefined) return <span className="text-[#aaa79f]">—</span>;
  if (name.includes("loss") && typeof value === "number") return <span className="font-mono">{new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value)}</span>;
  if (typeof value === "boolean" || typeof value === "number") return <span className="font-mono">{typeof value === "boolean" ? (value ? "PASS" : "FAIL") : value}</span>;
  const text = String(value);
  return <span className={name === "severity" || name === "status" || name === "grade" ? "font-mono uppercase text-[#f05a32]" : ""}>{text.length > 90 ? `${text.slice(0, 90)}…` : text}</span>;
}
