"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import { ChevronDown, ListPlus, Plus, Wand2 } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";
import { bandFor, THREAT_SOURCES, type RiskMethod } from "@/lib/core/risk-method";

type Band = "low" | "medium" | "high" | "critical";
type Risk = {
  id: string; ref: string; title: string; description: string; category: string; asset: string; owner_id: string | null; likelihood: number; impact: number;
  treatment: string; treatment_plan: string; target_date: string | null; status: string; accepted_by: string | null; accepted_until: string | null; acceptance_note: string | null; source_type: string;
  fair: { mean: number | null; p90: number; p50?: number; p95?: number; currency?: string } | null;
  inherent: { score: number; band: Band }; residual: { likelihood: number; impact: number; score: number; band: Band; reduction: number; controlsConsidered: number };
  controls: Array<{ code: string; title: string; status: string; verification: string }>; acceptanceExpired: boolean; treatmentOverdue: boolean; effectiveStatus: string; aboveAppetite: boolean; needsThreatDescription: boolean; threat_event: string | null;
};
type Method = RiskMethod & { approved: boolean };
type Snapshot = { risks: Risk[]; method: Method; heat: { inherent: number[][]; residual: number[][] }; summary: { open: number; critical: number; high: number; untreated: number; acceptanceExpired: number; quantified: number; aboveAppetite: number; needsThreatDescription: number; annualLossMean: number; annualLossP90Indicative: number } };
type Person = { id: string; name: string; role: string; external: boolean };

