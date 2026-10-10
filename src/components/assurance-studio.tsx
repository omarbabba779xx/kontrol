"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, CircleDot, FileSearch, Network, Play, Radar, Send, ShieldCheck, Sparkles } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Evidence = { id: string; name: string; source: string; status: string; collected_at: string; score: number | null; grade: string | null; issues_json: string | null };
type Drift = { id: string; kind: string; severity: string; title: string; subject_type: string; detected_at: string };
type Contradiction = { id: string; severity: string; statement: string; explanation: string; left_ref: string; right_ref: string };
type Vendor = { id: string; name: string; tier: string; score: number; residual_risk: number | null; concentration_score: number | null; exit_readiness: number | null; findings_json: string | null };
type Twin = { id: string; name: string; change_type: string; result_json: string; created_at: string };
type AuditorRequest = { id: string; requester_name: string; subject: string; question: string; status: string; due_at: string | null };
type Snapshot = { evidence: Evidence[]; drift: Drift[]; contradictions: Contradiction[]; vendors: Vendor[]; twins: Twin[]; auditorRequests: AuditorRequest[]; controls: unknown[]; risks: unknown[]; models: unknown[]; decisions: unknown[] };
type Graph = { nodes: { assets: Array<{ id: string; name: string; type: string }>; obligations: Array<{ id: string; title: string; framework: string }>; controls: Array<{ id: string; code: string; title: string }> }; edges: Array<{ id: string; source_id: string; target_id: string; relation: string }> };

// The digital twin simulates on modelled data. It is a lab: hidden unless NEXT_PUBLIC_KONTROL_LABS=true.
const LABS = process.env.NEXT_PUBLIC_KONTROL_LABS === "true";
const allTabs = ["Signal room", "Knowledge graph", "Digital twin", "Third parties", "Auditor portal", "GRC copilot"] as const;
const tabs = allTabs.filter((name) => LABS || name !== "Digital twin");
type Tab = (typeof tabs)[number];

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export function AssuranceStudio() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [tab, setTab] = useState<Tab>("Signal room");
  const [status, setStatus] = useState("Loading the portfolio…");
  const [isPending, startTransition] = useTransition();

  function load(signal?: AbortSignal) {
    return Promise.all([fetchJson<Snapshot>("/api/assurance", { signal }), fetchJson<Graph>("/api/graph", { signal })]).then(([nextSnapshot, nextGraph]) => { setSnapshot(nextSnapshot); setGraph(nextGraph); });
  }

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then(() => setStatus("Portfolio up to date"))
      .catch((error: unknown) => { if (!isAbort(error)) setStatus(errorMessage(error, "Portfolio unavailable")); });
    return () => controller.abort();
  }, []);

  function execute(action: Record<string, unknown>, success: string) {
    startTransition(async () => {
      try {
        setStatus("Analysing…");
        await fetchJson("/api/assurance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
      } catch (error) { setStatus(errorMessage(error, "Action failed")); return; }
      try { await load(); setStatus(success); } catch (error) { setStatus(`Done, but refresh failed: ${errorMessage(error, "unknown error")}`); }
    });
  }

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  function onTabKey(event: React.KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next]);
    tabRefs.current[next]?.focus();
  }

  const avgTrust = useMemo(() => {
    const scores = snapshot?.evidence.flatMap((item) => item.score === null ? [] : [item.score]) ?? [];
    return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  }, [snapshot]);

  return (
    <div>
      <PageHeading index="10" title="Assurance studio" description="Detect what drifts, explain what contradicts itself and simulate the impact of a decision before it reaches production." meta={status} action={<Button type="button" disabled={isPending} onClick={() => execute({ action: "scan" }, "Continuous scan finished")} className="h-8 rounded-none bg-[#171713] text-[11px] text-white hover:bg-[#f05a32]"><Radar className={cn("me-1.5 h-3 w-3", isPending && "animate-spin")} />Scan now</Button>} />
      <div role="tablist" aria-label="Assurance studio" className="flex overflow-x-auto border-b border-[#cbc7bd] px-5 sm:px-7 lg:px-9">{tabs.map((item, index) => <button key={item} ref={(node) => { tabRefs.current[index] = node; }} type="button" role="tab" id={`assurance-tab-${index}`} aria-selected={tab === item} aria-controls="assurance-panel" tabIndex={tab === item ? 0 : -1} onKeyDown={(event) => onTabKey(event, index)} onClick={() => setTab(item)} className={cn("shrink-0 border-b-2 px-4 py-3 font-mono text-[10px] uppercase tracking-[.1em]", tab === item ? "border-[#f05a32] text-[#171713]" : "border-transparent text-[#85827a]")}>{item}</button>)}</div>
      <div role="tabpanel" id="assurance-panel" aria-labelledby={`assurance-tab-${tabs.indexOf(tab)}`}>
      {tab === "Signal room" ? <SignalRoom snapshot={snapshot} average={avgTrust} /> : null}
      {tab === "Knowledge graph" ? <KnowledgeGraph graph={graph} /> : null}
      {tab === "Digital twin" ? <DigitalTwin twins={snapshot?.twins ?? []} pending={isPending} execute={execute} /> : null}
      {tab === "Third parties" ? <ThirdParties vendors={snapshot?.vendors ?? []} pending={isPending} execute={execute} /> : null}
      {tab === "Auditor portal" ? <AuditorPortal requests={snapshot?.auditorRequests ?? []} pending={isPending} execute={execute} /> : null}
      {tab === "GRC copilot" ? <Copilot /> : null}
      </div>
    </div>
  );
}

