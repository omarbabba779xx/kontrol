"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, CircleDot, FileSearch, Network, Play, Radar, Send, ShieldCheck, Sparkles } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Evidence = { id: string; name: string; source: string; status: string; collected_at: string; score: number | null; grade: string | null; issues_json: string | null };
type Drift = { id: string; kind: string; severity: string; title: string; subject_type: string; detected_at: string };
type Contradiction = { id: string; severity: string; statement: string; explanation: string; left_ref: string; right_ref: string };
type Vendor = { id: string; name: string; tier: string; score: number; residual_risk: number | null; concentration_score: number | null; exit_readiness: number | null; findings_json: string | null };
type Twin = { id: string; name: string; change_type: string; result_json: string; created_at: string };
type AuditorRequest = { id: string; requester_name: string; subject: string; question: string; status: string; due_at: string | null };
type Snapshot = { evidence: Evidence[]; drift: Drift[]; contradictions: Contradiction[]; vendors: Vendor[]; twins: Twin[]; auditorRequests: AuditorRequest[]; controls: unknown[]; risks: unknown[]; models: unknown[]; decisions: unknown[] };
type Graph = { nodes: { assets: Array<{ id: string; name: string; type: string }>; obligations: Array<{ id: string; title: string; framework: string }>; controls: Array<{ id: string; code: string; title: string }> }; edges: Array<{ id: string; source_id: string; target_id: string; relation: string }> };

const tabs = ["Signal room", "Knowledge graph", "Digital twin", "Third parties", "Auditor portal", "GRC copilot"] as const;
type Tab = (typeof tabs)[number];

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? `Request failed (${response.status})`); }
  return response.json() as Promise<T>;
}

export function AssuranceStudio() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [tab, setTab] = useState<Tab>("Signal room");
  const [status, setStatus] = useState("Chargement du portefeuille…");
  const [isPending, startTransition] = useTransition();

  function refresh() {
    return Promise.all([jsonFetch<Snapshot>("/api/assurance"), jsonFetch<Graph>("/api/graph")]).then(([nextSnapshot, nextGraph]) => { setSnapshot(nextSnapshot); setGraph(nextGraph); });
  }

  useEffect(() => {
    let active = true;
    Promise.all([jsonFetch<Snapshot>("/api/assurance"), jsonFetch<Graph>("/api/graph")])
      .then(([nextSnapshot, nextGraph]) => { if (active) { setSnapshot(nextSnapshot); setGraph(nextGraph); setStatus("Portefeuille synchronisé"); } })
      .catch((error: Error) => { if (active) setStatus(error.message); });
    return () => { active = false; };
  }, []);

  function execute(action: Record<string, unknown>, success: string) {
    startTransition(async () => {
      try {
        setStatus("Analyse en cours…");
        await jsonFetch("/api/assurance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
        await refresh();
        setStatus(success);
      } catch (error) { setStatus(error instanceof Error ? error.message : "Action impossible"); }
    });
  }

  const avgTrust = useMemo(() => {
    const scores = snapshot?.evidence.flatMap((item) => item.score === null ? [] : [item.score]) ?? [];
    return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0;
  }, [snapshot]);

  return (
    <div>
      <PageHeading index="10" title="Assurance studio" description="Détecter ce qui dérive, expliquer ce qui se contredit et simuler l’impact d’une décision avant qu’elle n’atteigne la production." meta={status} action={<Button disabled={isPending} onClick={() => execute({ action: "scan" }, "Scan continu terminé")} className="h-8 rounded-none bg-[#171713] text-[9px] text-white hover:bg-[#f05a32]"><Radar className={cn("me-1.5 h-3 w-3", isPending && "animate-spin")} />Scanner maintenant</Button>} />
      <div className="flex overflow-x-auto border-b border-[#cbc7bd] px-5 sm:px-7 lg:px-9">{tabs.map((item) => <button key={item} onClick={() => setTab(item)} className={cn("shrink-0 border-b-2 px-4 py-3 font-mono text-[8px] uppercase tracking-[.1em]", tab === item ? "border-[#f05a32] text-[#171713]" : "border-transparent text-[#85827a]")}>{item}</button>)}</div>
      {tab === "Signal room" ? <SignalRoom snapshot={snapshot} average={avgTrust} /> : null}
      {tab === "Knowledge graph" ? <KnowledgeGraph graph={graph} /> : null}
      {tab === "Digital twin" ? <DigitalTwin twins={snapshot?.twins ?? []} pending={isPending} execute={execute} /> : null}
      {tab === "Third parties" ? <ThirdParties vendors={snapshot?.vendors ?? []} pending={isPending} execute={execute} /> : null}
      {tab === "Auditor portal" ? <AuditorPortal requests={snapshot?.auditorRequests ?? []} pending={isPending} execute={execute} /> : null}
      {tab === "GRC copilot" ? <Copilot /> : null}
    </div>
  );
}