const CATEGORIES = ["cyber", "privacy", "third_party", "ai", "resilience", "compliance", "operational"];
const BAND: Record<Band, string> = { low: "bg-[#dcebe1] text-[#245c3f]", medium: "bg-[#f1e7cc] text-[#7a5a1a]", high: "bg-[#f6e3d3] text-[#944a15]", critical: "bg-[#f5e5e1] text-[#9f2923]" };
const CELL: Record<Band, string> = { low: "bg-[#dcebe1]", medium: "bg-[#f1e7cc]", high: "bg-[#f0cdb0]", critical: "bg-[#e9b4ab]" };
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[10px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[10px] focus-visible:outline-2 focus-visible:outline-[#171713]";
const euro = (value: number | null | undefined) => (value === null || value === undefined ? "—" : new Intl.NumberFormat("en", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value));
const day = (value: string | null) => (value ? value.slice(0, 10) : "—");
const label = (value: string) => value.replace(/_/g, " ");

type Act = (body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => void;

export function RiskRegister() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [view, setView] = useState<"residual" | "inherent">("residual");
  const [status, setStatus] = useState("Loading…");
  const [failed, setFailed] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [isPending, startTransition] = useTransition();

  const load = useCallback((signal?: AbortSignal) => fetchJson<Snapshot>("/api/risk-register", { signal }).then((data) => { setSnapshot(data); setFailed(false); }), []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(() => setStatus("Up to date")).catch((error: unknown) => { if (!isAbort(error)) { setFailed(true); setStatus(errorMessage(error, "Risk register unavailable")); } });
    fetchJson<{ users: Person[] }>("/api/users", { signal: controller.signal }).then((data) => setPeople(data.users.filter((person) => !person.external))).catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  const act: Act = (body, success, after) => {
    startTransition(async () => {
      let result: Record<string, unknown> = {};
      try { setStatus("Saving…"); result = await fetchJson<Record<string, unknown>>("/api/risk-register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
      catch (error) { setStatus(errorMessage(error, "Action failed")); return; }
      try { await load(); setStatus(success); after?.(result); } catch (error) { setStatus(`Done, but refresh failed: ${errorMessage(error, "unknown error")}`); }
    });
  };

  const risks = (snapshot?.risks ?? []).filter((risk) => showClosed || risk.status !== "closed").sort((a, b) => b.residual.score - a.residual.score || a.ref.localeCompare(b.ref));
  const s = snapshot?.summary;
  return (
    <div>
      <PageHeading index="17" title="Risk register" description="Risks rated by the method your organisation approved (a 5×5 matrix or NIST SP 800-30), linked to the controls that treat them. Residual risk follows the live compliance posture; acceptance needs another person, expires, and above the appetite needs an administrator." meta={status} />
      <section className="p-5 sm:p-7 lg:p-9" aria-busy={snapshot === null && !failed}>
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[9px] text-[#9f2923]">{status}</div> : null}
        {snapshot && s ? (
          <div className="space-y-6">
            <div className="grid gap-px border border-[#cbc7bd] bg-[#cbc7bd] sm:grid-cols-4 lg:grid-cols-7">
              {([["Open risks", s.open], ["Critical residual", s.critical], ["High residual", s.high], ["Untreated", s.untreated], ["Above appetite", s.aboveAppetite], ["Acceptance lapsed", s.acceptanceExpired], ["Quantified", s.quantified]] as const).map(([name, value]) => <div key={name} className="bg-[#f4f1e9] p-4"><MicroLabel>{name}</MicroLabel><p className={cn("mt-1 font-mono text-[22px] font-semibold", (name === "Critical residual" || name === "Acceptance lapsed") && value > 0 && "text-[#b8322a]")}>{value}</p></div>)}
            </div>
            <div className="grid gap-8 xl:grid-cols-[360px_1fr]">
              <div className="space-y-4">
                <div className="border border-[#cbc7bd] p-4">
                  <div className="flex items-center justify-between"><MicroLabel>Heat map</MicroLabel>
                    <div role="group" aria-label="Heat map view" className="flex text-[9px]">{(["residual", "inherent"] as const).map((name) => <button key={name} type="button" aria-pressed={view === name} onClick={() => setView(name)} className={cn("border border-[#cbc7bd] px-2 py-1 capitalize", view === name && "bg-[#171713] text-white")}>{name}</button>)}</div></div>
                  <HeatMap grid={snapshot.heat[view]} method={snapshot.method} />
                  {s.quantified > 0 ? <p className="mt-3 text-[9px] text-[#55534b]">Quantified: mean {euro(s.annualLossMean)} a year, P90 {euro(s.annualLossP90Indicative)} (indicative: the sum of separate simulations is not a portfolio simulation, because risks are not independent).</p> : null}
                </div>
                <MethodPanel method={snapshot.method} needsThreat={s.needsThreatDescription} act={act} pending={isPending} />
                <NewRisk people={people} act={act} pending={isPending} nist={snapshot.method.method === "nist_800_30"} />
                <a href="/api/risk-register?format=treatment-plan" download className="flex h-8 items-center justify-center border border-[#171713] text-[9px] font-semibold hover:bg-[#171713] hover:text-white">Risk treatment plan (CSV)</a>
                <Button type="button" variant="outline" disabled={isPending} onClick={() => act({ action: "from_gaps", limit: 10 }, "Risks created from control gaps")} className="h-8 w-full rounded-none border-[#171713] bg-transparent text-[9px]"><Wand2 className="me-1.5 h-3 w-3" aria-hidden="true" />Create risks from control gaps</Button>
              </div>
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-[9px]"><input type="checkbox" checked={showClosed} onChange={(event) => setShowClosed(event.target.checked)} />Show closed risks</label>
                <div tabIndex={0} role="region" aria-label="Risks table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[820px] text-left text-[9px]"><caption className="sr-only">Risk register</caption>
                  <thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["Ref", "Risk", "Inherent", "Residual", "Treatment", "Status", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
                  <tbody>{risks.map((risk) => <RiskRow key={risk.id} risk={risk} people={people} act={act} pending={isPending} />)}</tbody></table>
                  {risks.length === 0 ? <p className="p-8 text-center text-[10px] text-[#5f5d56]">No risks yet. Add one, or create them from your control gaps.</p> : null}</div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function HeatMap({ grid, method }: { grid: number[][]; method: RiskMethod }) {
  const row = "grid grid-cols-[28px_repeat(5,1fr)] gap-0.5 text-center font-mono text-[8px]";
  return (
    <div className="mt-3 space-y-0.5" role="table" aria-label="Likelihood by impact">
      {[5, 4, 3, 2, 1].map((likelihood) => (
        <div key={likelihood} role="row" className={row}>
          <span role="rowheader" className="grid place-items-center text-[#5f5d56]">L{likelihood}</span>
          {[1, 2, 3, 4, 5].map((impact) => { const count = grid[likelihood - 1][impact - 1]; return <span key={impact} role="cell" aria-label={`Likelihood ${likelihood}, impact ${impact}: ${count} risk${count === 1 ? "" : "s"}`} className={cn("grid h-9 place-items-center", CELL[bandFor(method, likelihood, impact)], count > 0 && "font-bold ring-1 ring-[#171713]")}>{count || ""}</span>; })}
        </div>))}
      <div role="row" className={row}><span role="columnheader"><span className="sr-only">Likelihood</span></span>{[1, 2, 3, 4, 5].map((impact) => <span key={impact} role="columnheader" className="pt-1 text-[#5f5d56]">I{impact}</span>)}</div>
    </div>
  );
}

function MethodPanel({ method, needsThreat, act, pending }: { method: Method; needsThreat: number; act: Act; pending: boolean }) {
  const [form, setForm] = useState({ method: method.method, medium: method.thresholds.medium, high: method.thresholds.high, critical: method.thresholds.critical, appetite: method.appetite, maxAcceptanceDays: method.maxAcceptanceDays });
  const number = (key: "medium" | "high" | "critical" | "maxAcceptanceDays", name: string) => <label className="flex-1 text-[8px]">{name}<Input aria-label={name} type="number" value={form[key]} onChange={(event) => setForm({ ...form, [key]: Number(event.target.value) })} className={field} /></label>;
  return (
    <details className="border border-[#cbc7bd] p-4">
      <summary className="cursor-pointer font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Risk method and appetite</summary>
      <p className="mt-3 text-[9px] text-[#55534b]">{method.method === "nist_800_30" ? "NIST SP 800-30" : "Likelihood × impact matrix (ISO/IEC 27005 style)"} · appetite: {method.appetite} · {method.approved ? `version ${method.version}, approved on ${day(method.approvedAt)}` : "built-in defaults, not approved by your organisation"}.{needsThreat > 0 ? ` ${needsThreat} open risk(s) still need their threat description.` : ""}</p>
      <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); act({ action: "set_method", method: form.method, thresholds: { medium: form.medium, high: form.high, critical: form.critical }, appetite: form.appetite, maxAcceptanceDays: form.maxAcceptanceDays }, "Risk method approved"); }}>
        <div className="flex gap-2">
          <label className="flex-1 text-[8px]">Method<select aria-label="Method" value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value as RiskMethod["method"] })} className={cn(select, "w-full")}><option value="iso27005">Matrix (ISO/IEC 27005)</option><option value="nist_800_30">NIST SP 800-30</option></select></label>
          <label className="flex-1 text-[8px]">Appetite<select aria-label="Appetite" value={form.appetite} onChange={(event) => setForm({ ...form, appetite: event.target.value as RiskMethod["appetite"] })} className={cn(select, "w-full")}>{["low", "medium", "high"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        </div>
        <div className="flex gap-2">{number("medium", "Medium from")}{number("high", "High from")}{number("critical", "Critical from")}{number("maxAcceptanceDays", "Max acceptance (days)")}</div>
        <p className="text-[8px] text-[#63615a]">Thresholds are scores (likelihood × impact) and apply to the matrix method; SP 800-30 uses its own tables. Setting the method is a management decision: it needs an administrator and is versioned.</p>
        <Button type="submit" variant="outline" disabled={pending} className="h-8 w-full rounded-none border-[#171713] bg-transparent text-[9px]">Approve method</Button>
      </form>
    </details>
  );
}

function NewRisk({ people, act, pending, nist }: { people: Person[]; act: Act; pending: boolean; nist: boolean }) {
  const [form, setForm] = useState({ title: "", category: "cyber", likelihood: 3, impact: 3, ownerId: "", controls: "", threatSource: "adversarial", threatEvent: "", vulnerability: "", likelihoodInitiation: 3, likelihoodImpact: 3 });
  const codes = form.controls.split(/[\s,]+/).map((item) => item.trim().toUpperCase()).filter(Boolean);
  return (
    <details className="border border-[#cbc7bd] p-4">
      <summary className="cursor-pointer font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Add a risk</summary>
      <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); act({ action: "create", title: form.title, category: form.category, impact: form.impact, ownerId: form.ownerId || undefined, controls: codes, ...(nist ? { threatSource: form.threatSource, threatEvent: form.threatEvent, vulnerability: form.vulnerability || undefined, likelihoodInitiation: form.likelihoodInitiation, likelihoodImpact: form.likelihoodImpact } : { likelihood: form.likelihood }) }, "Risk added", () => setForm({ ...form, title: "", controls: "", threatEvent: "", vulnerability: "" })); }}>
        <Input aria-label="Risk title" placeholder="Risk (cause, event, consequence)" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={field} />
        <div className="flex gap-2">
          <select aria-label="Category" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} className={cn(select, "flex-1")}>{CATEGORIES.map((value) => <option key={value} value={value}>{label(value)}</option>)}</select>
          <select aria-label="Owner" value={form.ownerId} onChange={(event) => setForm({ ...form, ownerId: event.target.value })} className={cn(select, "flex-1")}><option value="">No owner</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
        </div>
        <div className="flex gap-2">
          {nist ? (
            <>
              <label className="flex-1 text-[8px]">Initiation (1-5)<select aria-label="Likelihood of initiation" value={form.likelihoodInitiation} onChange={(event) => setForm({ ...form, likelihoodInitiation: Number(event.target.value) })} className={cn(select, "w-full")}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <label className="flex-1 text-[8px]">Adverse impact (1-5)<select aria-label="Likelihood of adverse impact" value={form.likelihoodImpact} onChange={(event) => setForm({ ...form, likelihoodImpact: Number(event.target.value) })} className={cn(select, "w-full")}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            </>
          ) : (
            <label className="flex-1 text-[8px]">Likelihood (1-5)<select aria-label="Likelihood" value={form.likelihood} onChange={(event) => setForm({ ...form, likelihood: Number(event.target.value) })} className={cn(select, "w-full")}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          )}
          <label className="flex-1 text-[8px]">Impact (1-5)<select aria-label="Impact" value={form.impact} onChange={(event) => setForm({ ...form, impact: Number(event.target.value) })} className={cn(select, "w-full")}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        </div>
        {nist ? (
          <>
            <div className="flex gap-2">
              <select aria-label="Threat source" value={form.threatSource} onChange={(event) => setForm({ ...form, threatSource: event.target.value })} className={cn(select, "w-36")}>{THREAT_SOURCES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
              <Input aria-label="Threat event" required placeholder="Threat event" value={form.threatEvent} onChange={(event) => setForm({ ...form, threatEvent: event.target.value })} className={cn(field, "flex-1")} />
            </div>
            <Input aria-label="Vulnerability" placeholder="Vulnerability or predisposing condition" value={form.vulnerability} onChange={(event) => setForm({ ...form, vulnerability: event.target.value })} className={field} />
          </>
        ) : null}
        <Input aria-label="Linked controls" placeholder="Controls: UC-OPS-02, UC-DAT-05" value={form.controls} onChange={(event) => setForm({ ...form, controls: event.target.value })} className={cn(field, "font-mono")} />
        <Button type="submit" disabled={pending || form.title.trim().length < 3} className="h-8 w-full rounded-none bg-[#171713] text-[10px] text-white"><Plus className="me-1.5 h-3 w-3" aria-hidden="true" />Add risk</Button>
      </form>
    </details>
  );
}

function RiskRow({ risk, people, act, pending }: { risk: Risk; people: Person[]; act: Act; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [days, setDays] = useState(90);
  const [plan, setPlan] = useState(risk.treatment_plan);
  const closed = risk.status === "closed";
  const owner = people.find((person) => person.id === risk.owner_id)?.name;
  return (
    <>
      <tr className={cn("border-t border-[#d8d4ca] align-top", closed && "opacity-50")}>
        <td className="px-3 py-3 font-mono font-semibold">{risk.ref}</td>
        <td className="max-w-[300px] px-3 py-3"><span className="font-medium">{risk.title}</span><span className="block font-mono text-[8px] text-[#5f5d56]">{label(risk.category)}{owner ? ` · ${owner}` : " · no owner"}{risk.source_type === "gap" ? " · from gap" : ""}</span></td>
        <td className="px-3 py-3"><span className={cn("px-1.5 py-0.5 font-mono text-[8px] uppercase", BAND[risk.inherent.band])}>{risk.inherent.score} {risk.inherent.band}</span></td>
        <td className="px-3 py-3"><span className={cn("px-1.5 py-0.5 font-mono text-[8px] uppercase", BAND[risk.residual.band])}>{risk.residual.score} {risk.residual.band}</span></td>
        <td className="px-3 py-3 font-mono">{risk.treatment}</td>
        <td className="px-3 py-3 font-mono">{risk.acceptanceExpired ? <span className="font-bold text-[#b8322a]">lapsed</span> : risk.treatmentOverdue ? <span className="font-bold text-[#b8322a]">overdue</span> : risk.status}{risk.status === "accepted" && !risk.acceptanceExpired ? <span className="block text-[8px] text-[#5f5d56]">until {day(risk.accepted_until)}</span> : null}</td>
        <td className="px-3 py-3 text-end"><Button type="button" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)} className="h-6 rounded-none px-1 text-[8px]">Details <ChevronDown className={cn("ms-0.5 h-2.5 w-2.5 transition-transform", open && "rotate-180")} aria-hidden="true" /></Button></td>
      </tr>
      {open ? <tr className="bg-[#f1eee5]"><td colSpan={7} className="px-5 py-4"><div className="grid max-w-4xl gap-6 md:grid-cols-2">
        <div className="space-y-2 text-[9px]">
          {risk.description ? <p className="whitespace-pre-wrap text-[#34332e]">{risk.description}</p> : null}
          <p className="font-mono text-[8px] uppercase text-[#5f5d56]">Controls treating this risk</p>
          {risk.controls.map((control) => <p key={control.code} className="flex justify-between border-b border-[#d8d4ca] py-1"><span><span className="font-mono">{control.code}</span> {control.title}</span><span className="font-mono text-[8px]">{label(control.status)} · {control.verification}</span></p>)}
          {risk.controls.length === 0 ? <p className="text-[#5f5d56]">No control linked: nothing reduces this risk, so residual equals inherent.</p> : <p className="text-[#55534b]">Controls reduce likelihood by {Math.round(risk.residual.reduction * 100)}% (capped at 80%; an attestation without evidence counts for 70%). Impact is not reduced.</p>}
          {risk.fair ? <p className="text-[#34332e]">Quantified: P50 {euro(risk.fair.p50)}, mean {euro(risk.fair.mean)}, P90 {euro(risk.fair.p90)}, P95 {euro(risk.fair.p95)} a year. A simulation under stated assumptions, not a forecast.</p> : null}
          {risk.status === "accepted" ? <p className="border-s-2 border-[#7a5a1a] ps-2">Accepted until {day(risk.accepted_until)}: “{risk.acceptance_note}”</p> : null}
        </div>
        {!closed ? <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <select aria-label={`Treatment of ${risk.ref}`} value={risk.treatment === "accept" ? "undecided" : risk.treatment} disabled={pending} onChange={(event) => act({ action: "update", id: risk.id, treatment: event.target.value }, "Treatment updated")} className={select}>{["undecided", "mitigate", "transfer", "avoid"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
            <select aria-label={`Owner of ${risk.ref}`} value={risk.owner_id ?? ""} disabled={pending} onChange={(event) => act({ action: "update", id: risk.id, ownerId: event.target.value || null }, "Owner updated")} className={select}><option value="">No owner</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
          </div>
          <Textarea aria-label={`Treatment plan of ${risk.ref}`} value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="Treatment plan" className="min-h-14 rounded-none text-[10px] placeholder:text-[#63615a]" />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={pending || plan === risk.treatment_plan} onClick={() => act({ action: "update", id: risk.id, treatmentPlan: plan }, "Plan saved")} className="h-7 rounded-none border-[#171713] bg-transparent text-[9px]">Save plan</Button>
            {risk.treatment === "mitigate" ? <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "treatment_task", id: risk.id }, "Treatment task created")} className="h-7 rounded-none border-[#171713] bg-transparent text-[9px]"><ListPlus className="me-1 h-3 w-3" aria-hidden="true" />Create task</Button> : null}
            <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "quantify", id: risk.id, scenario: { name: `${risk.ref} scenario`, materialDecision: risk.impact >= 4, sensitiveData: risk.category === "privacy" || risk.impact >= 4, humanReview: false, thirdPartyModel: risk.category === "third_party", crossBorder: false, annualEvents: 60000 * risk.likelihood, iterations: 10000 } }, "Quantified")} className="h-7 rounded-none border-[#171713] bg-transparent text-[9px]">Quantify (FAIR)</Button>
          </div>
          <Textarea aria-label={`Decision note for ${risk.ref}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Decision note (10+ characters)" className="min-h-12 rounded-none text-[10px] placeholder:text-[#63615a]" />
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label={`Acceptance duration for ${risk.ref}`} value={days} onChange={(event) => setDays(Number(event.target.value))} className={select}>{[30, 90, 180, 365].map((value) => <option key={value} value={value}>{value} days</option>)}</select>
            <Button type="button" disabled={pending || note.trim().length < 10} onClick={() => act({ action: "accept", id: risk.id, days, note }, "Risk accepted", () => setNote(""))} className="h-7 rounded-none bg-[#7a5a1a] text-[9px] text-white">Accept risk</Button>
            <Button type="button" variant="outline" disabled={pending || note.trim().length < 10} onClick={() => { if (window.confirm("Close this risk? It can no longer change.")) act({ action: "close", id: risk.id, note }, "Risk closed", () => setNote("")); }} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[9px] text-[#b8322a]">Close</Button>
          </div>
        </div> : null}
      </div></td></tr> : null}
    </>
  );
}
