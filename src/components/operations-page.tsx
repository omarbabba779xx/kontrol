"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Activity, ArrowRight, Check, Database, Fingerprint, GitBranch, Play, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { PageHeading, MicroLabel } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Snapshot = {
  counts: { assets: number; controls: number; evidence: number; openFindings: number; decisions: number; obligations: number };
  audit: { valid: boolean; checked: number; rootHash?: string | null };
  connectors: Array<{ id: string; kind: string; name: string; status: string; last_sync_at: string | null }>;
  workflows: Array<{ id: string; kind: string; state: string; current_step: string; attempts: number }>;
  findings: Array<{ id: string; title: string; severity: string; status: string; control_code: string }>;
  activity: Array<{ sequence: number; action: string; object_type: string; entry_hash: string; created_at: string }>;
};

const actionCopy: Record<string, string> = { github: "GitHub", aws: "AWS", okta: "Okta" };

export function OperationsPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [message, setMessage] = useState("Initialisation du noyau de contrôle…");
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    const response = await fetch("/api/platform/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error("Snapshot indisponible");
    setSnapshot(await response.json());
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/platform/snapshot", { cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error("Snapshot indisponible"); return response.json() as Promise<Snapshot>; })
      .then((data) => { if (!cancelled) { setSnapshot(data); setMessage("Noyau opérationnel"); } })
      .catch((error: Error) => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, []);

  function run(action: "github" | "aws" | "okta" | "workflow") {
    startTransition(async () => {
      try {
        setMessage(`${actionCopy[action] ?? "Workflow"} en cours…`);
        if (action === "workflow") {
          const created = await fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "continuous_control", payload: { connector: "github", owner: "acme", repository: "lending-decision-service", demo: true } }) });
          if (!created.ok) throw new Error("Création du workflow impossible");
          const workflow = await created.json() as { id: string };
          for (let index = 0; index < 4; index += 1) await fetch(`/api/workflows/${workflow.id}/run`, { method: "POST" });
          setMessage("Workflow exécuté avec piste d’audit");
        } else {
          const response = await fetch(`/api/connectors/${action}/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: action === "github" ? JSON.stringify({ owner: "acme", repository: "lending-decision-service", assetId: "asset_repo_lending", demo: true }) : "{}" });
          if (!response.ok) throw new Error(`Synchronisation ${actionCopy[action]} impossible`);
          setMessage(`${actionCopy[action]} synchronisé; preuves horodatées`);
        }
        await refresh();
      } catch (error) { setMessage(error instanceof Error ? error.message : "Action impossible"); }
    });
  }

  const metrics = snapshot ? [
    ["Actifs", snapshot.counts.assets], ["Contrôles", snapshot.counts.controls], ["Preuves", snapshot.counts.evidence],
    ["Constats ouverts", snapshot.counts.openFindings], ["Décisions signées", snapshot.counts.decisions], ["Obligations", snapshot.counts.obligations],
  ] : [];

  return (
    <div>
      <PageHeading index="09" title="Control plane" description="Le plan d’exploitation du produit : connecteurs, évaluations continues, intégrité cryptographique et orchestration durable — observable en un seul endroit." meta={message} action={<Button onClick={() => refresh()} disabled={isPending} variant="outline" className="h-8 rounded-none border-[#171713] bg-transparent text-[9px]"><RefreshCw className={cn("me-1.5 h-3 w-3", isPending && "animate-spin")} />Actualiser</Button>} />

      <section className="grid border-b border-[#cbc7bd] sm:grid-cols-3 xl:grid-cols-6">
        {metrics.map(([label, value]) => <div key={label} className="border-e border-b border-[#cbc7bd] px-5 py-5 sm:border-b-0"><MicroLabel>{label}</MicroLabel><div className="mt-2 font-mono text-2xl tracking-[-.06em]">{value}</div></div>)}
      </section>

      <div className="grid xl:grid-cols-[1.15fr_.85fr]">
        <section className="border-b border-[#cbc7bd] p-5 sm:p-7 xl:border-e">
          <div className="mb-5 flex items-end justify-between"><div><MicroLabel>Evidence automation</MicroLabel><h2 className="mt-2 text-xl font-medium tracking-[-.04em]">Connecteurs actifs</h2></div><GitBranch className="h-5 w-5 text-[#827f77]" /></div>
          <div className="grid gap-px border border-[#cbc7bd] bg-[#cbc7bd] md:grid-cols-3">
            {(["github", "aws", "okta"] as const).map((kind) => {
              const connector = snapshot?.connectors.find((item) => item.kind === kind);
              return <article key={kind} className="bg-[#f4f1e9] p-4"><div className="flex items-center justify-between"><span className="font-mono text-[10px] uppercase">{actionCopy[kind]}</span><span className={cn("h-2 w-2 rounded-full", connector?.status === "healthy" ? "bg-[#2d6a4f]" : "bg-[#d49a35]")} /></div><p className="mt-7 min-h-8 text-[9px] leading-4 text-[#77746d]">{connector?.last_sync_at ? `Dernier sync ${new Date(connector.last_sync_at).toLocaleString("fr-FR")}` : "Prêt pour la première collecte"}</p><Button onClick={() => run(kind)} disabled={isPending} className="mt-3 h-8 w-full rounded-none bg-[#171713] text-[9px] text-white hover:bg-[#f05a32]"><Play className="me-1.5 h-3 w-3" />Collecter</Button></article>;
            })}
          </div>
          <button onClick={() => run("workflow")} disabled={isPending} className="mt-4 flex w-full items-center justify-between border border-[#171713] p-4 text-start transition-colors hover:bg-[#171713] hover:text-white disabled:opacity-50"><span><span className="block font-mono text-[9px] uppercase tracking-wider">Continuous control workflow</span><span className="mt-1 block text-[10px] opacity-60">Collecte → évaluation → constat → clôture</span></span><ArrowRight className="h-4 w-4" /></button>
        </section>

        <section className="border-b border-[#cbc7bd] p-5 sm:p-7">
          <div className="flex items-center justify-between"><div><MicroLabel>Append-only ledger</MicroLabel><h2 className="mt-2 text-xl font-medium tracking-[-.04em]">Intégrité de la piste</h2></div>{snapshot?.audit.valid ? <ShieldCheck className="h-6 w-6 text-[#2d6a4f]" /> : <TriangleAlert className="h-6 w-6 text-[#b83a2e]" />}</div>
          <div className="mt-5 border border-[#cbc7bd] bg-[#ebe7dd] p-4"><div className="flex items-center gap-2 text-[11px] font-medium"><Fingerprint className="h-4 w-4" />{snapshot?.audit.valid ? "Chaîne vérifiée" : "Vérification en attente"}</div><p className="mt-2 font-mono text-[8px] leading-4 text-[#716e67]">{snapshot?.audit.rootHash ?? "Aucune entrée"}</p><p className="mt-3 text-[9px] text-[#817e76]">{snapshot?.audit.checked ?? 0} événements recalculés depuis le bloc genesis.</p></div>
          <div className="mt-4 space-y-2">{snapshot?.activity.slice(0, 5).map((item) => <div key={item.sequence} className="grid grid-cols-[28px_1fr_auto] items-center border-b border-[#d7d3c9] py-2 text-[9px]"><span className="font-mono text-[#a09d95]">{String(item.sequence).padStart(3, "0")}</span><span>{item.action}</span><span className="font-mono text-[7px] text-[#8f8c84]">{item.entry_hash.slice(0, 10)}</span></div>)}</div>
        </section>
      </div>

      <div className="grid xl:grid-cols-2">
        <section className="border-b border-[#cbc7bd] p-5 sm:p-7 xl:border-e"><div className="mb-4 flex items-center gap-2"><Activity className="h-4 w-4" /><h2 className="text-sm font-semibold">Workflows durables</h2></div>{snapshot?.workflows.length ? snapshot.workflows.map((item) => <div key={item.id} className="grid grid-cols-[1fr_auto] border-t border-[#cbc7bd] py-3"><div><p className="text-[10px] font-medium">{item.kind.replaceAll("_", " ")}</p><p className="mt-1 font-mono text-[8px] text-[#8b887f]">{item.current_step} · tentative {item.attempts}</p></div><span className="self-center border border-[#aaa69d] px-2 py-1 font-mono text-[7px] uppercase">{item.state}</span></div>) : <Empty label="Aucun workflow exécuté" />}</section>
        <section className="border-b border-[#cbc7bd] p-5 sm:p-7"><div className="mb-4 flex items-center gap-2"><Database className="h-4 w-4" /><h2 className="text-sm font-semibold">Constats générés par politique</h2></div>{snapshot?.findings.length ? snapshot.findings.map((item) => <div key={item.id} className="grid grid-cols-[64px_1fr_auto] items-center border-t border-[#cbc7bd] py-3 text-[9px]"><span className="font-mono text-[#f05a32]">{item.control_code}</span><span>{item.title}</span><span className="uppercase text-[#77746c]">{item.severity}</span></div>) : <Empty label="Aucun constat ouvert" />}</section>
      </div>
    </div>
  );
}

function Empty({ label }: { label: string }) { return <div className="grid min-h-24 place-items-center border border-dashed border-[#c5c1b7] text-[9px] text-[#8a877f]"><Check className="mb-1 h-4 w-4 text-[#2d6a4f]" />{label}</div>; }