function SignalRoom({ snapshot, average }: { snapshot: Snapshot | null; average: number }) {
  const metrics = [["Evidence trust", `${average || "—"}/100`], ["Drifts ouverts", snapshot?.drift.length ?? "—"], ["Contradictions", snapshot?.contradictions.length ?? "—"], ["Decisions", snapshot?.decisions.length ?? "—"]];
  return <div><section className="grid border-b border-[#cbc7bd] sm:grid-cols-4">{metrics.map(([label, value]) => <div key={label} className="border-e border-[#cbc7bd] p-5"><MicroLabel>{label}</MicroLabel><div className="mt-2 font-mono text-3xl tracking-[-.07em]">{value}</div></div>)}</section><div className="grid xl:grid-cols-2"><Panel title="Compliance drift" icon={<Radar className="h-4 w-4" />}><SignalList items={(snapshot?.drift ?? []).map((item) => ({ id: item.id, severity: item.severity, title: item.title, detail: `${item.kind} · ${item.subject_type}` }))} empty="No drift detected" /></Panel><Panel title="Contradiction engine" icon={<AlertTriangle className="h-4 w-4" />}><SignalList items={(snapshot?.contradictions ?? []).map((item) => ({ id: item.id, severity: item.severity, title: item.statement, detail: item.explanation }))} empty="No open contradiction" /></Panel></div><Panel title="Evidence trust ledger" icon={<ShieldCheck className="h-4 w-4" />}><div className="grid gap-px bg-[#cbc7bd] lg:grid-cols-3">{snapshot && snapshot.evidence.length === 0 ? <p className="bg-[#f4f1e9] p-4 text-[11px] text-[#85827a]">No evidence collected</p> : null}{(snapshot?.evidence ?? []).map((item) => <article key={item.id} className="bg-[#f4f1e9] p-4"><div className="flex items-start justify-between gap-3"><span className="text-[12px] font-medium">{item.name}</span><span className="font-mono text-xl">{item.grade ?? "—"}</span></div><div className="mt-4 h-1 bg-[#d8d4ca]"><div className={cn("h-full", (item.score ?? 0) >= 75 ? "bg-[#2d6a4f]" : "bg-[#f05a32]")} style={{ width: `${Math.min(100, Math.max(0, item.score ?? 0))}%` }} /></div><p className="mt-2 font-mono text-[10px] text-[#827f77]">{item.score ?? 0}/100 · {item.source}</p></article>)}</div></Panel></div>;
}