function SignalRoom({ snapshot, average }: { snapshot: Snapshot | null; average: number }) {
  const metrics = [["Evidence trust", `${average || "—"}/100`], ["Drifts ouverts", snapshot?.drift.length ?? "—"], ["Contradictions", snapshot?.contradictions.length ?? "—"], ["Décisions", snapshot?.decisions.length ?? "—"]];
  return <div><section className="grid border-b border-[#cbc7bd] sm:grid-cols-4">{metrics.map(([label, value]) => <div key={label} className="border-e border-[#cbc7bd] p-5"><MicroLabel>{label}</MicroLabel><div className="mt-2 font-mono text-3xl tracking-[-.07em]">{value}</div></div>)}</section><div className="grid xl:grid-cols-2"><Panel title="Compliance drift" icon={<Radar className="h-4 w-4" />}><SignalList items={(snapshot?.drift ?? []).map((item) => ({ id: item.id, severity: item.severity, title: item.title, detail: `${item.kind} · ${item.subject_type}` }))} empty="Aucune dérive détectée" /></Panel><Panel title="Contradiction engine" icon={<AlertTriangle className="h-4 w-4" />}><SignalList items={(snapshot?.contradictions ?? []).map((item) => ({ id: item.id, severity: item.severity, title: item.statement, detail: item.explanation }))} empty="Aucune contradiction ouverte" /></Panel></div><Panel title="Evidence trust ledger" icon={<ShieldCheck className="h-4 w-4" />}><div className="grid gap-px bg-[#cbc7bd] lg:grid-cols-3">{(snapshot?.evidence ?? []).map((item) => <article key={item.id} className="bg-[#f4f1e9] p-4"><div className="flex items-start justify-between gap-3"><span className="text-[10px] font-medium">{item.name}</span><span className="font-mono text-xl">{item.grade ?? "—"}</span></div><div className="mt-4 h-1 bg-[#d8d4ca]"><div className={cn("h-full", (item.score ?? 0) >= 75 ? "bg-[#2d6a4f]" : "bg-[#f05a32]")} style={{ width: `${item.score ?? 0}%` }} /></div><p className="mt-2 font-mono text-[7px] text-[#827f77]">{item.score ?? 0}/100 · {item.source}</p></article>)}</div></Panel></div>;
}

