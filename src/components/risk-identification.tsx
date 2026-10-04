"use client";

import { useCallback, useEffect, useState } from "react";
import { MicroLabel } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Act = (body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => void;
type Valuation = { confidentiality: number; integrity: number; availability: number };
type Threat = { id: string; family: string; title: string; affects: string[]; controls: string[] };
type Asset = { id: string; name: string; type: string; criticality: string; valuation: Valuation | null; value: number | null; toConsider: string[]; assessed: Array<{ threatId: string; ref: string }> };
type Identification = { assets: Asset[]; threats: Threat[]; coverage: { assets: number; valued: number; scenarios: number } };
type Trace = {
  adoptedFrameworks: string[];
  risks: Array<{ ref: string; title: string; asset: { name: string } | null; threat: { event: string } | null; residual: { band: string; score: number }; treatment: string; controls: Array<{ code: string; status: string; verification: string; requirements: Record<string, string[]> }> }>;
  breaks: { risksWithoutControl: string[]; risksWithoutAsset: string[]; mitigationWithoutPlan: string[]; untreated: string[]; controlsNotLinkedToARisk: string[] };
};

const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[10px] focus-visible:outline-2 focus-visible:outline-[#171713]";
const button = "h-8 rounded-none border-[#171713] bg-transparent text-[9px]";
const levels = [1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>);

function useView<T>(url: string, version: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback((signal?: AbortSignal) => fetchJson<T>(url, { signal }).then(setData), [url]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((problem: unknown) => { if (!isAbort(problem)) setError(errorMessage(problem, "Unavailable")); });
    return () => controller.abort();
  }, [load, version]);
  return { data, error };
}

/** Asset-based identification: value each asset, then assess the threats that apply to it. */
export function RiskIdentification({ act, pending, nist, version }: { act: Act; pending: boolean; nist: boolean; version: number }) {
  const { data, error } = useView<Identification>("/api/risk-register?view=identification", version);
  const [valuation, setValuation] = useState<Record<string, Valuation>>({});
  const [scenario, setScenario] = useState<Record<string, { threatId: string; likelihood: number; initiation: number; adverse: number }>>({});
  if (error) return <p role="alert" className="border border-[#b8322a] bg-[#f5e5e1] p-3 text-[9px] text-[#9f2923]">{error}</p>;
  if (!data) return <p className="text-[9px] text-[#63615a]">Loading…</p>;
  const threatOf = (id: string) => data.threats.find((threat) => threat.id === id);
  return (
    <div className="space-y-4">
      <p className="text-[9px] text-[#55534b]">{data.coverage.valued} of {data.coverage.assets} asset(s) valued · {data.coverage.scenarios} scenario(s) assessed. The impact of a scenario follows the value of the asset for the properties the threat affects; you judge the likelihood.</p>
      <ul className="space-y-3">
        {data.assets.map((asset) => {
          const value = valuation[asset.id] ?? asset.valuation ?? { confidentiality: 3, integrity: 3, availability: 3 };
          const entry = scenario[asset.id] ?? { threatId: asset.toConsider[0] ?? "", likelihood: 3, initiation: 3, adverse: 3 };
          const threat = threatOf(entry.threatId);
          const setValue = (patch: Partial<Valuation>) => setValuation((current) => ({ ...current, [asset.id]: { ...value, ...patch } }));
          const setEntry = (patch: Partial<typeof entry>) => setScenario((current) => ({ ...current, [asset.id]: { ...entry, ...patch } }));
          return (
            <li key={asset.id} className="border border-[#cbc7bd] p-3 text-[10px]">
              <p><span className="font-semibold">{asset.name}</span> <span className="text-[9px] text-[#55534b]">{asset.type} · {asset.valuation ? `valued C${asset.valuation.confidentiality} I${asset.valuation.integrity} A${asset.valuation.availability}` : "not valued yet"} · {asset.assessed.length} scenario(s){asset.assessed.length ? `: ${asset.assessed.map((item) => item.ref).join(", ")}` : ""}</span></p>
              <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); act({ action: "value_asset", assetId: asset.id, ...value }, "Asset valued"); }}>
                {(["confidentiality", "integrity", "availability"] as const).map((dimension) => <label key={dimension} className="text-[8px] capitalize">{dimension}<select aria-label={`${dimension} of ${asset.name}`} value={value[dimension]} onChange={(event) => setValue({ [dimension]: Number(event.target.value) })} className={cn(select, "block w-20")}>{levels}</select></label>)}
                <Button type="submit" variant="outline" disabled={pending} className={button}>Save valuation</Button>
              </form>
              {asset.valuation && asset.toConsider.length ? (
                <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); act({ action: "scenario", assetId: asset.id, threatId: entry.threatId, ...(nist ? { likelihoodInitiation: entry.initiation, likelihoodImpact: entry.adverse } : { likelihood: entry.likelihood }) }, "Scenario recorded as a risk"); }}>
                  <label className="text-[8px]">Threat to assess ({asset.toConsider.length} left)<select aria-label={`Threat on ${asset.name}`} value={entry.threatId} onChange={(event) => setEntry({ threatId: event.target.value })} className={cn(select, "block w-72")}>{asset.toConsider.map((id) => <option key={id} value={id}>{threatOf(id)?.title ?? id}</option>)}</select></label>
                  {nist ? <><label className="text-[8px]">Initiation<select aria-label={`Initiation likelihood on ${asset.name}`} value={entry.initiation} onChange={(event) => setEntry({ initiation: Number(event.target.value) })} className={cn(select, "block w-16")}>{levels}</select></label><label className="text-[8px]">Adverse impact<select aria-label={`Adverse impact likelihood on ${asset.name}`} value={entry.adverse} onChange={(event) => setEntry({ adverse: Number(event.target.value) })} className={cn(select, "block w-16")}>{levels}</select></label></> : <label className="text-[8px]">Likelihood<select aria-label={`Likelihood on ${asset.name}`} value={entry.likelihood} onChange={(event) => setEntry({ likelihood: Number(event.target.value) })} className={cn(select, "block w-16")}>{levels}</select></label>}
                  <Button type="submit" variant="outline" disabled={pending || !entry.threatId} className={button}>Assess scenario</Button>
                  {threat ? <span className="basis-full text-[9px] text-[#55534b]">Affects {threat.affects.join(", ")} · usual controls: {threat.controls.join(", ")}</span> : null}
                </form>
              ) : null}
            </li>
          );
        })}
        {data.assets.length === 0 ? <li className="border border-[#cbc7bd] p-3 text-[9px] text-[#63615a]">No asset in the inventory yet.</li> : null}
      </ul>
    </div>
  );
}