function KnowledgeGraph({ graph }: { graph: Graph | null }) {
  const nodes = graph ? [...graph.nodes.obligations.map((item) => ({ ...item, label: item.framework, kind: "obligation" })), ...graph.nodes.controls.map((item) => ({ ...item, name: item.title, label: item.code, kind: "control" })), ...graph.nodes.assets.map((item) => ({ ...item, label: item.type, kind: "asset" }))] : [];
  return <div className="grid grid-cols-1 min-h-[640px] lg:grid-cols-[1fr_310px]"><div className="relative overflow-hidden border-e border-[#cbc7bd] bg-[radial-gradient(#cbc7bd_1px,transparent_1px)] [background-size:20px_20px]"><div className="grid min-h-[640px] grid-cols-3 items-center gap-12 p-10">{["obligation", "control", "asset"].map((kind) => <div key={kind} className="space-y-6"><MicroLabel>{kind}</MicroLabel>{nodes.filter((node) => node.kind === kind).map((node, index) => <div key={node.id} className={cn("relative border p-4 shadow-[4px_4px_0_#d3cfc5]", kind === "control" ? "border-[#f05a32] bg-[#fff8f1]" : "border-[#98958d] bg-[#f4f1e9]")}><span className="font-mono text-[10px] uppercase text-[#8b887f]">{node.label}</span><p className="mt-2 text-[12px] font-medium">{"name" in node ? node.name : node.title}</p>{index === 0 && kind !== "asset" ? <ArrowRight className="absolute -end-9 top-1/2 h-4 w-4 text-[#f05a32]" /> : null}</div>)}</div>)}</div></div><aside className="p-6"><Network className="h-5 w-5" /><h2 className="mt-3 text-xl font-medium tracking-[-.04em]">Explainable graph</h2><p className="mt-3 text-[12px] leading-5 text-[#706d65]">{nodes.length} objects and {graph?.edges.length ?? 0} relations. Each edge keeps its confidence, its justification, its source and its validity period.</p><div className="mt-6 space-y-2">{graph?.edges.map((edge) => <div key={edge.id} className="border-t border-[#cbc7bd] py-3"><p className="font-mono text-[10px] uppercase text-[#f05a32]">{edge.relation}</p><p className="mt-1 truncate text-[10px] text-[#77746d]">{edge.source_id} → {edge.target_id}</p></div>)}</div></aside></div>;
}

function DigitalTwin({ twins, pending, execute }: { twins: Twin[]; pending: boolean; execute: (action: Record<string, unknown>, success: string) => void }) {
  const [type, setType] = useState("cloud_incident"); const [magnitude, setMagnitude] = useState(1);
  return <div className="grid grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)]"><section className="border-e border-b border-[#cbc7bd] p-7"><MicroLabel>What-if engine</MicroLabel><h2 className="mt-2 text-2xl font-medium tracking-[-.04em]">Simulate a change</h2><label className="mt-7 block text-[11px]">Type of change<select value={type} onChange={(event) => setType(event.target.value)} className="mt-2 h-10 w-full border border-[#aaa69d] bg-transparent px-3 text-[12px]">{["new_vendor","ai_release","regulatory_change","control_removed","cloud_incident","country_expansion"].map((item) => <option key={item}>{item}</option>)}</select></label><label className="mt-5 block text-[11px]">Magnitude × {magnitude.toFixed(2)}<input className="mt-3 w-full accent-[#f05a32]" type="range" min="0.25" max="3" step="0.25" value={magnitude} onChange={(event) => setMagnitude(Number(event.target.value))} /></label><Button type="button" disabled={pending} onClick={() => execute({ action: "simulate_twin", name: `${type} scenario`, changeType: type, magnitude }, "Simulation recorded")} className="mt-7 h-10 w-full rounded-none bg-[#171713] text-white"><Play className="me-2 h-3 w-3" />Run the simulation</Button></section><section className="p-7"><MicroLabel>Scenario history</MicroLabel><div className="mt-4 space-y-3">{twins.length === 0 ? <p className="text-[11px] text-[#85827a]">No simulation recorded</p> : null}{twins.map((item) => { const result = parseJson<{ baselineP90: number; projectedP90: number; delta: number; recommendation: string }>(item.result_json, { baselineP90: 0, projectedP90: 0, delta: 0, recommendation: "indisponible" }); return <article key={item.id} className="grid grid-cols-1 gap-4 border border-[#cbc7bd] p-5 sm:grid-cols-[1fr_repeat(3,auto)]"><div><p className="text-[13px] font-medium">{item.name}</p><p className="mt-1 font-mono text-[10px] text-[#85827a]">{item.change_type}</p></div><Metric label="Baseline P90" value={euro(result.baselineP90)} /><Metric label="Projected P90" value={euro(result.projectedP90)} /><Metric label="Decision" value={result.recommendation.replaceAll("_", " ")} /></article>; })}</div></section></div>;
}