function KnowledgeGraph({ graph }: { graph: Graph | null }) {
  const nodes = graph ? [...graph.nodes.obligations.map((item) => ({ ...item, label: item.framework, kind: "obligation" })), ...graph.nodes.controls.map((item) => ({ ...item, name: item.title, label: item.code, kind: "control" })), ...graph.nodes.assets.map((item) => ({ ...item, label: item.type, kind: "asset" }))] : [];
  return <div className="grid min-h-[640px] lg:grid-cols-[1fr_310px]"><div className="relative overflow-hidden border-e border-[#cbc7bd] bg-[radial-gradient(#cbc7bd_1px,transparent_1px)] [background-size:20px_20px]"><div className="grid min-h-[640px] grid-cols-3 items-center gap-12 p-10">{["obligation", "control", "asset"].map((kind) => <div key={kind} className="space-y-6"><MicroLabel>{kind}</MicroLabel>{nodes.filter((node) => node.kind === kind).map((node, index) => <div key={node.id} className={cn("relative border p-4 shadow-[4px_4px_0_#d3cfc5]", kind === "control" ? "border-[#f05a32] bg-[#fff8f1]" : "border-[#98958d] bg-[#f4f1e9]")}><span className="font-mono text-[7px] uppercase text-[#8b887f]">{node.label}</span><p className="mt-2 text-[10px] font-medium">{"name" in node ? node.name : node.title}</p>{index === 0 && kind !== "asset" ? <ArrowRight className="absolute -end-9 top-1/2 h-4 w-4 text-[#f05a32]" /> : null}</div>)}</div>)}</div></div><aside className="p-6"><Network className="h-5 w-5" /><h2 className="mt-3 text-xl font-medium tracking-[-.04em]">Graphe explicable</h2><p className="mt-3 text-[10px] leading-5 text-[#706d65]">{nodes.length} objets et {graph?.edges.length ?? 0} relations. Chaque arête conserve sa confiance, sa justification, sa source et sa période de validité.</p><div className="mt-6 space-y-2">{graph?.edges.map((edge) => <div key={edge.id} className="border-t border-[#cbc7bd] py-3"><p className="font-mono text-[8px] uppercase text-[#f05a32]">{edge.relation}</p><p className="mt-1 truncate text-[8px] text-[#77746d]">{edge.source_id} → {edge.target_id}</p></div>)}</div></aside></div>;
}

function DigitalTwin({ twins, pending, execute }: { twins: Twin[]; pending: boolean; execute: (action: Record<string, unknown>, success: string) => void }) {
  const [type, setType] = useState("cloud_incident"); const [magnitude, setMagnitude] = useState(1);
  return <div className="grid lg:grid-cols-[380px_1fr]"><section className="border-e border-b border-[#cbc7bd] p-7"><MicroLabel>What-if engine</MicroLabel><h2 className="mt-2 text-2xl font-medium tracking-[-.04em]">Simuler un changement</h2><label className="mt-7 block text-[9px]">Type de changement<select value={type} onChange={(event) => setType(event.target.value)} className="mt-2 h-10 w-full border border-[#aaa69d] bg-transparent px-3 text-[10px]">{["new_vendor","ai_release","regulatory_change","control_removed","cloud_incident","country_expansion"].map((item) => <option key={item}>{item}</option>)}</select></label><label className="mt-5 block text-[9px]">Magnitude × {magnitude.toFixed(2)}<input className="mt-3 w-full accent-[#f05a32]" type="range" min="0.25" max="3" step="0.25" value={magnitude} onChange={(event) => setMagnitude(Number(event.target.value))} /></label><Button disabled={pending} onClick={() => execute({ action: "simulate_twin", name: `${type} scenario`, changeType: type, magnitude }, "Simulation enregistrée")} className="mt-7 h-10 w-full rounded-none bg-[#171713] text-white"><Play className="me-2 h-3 w-3" />Lancer la simulation</Button></section><section className="p-7"><MicroLabel>Scenario history</MicroLabel><div className="mt-4 space-y-3">{twins.map((item) => { const result = JSON.parse(item.result_json) as { baselineP90: number; projectedP90: number; delta: number; recommendation: string }; return <article key={item.id} className="grid gap-4 border border-[#cbc7bd] p-5 sm:grid-cols-[1fr_repeat(3,auto)]"><div><p className="text-[11px] font-medium">{item.name}</p><p className="mt-1 font-mono text-[8px] text-[#85827a]">{item.change_type}</p></div><Metric label="Baseline P90" value={euro(result.baselineP90)} /><Metric label="Projected P90" value={euro(result.projectedP90)} /><Metric label="Decision" value={result.recommendation.replaceAll("_", " ")} /></article>; })}</div></section></div>;
}