/** The thread from asset and threat to risk, control and requirement, and the places where it breaks. */
export function RiskTraceability({ version }: { version: number }) {
  const { data, error } = useView<Trace>("/api/risk-register?view=traceability", version);
  if (error) return <p role="alert" className="border border-[#b8322a] bg-[#f5e5e1] p-3 text-[9px] text-[#9f2923]">{error}</p>;
  if (!data) return <p className="text-[9px] text-[#63615a]">Loading…</p>;
  const breaks: Array<[string, string[]]> = [["Risks with no control", data.breaks.risksWithoutControl], ["Risks with no asset", data.breaks.risksWithoutAsset], ["Mitigations with no plan", data.breaks.mitigationWithoutPlan], ["Untreated risks", data.breaks.untreated], ["Claimed controls treating no recorded risk", data.breaks.controlsNotLinkedToARisk]];
  return (
    <div className="space-y-4">
      <div className="grid gap-px border border-[#cbc7bd] bg-[#cbc7bd] sm:grid-cols-2 lg:grid-cols-5">
        {breaks.map(([label, items]) => <div key={label} className="bg-[#f4f1e9] p-3"><MicroLabel>{label}</MicroLabel><p className={cn("mt-1 font-mono text-lg font-semibold", items.length > 0 && "text-[#9f2923]")}>{items.length}</p><p className="mt-1 break-words font-mono text-[8px] text-[#55534b]">{items.slice(0, 12).join(" ")}{items.length > 12 ? " …" : ""}</p></div>)}
      </div>
      <div tabIndex={0} role="region" aria-label="Traceability table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]">
        <table className="w-full min-w-[820px] text-left text-[9px]">
          <caption className="sr-only">Risk traceability</caption>
          <thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["Risk", "Asset", "Threat", "Residual", "Treatment", "Controls and the requirements they satisfy"].map((heading) => <th key={heading} scope="col" className="px-3 py-2.5">{heading}</th>)}</tr></thead>
          <tbody>
            {data.risks.map((risk) => (
              <tr key={risk.ref} className="border-t border-[#d8d4ca] align-top">
                <td className="px-3 py-3"><span className="font-mono font-semibold">{risk.ref}</span><span className="block">{risk.title}</span></td>
                <td className="px-3 py-3">{risk.asset?.name ?? "—"}</td>
                <td className="px-3 py-3">{risk.threat?.event ?? "—"}</td>
                <td className="px-3 py-3 font-mono">{risk.residual.band} ({risk.residual.score})</td>
                <td className="px-3 py-3">{risk.treatment}</td>
                <td className="px-3 py-3">{risk.controls.length ? risk.controls.map((control) => <span key={control.code} className="mb-1 block"><span className="font-mono font-semibold">{control.code}</span> <span className="text-[#55534b]">{control.status}, {control.verification}</span> {Object.entries(control.requirements).map(([framework, ids]) => <span key={framework} className="ms-1 border border-[#cbc7bd] px-1 font-mono text-[7px]" title={ids.join(", ")}>{framework}: {ids.slice(0, 4).join(" ")}{ids.length > 4 ? " …" : ""}</span>)}</span>) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.risks.length === 0 ? <p className="p-6 text-center text-[10px] text-[#5f5d56]">No open risk.</p> : null}
      </div>
    </div>
  );
}