function ThirdParties({ vendors, pending, execute }: { vendors: Vendor[]; pending: boolean; execute: (action: Record<string, unknown>, success: string) => void }) { return <section className="p-7"><div className="flex items-end justify-between"><div><MicroLabel>Fourth-party intelligence</MicroLabel><h2 className="mt-2 text-2xl font-medium tracking-[-.04em]">Concentration and exit capability</h2></div><Button type="button" disabled={pending} onClick={() => execute({ action: "assess_vendors" }, "Third-party portfolio re-assessed")} variant="outline" className="rounded-none border-[#171713]">Re-assess</Button></div>{vendors.length === 0 ? <p className="mt-7 text-[11px] text-[#85827a]">No third party recorded</p> : null}<div className="mt-7 grid gap-px border border-[#cbc7bd] bg-[#cbc7bd] lg:grid-cols-3">{vendors.map((vendor) => <article key={vendor.id} className="bg-[#f4f1e9] p-5"><div className="flex justify-between"><span className="text-sm font-medium">{vendor.name}</span><span className="font-mono text-[10px] uppercase text-[#f05a32]">{vendor.tier}</span></div><div className="mt-8 grid grid-cols-3 gap-2"><Metric label="Residual" value={`${vendor.residual_risk ?? "—"}`} /><Metric label="Concentration" value={`${vendor.concentration_score ?? "—"}`} /><Metric label="Exit" value={`${vendor.exit_readiness ?? "—"}`} /></div><p className="mt-5 min-h-10 text-[11px] leading-4 text-[#77746c]">{vendor.findings_json ? parseJson<string[]>(vendor.findings_json, []).join(" · ") : "Assessment required"}</p></article>)}</div></section>; }

function AuditorPortal({ requests, pending, execute }: { requests: AuditorRequest[]; pending: boolean; execute: (action: Record<string, unknown>, success: string) => void }) { const [question, setQuestion] = useState("Provide the latest evidence supporting production branch protection."); const [requesterName, setRequesterName] = useState("External Assurance Team"); const [requesterEmail, setRequesterEmail] = useState("auditor@example.com"); const valid = requesterName.trim().length >= 2 && /^\S+@\S+\.\S+$/.test(requesterEmail) && question.trim().length >= 10; return <div className="grid grid-cols-1 lg:grid-cols-[390px_minmax(0,1fr)]"><section className="border-e border-b border-[#cbc7bd] p-7"><FileSearch className="h-5 w-5" /><h2 className="mt-3 text-xl font-medium">New audit request</h2><Input value={requesterName} onChange={(event) => setRequesterName(event.target.value)} aria-label="Auditor name" className="mt-6 rounded-none" id="auditor-name" /><Input type="email" value={requesterEmail} onChange={(event) => setRequesterEmail(event.target.value)} aria-label="Auditor email" className="mt-3 rounded-none" id="auditor-email" /><Textarea aria-label="Auditor question" value={question} onChange={(event) => setQuestion(event.target.value)} className="mt-3 min-h-28 rounded-none" /><Button type="button" disabled={pending || !valid} onClick={() => execute({ action: "auditor_request", requesterName: requesterName.trim(), requesterEmail: requesterEmail.trim(), subject: "Production controls", question, scope: ["CTL-SDLC-004", "asset_repo_lending"] }, "Audit request recorded")} className="mt-3 w-full rounded-none bg-[#171713] text-white"><Send className="me-2 h-3 w-3" />Submit</Button></section><section className="p-7"><MicroLabel>Secure request room</MicroLabel><div className="mt-4">{requests.length === 0 ? <p className="text-[11px] text-[#85827a]">No audit request</p> : null}{requests.map((request) => <article key={request.id} className="grid grid-cols-1 border-t border-[#cbc7bd] py-4 sm:grid-cols-[1fr_auto]"><div><p className="text-[12px] font-medium">{request.subject}</p><p className="mt-2 max-w-2xl text-[11px] text-[#77746c]">{request.question}</p><p className="mt-2 font-mono text-[10px] text-[#99968e]">{request.requester_name}</p></div><div className="mt-2 flex items-start gap-2 sm:mt-0"><span className="border border-[#aaa69d] px-2 py-1 font-mono text-[10px] uppercase">{request.status}</span>{request.status === "open" ? <button type="button" disabled={pending} onClick={() => execute({ action: "auditor_respond", requestId: request.id, response: "A signed assurance pack containing scoped controls, evidence hashes and decision records is attached.", status: "answered" }, "Audit answer sealed")} className="border border-[#171713] px-2 py-1 font-mono text-[10px] uppercase hover:bg-[#171713] hover:text-white">Answer</button> : <a href={`/api/auditor/pack?id=${encodeURIComponent(request.id)}`} className="border border-[#171713] px-2 py-1 font-mono text-[10px] uppercase hover:bg-[#171713] hover:text-white">Pack</a>}</div></article>)}</div></section></div>; }