function ThirdParties({ vendors, pending, execute }: { vendors: Vendor[]; pending: boolean; execute: (action: Record<string, unknown>, success: string) => void }) { return <section className="p-7"><div className="flex items-end justify-between"><div><MicroLabel>Fourth-party intelligence</MicroLabel><h2 className="mt-2 text-2xl font-medium tracking-[-.04em]">Concentration et capacité de sortie</h2></div><Button disabled={pending} onClick={() => execute({ action: "assess_vendors" }, "Portefeuille tiers réévalué")} variant="outline" className="rounded-none border-[#171713]">Réévaluer</Button></div><div className="mt-7 grid gap-px border border-[#cbc7bd] bg-[#cbc7bd] lg:grid-cols-3">{vendors.map((vendor) => <article key={vendor.id} className="bg-[#f4f1e9] p-5"><div className="flex justify-between"><span className="text-sm font-medium">{vendor.name}</span><span className="font-mono text-[8px] uppercase text-[#f05a32]">{vendor.tier}</span></div><div className="mt-8 grid grid-cols-3 gap-2"><Metric label="Residual" value={`${vendor.residual_risk ?? "—"}`} /><Metric label="Concentration" value={`${vendor.concentration_score ?? "—"}`} /><Metric label="Exit" value={`${vendor.exit_readiness ?? "—"}`} /></div><p className="mt-5 min-h-10 text-[9px] leading-4 text-[#77746c]">{vendor.findings_json ? (JSON.parse(vendor.findings_json) as string[]).join(" · ") : "Assessment required"}</p></article>)}</div></section>; }

function AuditorPortal({ requests, pending, execute }: { requests: AuditorRequest[]; pending: boolean; execute: (action: Record<string, unknown>, success: string) => void }) { const [question, setQuestion] = useState("Provide the latest evidence supporting production branch protection."); return <div className="grid lg:grid-cols-[390px_1fr]"><section className="border-e border-b border-[#cbc7bd] p-7"><FileSearch className="h-5 w-5" /><h2 className="mt-3 text-xl font-medium">Nouvelle demande d’audit</h2><Input defaultValue="External Assurance Team" aria-label="Nom de l'auditeur" className="mt-6 rounded-none" id="auditor-name" /><Input defaultValue="auditor@example.com" aria-label="E-mail de l'auditeur" className="mt-3 rounded-none" id="auditor-email" /><Textarea value={question} onChange={(event) => setQuestion(event.target.value)} className="mt-3 min-h-28 rounded-none" /><Button disabled={pending} onClick={() => execute({ action: "auditor_request", requesterName: "External Assurance Team", requesterEmail: "auditor@example.com", subject: "Production controls", question, scope: ["CTL-SDLC-004", "asset_repo_lending"] }, "Demande d’audit enregistrée")} className="mt-3 w-full rounded-none bg-[#171713] text-white"><Send className="me-2 h-3 w-3" />Soumettre</Button></section><section className="p-7"><MicroLabel>Secure request room</MicroLabel><div className="mt-4">{requests.map((request) => <article key={request.id} className="grid border-t border-[#cbc7bd] py-4 sm:grid-cols-[1fr_auto]"><div><p className="text-[10px] font-medium">{request.subject}</p><p className="mt-2 max-w-2xl text-[9px] text-[#77746c]">{request.question}</p><p className="mt-2 font-mono text-[7px] text-[#99968e]">{request.requester_name}</p></div><div className="mt-2 flex items-start gap-2 sm:mt-0"><span className="border border-[#aaa69d] px-2 py-1 font-mono text-[7px] uppercase">{request.status}</span>{request.status === "open" ? <button disabled={pending} onClick={() => execute({ action: "auditor_respond", requestId: request.id, response: "A signed assurance pack containing scoped controls, evidence hashes and decision records is attached.", status: "answered" }, "Réponse d’audit scellée")} className="border border-[#171713] px-2 py-1 font-mono text-[7px] uppercase hover:bg-[#171713] hover:text-white">Répondre</button> : <a href={`/api/auditor/pack?id=${request.id}`} className="border border-[#171713] px-2 py-1 font-mono text-[7px] uppercase hover:bg-[#171713] hover:text-white">Pack</a>}</div></article>)}</div></section></div>; }

function Copilot() { const [question, setQuestion] = useState("Pourquoi le contrôle de protection de branche échoue-t-il et quelle décision recommandez-vous ?"); const [answer, setAnswer] = useState("Le copilote interroge uniquement le graphe et les preuves du tenant actif."); const [pending, startTransition] = useTransition(); function ask() { startTransition(async () => { try { const result = await jsonFetch<{ answer: string; confidence: number | null; mode: string }>("/api/agents/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "contradiction_detector", question }) }); setAnswer(`${result.answer}\n\nMode: ${result.mode} · confiance: ${result.confidence ?? "modèle"}`); } catch (error) { setAnswer(error instanceof Error ? error.message : "Analyse impossible"); } }); } return <div className="grid lg:grid-cols-[1fr_360px]"><section className="min-h-[600px] border-e border-[#cbc7bd] p-7"><div className="flex gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center bg-[#171713] text-white"><Bot className="h-4 w-4" /></span><div className="max-w-3xl whitespace-pre-wrap border border-[#cbc7bd] bg-[#ebe7dd] p-5 text-[10px] leading-5">{answer}</div></div><div className="mt-6 flex max-w-4xl gap-2"><Textarea value={question} onChange={(event) => setQuestion(event.target.value)} className="min-h-20 rounded-none" /><Button onClick={ask} disabled={pending} className="h-20 rounded-none bg-[#f05a32] text-white"><Sparkles className="h-4 w-4" /></Button></div></section><aside className="p-7"><MicroLabel>Guardrails</MicroLabel>{["Sources internes uniquement", "Outils en lecture seule", "Hypothèses explicites", "Approbation humaine obligatoire", "Aucune conclusion juridique"].map((item) => <div key={item} className="flex gap-2 border-b border-[#cbc7bd] py-3 text-[9px]"><CheckCircle2 className="h-3.5 w-3.5 text-[#2d6a4f]" />{item}</div>)}</aside></div>; }

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <section className="border-b border-e border-[#cbc7bd] p-5 sm:p-7"><div className="mb-5 flex items-center gap-2">{icon}<h2 className="text-sm font-semibold">{title}</h2></div>{children}</section>; }
function SignalList({ items, empty }: { items: Array<{ id: string; severity: string; title: string; detail: string }>; empty: string }) { return items.length ? <div>{items.map((item) => <div key={item.id} className="grid grid-cols-[58px_1fr] gap-3 border-t border-[#cbc7bd] py-4"><span className={cn("font-mono text-[7px] uppercase", item.severity === "critical" || item.severity === "high" ? "text-[#c43d2d]" : "text-[#a37424]")}>{item.severity}</span><div><p className="text-[10px] font-medium">{item.title}</p><p className="mt-1 text-[8px] leading-4 text-[#7d7a72]">{item.detail}</p></div></div>)}</div> : <div className="grid min-h-32 place-items-center border border-dashed border-[#cbc7bd] text-[9px] text-[#85827a]"><CircleDot className="h-4 w-4 text-[#2d6a4f]" />{empty}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div><MicroLabel>{label}</MicroLabel><div className="mt-1 max-w-36 truncate font-mono text-[10px]">{value}</div></div>; }
function euro(value: number) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0, notation: "compact" }).format(value); }