function Copilot() {
  const [question, setQuestion] = useState("Why does the branch protection control fail, and what decision do you recommend?");
  const [answer, setAnswer] = useState("The copilot only queries the graph and the evidence of the active organisation.");
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  function ask() {
    startTransition(async () => {
      try {
        setFailed(false);
        const result = await fetchJson<{ answer: string; confidence: number | null; mode: string }>("/api/agents/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "contradiction_detector", question }) });
        setAnswer(`${result.answer}\n\nMode: ${result.mode} · confidence: ${result.confidence ?? "model"}`);
      } catch (error) { setFailed(true); setAnswer(errorMessage(error, "Analysis failed")); }
    });
  }
  return <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px]"><section className="min-h-[600px] border-e border-[#cbc7bd] p-7"><div className="flex gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center bg-[#171713] text-white"><Bot className="h-4 w-4" aria-hidden="true" /></span><div role={failed ? "alert" : "status"} aria-live="polite" aria-busy={pending} className={cn("max-w-3xl whitespace-pre-wrap border p-5 text-[12px] leading-5", failed ? "border-[#b8322a] bg-[#f5e5e1]" : "border-[#cbc7bd] bg-[#ebe7dd]")}>{pending ? "Analysing…" : answer}</div></div><div className="mt-6 flex max-w-4xl gap-2"><Textarea aria-label="Question for the copilot" value={question} onChange={(event) => setQuestion(event.target.value)} className="min-h-20 rounded-none" /><Button type="button" aria-label="Ask" onClick={ask} disabled={pending || question.trim().length < 3} className="h-20 rounded-none bg-[#f05a32] text-white"><Sparkles className="h-4 w-4" aria-hidden="true" /></Button></div></section><aside className="p-7"><MicroLabel>Guardrails</MicroLabel>{["Internal sources only", "Read-only tools", "Explicit assumptions", "Human approval required", "No legal conclusion"].map((item) => <div key={item} className="flex gap-2 border-b border-[#cbc7bd] py-3 text-[11px]"><CheckCircle2 className="h-3.5 w-3.5 text-[#2d6a4f]" aria-hidden="true" />{item}</div>)}</aside></div>;
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="border-b border-e border-[#cbc7bd] p-5 sm:p-7"><div className="mb-5 flex items-center gap-2">{icon}<h2 className="text-sm font-semibold">{title}</h2></div>{children}</section>; }
function SignalList({ items, empty }: { items: Array<{ id: string; severity: string; title: string; detail: string }>; empty: string }) { return items.length ? <div>{items.map((item) => <div key={item.id} className="grid grid-cols-[58px_minmax(0,1fr)] gap-3 border-t border-[#cbc7bd] py-4"><span className={cn("font-mono text-[10px] uppercase", item.severity === "critical" || item.severity === "high" ? "text-[#c43d2d]" : "text-[#a37424]")}>{item.severity}</span><div><p className="text-[12px] font-medium">{item.title}</p><p className="mt-1 text-[10px] leading-4 text-[#7d7a72]">{item.detail}</p></div></div>)}</div> : <div className="grid min-h-32 place-items-center border border-dashed border-[#cbc7bd] text-[11px] text-[#85827a]"><CircleDot className="h-4 w-4 text-[#2d6a4f]" />{empty}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div><MicroLabel>{label}</MicroLabel><div className="mt-1 max-w-36 truncate font-mono text-[12px]">{value}</div></div>; }
function euro(value: number) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0, notation: "compact" }).format(value); }
