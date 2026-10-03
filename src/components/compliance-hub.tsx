"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Download, FileCheck2, FileText, Layers, Link2, Plug, Plus, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type FrameworkId = "iso27001" | "nist_csf" | "soc2" | "gdpr" | "nis2" | "dora" | "eu_ai_act" | "iso42001" | "pci_dss" | "cis_v8";
type Status = "not_started" | "planned" | "partial" | "implemented" | "not_applicable";
type ReqStatus = "compliant" | "partial" | "initial" | "gap" | "not_applicable";
type ReadinessLevel = "not_ready" | "in_progress" | "ready_with_reservations" | "audit_ready";
type Assessment = { dimensions: { declared: number; documentary: number; technical: number; backed: number }; blockers: string[]; reservations: string[]; nextSteps: string[]; criteria: Array<{ id: string; label: string; met: boolean; blocking: boolean; value: string; threshold: string }>; scope: { controls: number; requirements: number; excluded: number; excludedShare: number; scoreWithoutExclusions: number; exclusionEffect: number } };
type Score = { frameworkId: FrameworkId; score: number; verifiedShare: number; applicable: number; compliant: number; partial: number; gaps: number; notApplicable: number; readiness: string; readinessLevel: ReadinessLevel; declaredBand: string; assessment: Assessment; groups: Array<{ group: string; score: number; applicable: number }> };
type EvidenceItem = { id: string; uc_code: string; title: string; kind: string; content_hash: string; note: string; valid_until: string; uploaded_by: string; uploaded_at: string; status: "pending" | "accepted" | "rejected"; reviewed_by: string | null; review_note: string | null };
type ImportRecord = { id: string; framework_id: string; source_label: string; licence_reference: string; acknowledged_by: string; acknowledged_at: string; items: number; content_hash: string };
type Control = { code: string; title: string; domain: string; domainLabel: string; description: string; status: Status; maturity: number; linkedControlCode: string | null; notes: string; source: string; verification: string; excepted: boolean; reviewDue: string | null; attestedBy: string | null; attestedAt: string | null; countersignedBy: string | null; attestationExpired: boolean; awaitingCountersignature: boolean; frameworks: Array<{ frameworkId: string; requirements: number }> };
type Roadmap = { code: string; title: string; domain: string; currentStatus: Status; verification: string; effort: number; leverage: number; priority: number; closes: Array<{ frameworkId: FrameworkId; requirements: number }> };
type Exception = { id: string; uc_code: string; title: string; justification: string; compensating_controls: string; risk_level: string; requested_by: string; approved_by: string | null; status: string; expires_at: string; expired: boolean; decision_note: string | null };
type Policy = { id: string; title: string; version: string; status: string; next_review: string | null; document_hash: string | null; ucCodes: string[]; overdue: boolean };
type MappingStats = { frameworkId: FrameworkId; links: number; published: number; validated: number; rejected: number; added: number; suggested: number; reviewedShare: number };
type Suggestion = { ucCode: string; title: string; source: string };
type Link = { ucCode: string; title: string; source: string | null; basis: "published" | "editorial" | "tenant"; review: "validated" | "rejected" | "added" | null; reviewer: string | null; note: string | null; reviewedAt: string | null };
type Snapshot = {
  mapping: MappingStats[];
  catalog: Array<{ id: FrameworkId; name: string; version: string; authority: string; kind: string; granularity: string; sourceUrl: string; requirements: number; imported: number }>;
  evidence: EvidenceItem[]; imports: ImportRecord[]; policy: { requireCountersignature: boolean };
  adoptions: Array<{ frameworkId: FrameworkId; scope: string; targetDate: string | null }>;
  scores: Score[]; overall: { score: number; readiness: string; frameworks: number }; controls: Control[]; roadmap: Roadmap[];
  overlap: Array<{ base: FrameworkId; targets: Array<{ target: FrameworkId; share: number }> }>;
  exceptions: Exception[]; policies: Policy[]; trend: Array<{ framework_id: string; score: number; calculated_at: string }>;
  alerts: { expiredAttestations: Array<{ code: string; title: string; reviewDue: string | null }>; expiringAttestations: Array<{ code: string; title: string; reviewDue: string | null }>; pendingEvidence: number; contradictions: Array<{ code: string; title: string; attested: string; linkedControlCode: string | null }>; pendingExceptions: number; expiredExceptions: number; overduePolicies: number; demoPosture: boolean };
};
type Detail = Score & { framework: { name: string; version: string; granularity: string }; mapping: MappingStats; requirements: Array<{ custom?: boolean; licensed: Array<{ kind: "procedure" | "guidance"; body: string; sourceLabel: string }>; id: string; title: string; group: string; status: ReqStatus; score: number | null; verified: boolean; justification: string | null; controls: string[]; links: Link[]; suggestions: Suggestion[]; related: Array<{ frameworkId: string; ids: string[] }> }> };

const tabs = ["Overview", "Frameworks", "Control library", "Roadmap", "Exceptions", "Policies"] as const;
type Tab = (typeof tabs)[number];

const SHORT: Record<string, string> = { iso27001: "ISO 27001", nist_csf: "NIST CSF", soc2: "SOC 2", gdpr: "GDPR", nis2: "NIS2", dora: "DORA", eu_ai_act: "AI Act", iso42001: "ISO 42001", pci_dss: "PCI DSS", cis_v8: "CIS v8" };
const STATUS_STYLE: Record<string, string> = { compliant: "bg-[#dcebe1] text-[#245c3f]", implemented: "bg-[#dcebe1] text-[#245c3f]", partial: "bg-[#f1e7cc] text-[#7a5a1a]", initial: "bg-[#f6e3d3] text-[#944a15]", planned: "bg-[#f6e3d3] text-[#944a15]", gap: "bg-[#f5e5e1] text-[#b8322a]", not_started: "bg-[#f5e5e1] text-[#b8322a]", not_applicable: "bg-[#e5e2d8] text-[#5f5d56]" };
const VERIFY_STYLE: Record<string, string> = { verified: "text-[#2f6f4f]", documented: "text-[#245c3f]", failing: "text-[#b8322a]", stale: "text-[#7a5a1a]", unverified: "text-[#63615a]" };
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[10px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[10px] focus-visible:outline-2 focus-visible:outline-[#171713]";

function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={cn("inline-block px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider", STATUS_STYLE[value] ?? "bg-[#e5e2d8] text-[#55534b]")}>{(label ?? value).replace(/_/g, " ")}</span>;
}

/** Solid heat-map colour between the page background and a deep green, with whichever text colour contrasts better. */
function heat(share: number) {
  const from = [244, 241, 233], to = [31, 92, 63];
  const luminance = (rgb: number[]) => { const [r, g, b] = rgb.map((value) => { const channel = value / 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const mixAt = (percent: number) => from.map((value, index) => Math.round(value + ((to[index] - value) * Math.min(100, Math.max(0, percent))) / 100));
  const best = (rgb: number[]) => { const l = luminance(rgb); return Math.max((l + 0.05) / (luminance([23, 23, 19]) + 0.05), 1.05 / (l + 0.05)); };
  // Mid-tones where neither black nor white text reaches WCAG AA are nudged to the nearest shade that does.
  let percent = share;
  for (let offset = 0; offset <= 40 && best(mixAt(percent)) < 4.6; offset++) percent = best(mixAt(share + offset)) >= 4.6 ? share + offset : best(mixAt(share - offset)) >= 4.6 ? share - offset : share;
  const rgb = mixAt(percent), l = luminance(rgb);
  return { background: `rgb(${rgb.join(",")})`, color: (l + 0.05) / (luminance([23, 23, 19]) + 0.05) >= 1.05 / (l + 0.05) ? "#171713" : "#ffffff" };
}

function Bar({ value, className }: { value: number; className?: string }) {
  const tone = value >= 85 ? "bg-[#2f6f4f]" : value >= 50 ? "bg-[#a98a45]" : "bg-[#b8322a]";
  return <div className={cn("h-1.5 w-full bg-[#ddd9cf]", className)} role="img" aria-label={`${Math.round(value)} percent`}><div className={cn("h-full", tone)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>;
}

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="font-mono text-[8px] text-[#6a675f]">no history</span>;
  const min = Math.min(...points), max = Math.max(...points), span = Math.max(1, max - min);
  const path = points.map((value, index) => `${(index / (points.length - 1)) * 100},${22 - ((value - min) / span) * 20}`).join(" ");
  return <svg viewBox="0 0 100 24" className="h-6 w-24" role="img" aria-label="Score trend"><polyline points={path} fill="none" stroke="#171713" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

export function ComplianceHub() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [status, setStatus] = useState("Chargement de la posture de conformité…");
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<FrameworkId | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback((signal?: AbortSignal) => fetchJson<Snapshot>("/api/compliance", { signal }).then((next) => { setSnapshot(next); setFailed(false); }), []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(() => setStatus("Posture synchronisée")).catch((error: unknown) => { if (isAbort(error)) return; setFailed(true); setStatus(errorMessage(error, "Posture indisponible")); });
    return () => controller.abort();
  }, [load]);

  const activeFramework = selected ?? snapshot?.adoptions[0]?.frameworkId ?? null;
  useEffect(() => {
    if (!activeFramework || tab !== "Frameworks") return;
    const controller = new AbortController();
    fetchJson<Detail>(`/api/compliance/frameworks/${activeFramework}`, { signal: controller.signal }).then(setDetail).catch((error: unknown) => { if (!isAbort(error)) setStatus(errorMessage(error, "Référentiel indisponible")); });
    return () => controller.abort();
  }, [activeFramework, tab, snapshot]);

  function act(body: Record<string, unknown>, success: string, after?: () => void) {
    startTransition(async () => {
      try {
        setStatus("Enregistrement…");
        await fetchJson("/api/compliance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch (error) { setStatus(errorMessage(error, "Action impossible")); return; }
      try { await load(); setStatus(success); after?.(); } catch (error) { setStatus(`Action effectuée, actualisation impossible : ${errorMessage(error, "erreur inconnue")}`); }
    });
  }

  function upload(form: FormData) {
    startTransition(async () => {
      try {
        setStatus("Dépôt de la pièce…");
        const response = await fetch("/api/compliance/evidence", { method: "POST", body: form });
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) throw new Error(body?.error ?? `Dépôt refusé (${response.status})`);
      } catch (error) { setStatus(errorMessage(error, "Dépôt impossible")); return; }
      try { await load(); setStatus("Pièce déposée : en attente de relecture par une autre personne"); } catch (error) { setStatus(`Pièce déposée, actualisation impossible : ${errorMessage(error, "erreur inconnue")}`); }
    });
  }

  function licensed(method: "POST" | "DELETE", framework: FrameworkId, payload?: Record<string, unknown>) {
    startTransition(async () => {
      try {
        setStatus(method === "POST" ? "Import du contenu sous licence…" : "Suppression du contenu importé…");
        await fetchJson(method === "POST" ? "/api/compliance/licensed-content" : `/api/compliance/licensed-content?framework=${framework}`, method === "POST" ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ framework, ...payload }) } : { method });
      } catch (error) { setStatus(errorMessage(error, "Opération impossible")); return; }
      try { await load(); setDetail(null); setStatus(method === "POST" ? "Contenu importé : les scores utilisent maintenant vos sous-exigences" : "Contenu importé supprimé"); } catch (error) { setStatus(`Opération effectuée, actualisation impossible : ${errorMessage(error, "erreur inconnue")}`); }
    });
  }

  const adopted = useMemo(() => new Set(snapshot?.adoptions.map((item) => item.frameworkId)), [snapshot]);
  const gapTotal = snapshot?.scores.reduce((sum, item) => sum + item.gaps, 0) ?? 0;
  const empty = snapshot !== null && snapshot.adoptions.length === 0 && snapshot.controls.every((control) => control.source === "none");

  return (
    <div>
      <PageHeading index="12" title="Compliance hub" description="ISO 27001, NIST CSF 2.0, SOC 2, RGPD, NIS2, DORA, AI Act et plus : un seul jeu de contrôles unifiés, des scores vérifiés par les preuves." meta={status} action={<div className="flex flex-wrap items-center gap-2">{snapshot?.alerts.demoPosture ? <><span className="border border-[#a98a45] px-2 py-1 font-mono text-[8px] uppercase text-[#7a5a1a]">Sample posture</span><Button type="button" variant="outline" disabled={isPending} onClick={() => { if (window.confirm("Supprimer toutes les données d’exemple ? Les attestations, politiques et décisions réelles sont conservées.")) act({ action: "purge_demo" }, "Données d’exemple supprimées"); }} className="h-8 rounded-none border-[#b8322a] bg-transparent text-[9px] text-[#b8322a]"><Trash2 className="me-1.5 h-3 w-3" aria-hidden="true" />Purger l’exemple</Button></> : null}{snapshot && snapshot.adoptions.length ? <a href="/api/compliance/report" download className="inline-flex h-8 items-center border border-[#171713] px-3 text-[9px] font-semibold hover:bg-[#171713] hover:text-white"><FileText className="me-1.5 h-3 w-3" aria-hidden="true" />Rapport PDF</a> : null}</div>} />
      <section className="p-5 sm:p-7 lg:p-9" aria-busy={snapshot === null && !failed}>
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[9px] text-[#9f2923]">{status}</div> : null}
        <div role="tablist" aria-label="Compliance sections" className="mb-6 flex flex-wrap border-b border-[#cbc7bd]">
          {tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} type="button" onClick={() => setTab(name)} className={cn("px-4 py-2.5 text-[10px] font-medium", tab === name ? "border-b-2 border-[#171713] text-[#171713]" : "text-[#5f5d56] hover:text-[#171713]")}>{name}</button>)}
        </div>

        {snapshot && empty ? (
          <div className="grid place-items-center border border-dashed border-[#cbc7bd] p-12 text-center">
            <Sparkles className="mb-3 h-6 w-6 text-[#a8391a]" aria-hidden="true" />
            <p className="max-w-md text-[11px] font-medium">Aucune posture enregistrée pour ce tenant.</p>
            <p className="mt-1 max-w-md text-[10px] text-[#5f5d56]">Adoptez un référentiel pour commencer, ou chargez une posture d’exemple clairement étiquetée pour explorer toutes les fonctions.</p>
            <Button type="button" disabled={isPending} onClick={() => act({ action: "load_demo" }, "Posture d’exemple chargée")} className="mt-4 h-8 rounded-none bg-[#171713] text-[10px] text-white">Charger la posture d’exemple</Button>
          </div>
        ) : null}

        {snapshot && !empty && tab === "Overview" ? <Overview snapshot={snapshot} adopted={adopted} gapTotal={gapTotal} open={(id) => { setSelected(id); setTab("Frameworks"); }} adopt={(frameworkId, scope) => act({ action: "adopt_framework", frameworkId, scope }, `${SHORT[frameworkId]} adopté`)} pending={isPending} evidence={(action) => act({ action }, action === "install_pack" ? "Pack de contrôles installé" : "Preuves liées aux contrôles unifiés")} /> : null}
        {snapshot && !empty && tab === "Frameworks" ? <Frameworks snapshot={snapshot} detail={detail} active={activeFramework} choose={(id) => { setDetail(null); setSelected(id); }} pending={isPending} review={(body) => act({ action: "review_mapping", ...body }, "Lien de mapping mis à jour")} runLicensed={licensed} setScope={(frameworkId, requirementId, applicable, justification) => act({ action: "set_requirement_scope", frameworkId, requirementId, applicable, justification }, applicable ? "Exigence réintégrée" : "Exigence exclue du périmètre")} /> : null}
        {snapshot && !empty && tab === "Control library" ? <Library controls={snapshot.controls} evidence={snapshot.evidence} requireCountersign={snapshot.policy.requireCountersignature} act={act} upload={upload} pending={isPending} save={(body) => act({ action: "set_implementation", ...body }, "Contrôle mis à jour")} /> : null}
        {snapshot && !empty && tab === "Roadmap" ? <RoadmapView items={snapshot.roadmap} adopted={snapshot.adoptions.length} start={(code) => act({ action: "set_implementation", ucCode: code, status: "planned", maturity: 1, notes: "Planned from roadmap" }, "Contrôle planifié")} pending={isPending} /> : null}
        {snapshot && !empty && tab === "Exceptions" ? <Exceptions snapshot={snapshot} pending={isPending} act={act} /> : null}
        {snapshot && !empty && tab === "Policies" ? <Policies snapshot={snapshot} pending={isPending} act={act} /> : null}
        {!snapshot && !failed ? <div className="grid min-h-52 place-items-center text-[9px] text-[#63615a]">Chargement…</div> : null}
      </section>
    </div>
  );
}

function Overview({ snapshot, adopted, gapTotal, open, adopt, pending, evidence }: { snapshot: Snapshot; adopted: Set<FrameworkId>; gapTotal: number; open: (id: FrameworkId) => void; adopt: (id: FrameworkId, scope: string) => void; pending: boolean; evidence: (action: "install_pack" | "link_evidence") => void }) {
  const { alerts } = snapshot;
  const trendFor = (id: string) => snapshot.trend.filter((point) => point.framework_id === id).map((point) => point.score);
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 border border-[#cbc7bd] md:grid-cols-5">
        {[["Posture globale", `${snapshot.overall.score}%`, snapshot.overall.readiness], ["Référentiels", String(snapshot.overall.frameworks), "adoptés"], ["Écarts ouverts", String(gapTotal), "exigences à 0 %"], ["Exceptions", String(alerts.pendingExceptions), "en attente de décision"], ["Contradictions", String(alerts.contradictions.length), "preuve vs déclaration"]].map(([label, value, note]) => (
          <div key={label} className="border-b border-e border-[#cbc7bd] p-4"><MicroLabel>{label}</MicroLabel><p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p><p className="text-[9px] text-[#5f5d56]">{note}</p></div>
        ))}
      </div>

      {alerts.contradictions.length || alerts.expiredExceptions || alerts.overduePolicies || alerts.expiredAttestations.length || alerts.expiringAttestations.length || alerts.pendingEvidence ? (
        <div role="alert" className="space-y-1 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[9px] text-[#9f2923]">
          {alerts.contradictions.map((item) => <p key={item.code} className="flex items-start gap-2"><ShieldAlert className="mt-px h-3 w-3 shrink-0" aria-hidden="true" /><span><strong>{item.code}</strong> déclaré « {item.attested} » mais la preuve collectée sur {item.linkedControlCode} est en échec : le score est plafonné.</span></p>)}
          {alerts.expiredExceptions ? <p className="flex gap-2"><AlertTriangle className="h-3 w-3" aria-hidden="true" />{alerts.expiredExceptions} acceptation(s) de risque expirée(s) à réapprouver.</p> : null}
          {alerts.expiredAttestations.map((item) => <p key={item.code} className="flex gap-2"><AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" /><span><strong>{item.code}</strong> : attestation expirée (revue due le {item.reviewDue?.slice(0, 10)}), le contrôle compte comme partiel jusqu’à la réattestation.</span></p>)}
          {alerts.expiringAttestations.length ? <p className="flex gap-2"><AlertTriangle className="h-3 w-3" aria-hidden="true" />{alerts.expiringAttestations.length} attestation(s) expirent dans moins de 30 jours.</p> : null}
          {alerts.pendingEvidence ? <p className="flex gap-2"><AlertTriangle className="h-3 w-3" aria-hidden="true" />{alerts.pendingEvidence} pièce(s) documentaire(s) en attente de relecture.</p> : null}
          {alerts.overduePolicies ? <p className="flex gap-2"><AlertTriangle className="h-3 w-3" aria-hidden="true" />{alerts.overduePolicies} politique(s) approuvée(s) dont la revue est en retard.</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border border-[#cbc7bd] p-4">
        <div className="max-w-2xl"><MicroLabel>Preuves machine</MicroLabel><p className="mt-1 text-[10px] text-[#55534b]">13 contrôles exécutables (GitHub, AWS, Okta) vérifient vos déclarations. Une synchronisation d’un connecteur les évalue ; ceux dont un fait est illisible sont ignorés, jamais déclarés en échec.</p></div>
        <div className="flex gap-2"><Button type="button" variant="outline" disabled={pending} onClick={() => evidence("install_pack")} className="h-8 rounded-none border-[#171713] bg-transparent text-[9px]"><Plug className="me-1.5 h-3 w-3" aria-hidden="true" />Installer le pack</Button><Button type="button" variant="outline" disabled={pending} onClick={() => evidence("link_evidence")} className="h-8 rounded-none border-[#171713] bg-transparent text-[9px]"><Link2 className="me-1.5 h-3 w-3" aria-hidden="true" />Lier les preuves</Button></div>
      </div>

      <div>
        <MicroLabel>Scorecards</MicroLabel>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {snapshot.scores.map((score) => {
            const info = snapshot.catalog.find((item) => item.id === score.frameworkId)!;
            return (
              <div key={score.frameworkId}>
                <button type="button" onClick={() => open(score.frameworkId)} className="border border-[#cbc7bd] bg-[#f8f6f0] p-4 text-start transition-colors hover:border-[#171713]">
                <div className="flex items-start justify-between gap-2"><div><p className="text-[12px] font-semibold">{info.name}</p><p className="font-mono text-[8px] uppercase tracking-wider text-[#63615a]">{info.version}</p></div><Spark points={trendFor(score.frameworkId)} /></div>
                <div className="mt-4 flex items-end justify-between"><span className="text-3xl font-semibold tracking-tight">{score.score}<span className="text-sm">%</span></span><Badge value={score.readinessLevel === "audit_ready" ? "compliant" : score.readinessLevel === "not_ready" ? "gap" : "partial"} label={score.readiness} /></div>
                <Bar value={score.score} className="mt-2" />
                <div className="mt-3 grid grid-cols-4 gap-1 font-mono text-[8px] text-[#5f5d56]"><span>{score.compliant} conformes</span><span>{score.partial} partiels</span><span>{score.gaps} écarts</span><span>{score.verifiedShare}% prouvé</span></div>
              </button>
                <details className="border border-t-0 border-[#cbc7bd] bg-[#f1eee5] p-3 text-[9px]">
                  <summary className="cursor-pointer font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Why this level</summary>
                  <p className="mt-2 text-[#34332e]">Declared {score.assessment.dimensions.declared}% · documents {score.assessment.dimensions.documentary}% · machine-verified {score.assessment.dimensions.technical}% · backed {score.assessment.dimensions.backed}% of {score.assessment.scope.controls} controls in scope.{score.assessment.scope.excluded > 0 ? ` ${score.assessment.scope.excluded} requirement(s) are excluded with a justification; without the exclusions the score would be ${score.assessment.scope.scoreWithoutExclusions}% (the exclusions are worth ${score.assessment.scope.exclusionEffect > 0 ? "+" : ""}${score.assessment.scope.exclusionEffect} points).` : ""}</p>
                  {score.assessment.blockers.map((text) => <p key={text} className="mt-1 border-s-2 border-[#b8322a] ps-2">Blocking: {text}</p>)}
                  {score.assessment.reservations.map((text) => <p key={text} className="mt-1 border-s-2 border-[#a98a45] ps-2">Reservation: {text}</p>)}
                  {score.assessment.nextSteps.length ? <ul className="mt-2 list-disc ps-4">{score.assessment.nextSteps.map((text) => <li key={text}>{text}</li>)}</ul> : null}
                  <ul className="mt-2 space-y-0.5">{score.assessment.criteria.map((item) => <li key={item.id} className="flex justify-between gap-3"><span>{item.met ? "✓" : item.blocking ? "✗" : "!"} {item.label}</span><span className="font-mono text-[#5f5d56]">{item.value} · {item.threshold}</span></li>)}</ul>
                </details>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <MicroLabel>Catalogue de référentiels</MicroLabel>
        <div tabIndex={0} role="region" aria-label="Table, scrollable" className="mt-3 overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[720px] text-left text-[9px]"><caption className="sr-only">Framework catalogue</caption><thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["Framework", "Autorité", "Profondeur du catalogue", "Exigences", ""].map((h) => <th key={h} scope="col" className="px-4 py-2.5">{h}</th>)}</tr></thead>
          <tbody>{snapshot.catalog.map((item) => <tr key={item.id} className="border-t border-[#d8d4ca]"><td className="px-4 py-3 font-medium">{item.name} <span className="text-[#63615a]">{item.version}</span></td><td className="px-4 py-3">{item.authority}</td><td className="px-4 py-3 text-[#55534b]">{item.granularity}</td><td className="px-4 py-3 font-mono">{item.requirements}</td><td className="px-4 py-3 text-end">{adopted.has(item.id) ? <span className="inline-flex items-center gap-1 text-[#245c3f]"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />Adopté</span> : <Button type="button" variant="outline" disabled={pending} onClick={() => adopt(item.id, `${item.name} — organisation entière`)} className="h-7 rounded-none border-[#171713] bg-transparent text-[9px]"><Plus className="me-1 h-3 w-3" aria-hidden="true" />Adopter</Button>}</td></tr>)}</tbody></table></div>
      </div>

      <div>
        <MicroLabel>Réutilisation : adoptez une fois, conformez-vous plusieurs fois</MicroLabel>
        <p className="mt-1 text-[9px] text-[#5f5d56]">Part des exigences de la colonne couverte par les contrôles unifiés déjà requis par la ligne.</p>
        <div tabIndex={0} role="region" aria-label="Table, scrollable" className="mt-3 overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[760px] border-collapse text-center font-mono text-[8px]"><caption className="sr-only">Framework overlap matrix</caption><thead><tr className="bg-[#e9e5db]"><th scope="col" className="px-2 py-2 text-start">Base ↓ / Cible →</th>{snapshot.catalog.map((item) => <th scope="col" key={item.id} className="px-2 py-2">{SHORT[item.id]}</th>)}</tr></thead>
          <tbody>{snapshot.overlap.map((row) => <tr key={row.base}><th scope="row" className="bg-[#e9e5db] px-2 py-2 text-start">{SHORT[row.base]}</th>{snapshot.catalog.map((item) => { const cell = row.targets.find((target) => target.target === item.id); return <td key={item.id} className="border border-[#d8d4ca] px-2 py-2" style={cell ? heat(cell.share) : { background: "#ddd9cf", color: "#171713" }}>{cell ? `${cell.share}%` : "—"}</td>; })}</tr>)}</tbody></table></div>
      </div>
    </div>
  );
}

function Frameworks({ snapshot, detail, active, choose, setScope, review, runLicensed, pending }: { runLicensed: (method: "POST" | "DELETE", framework: FrameworkId, payload?: Record<string, unknown>) => void; snapshot: Snapshot; detail: Detail | null; active: FrameworkId | null; choose: (id: FrameworkId) => void; setScope: (framework: FrameworkId, requirement: string, applicable: boolean, justification?: string) => void; review: (body: Record<string, unknown>) => void; pending: boolean }) {
  const [filter, setFilter] = useState<ReqStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [excluding, setExcluding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [openLinks, setOpenLinks] = useState<string | null>(null);
  const [limit, setLimit] = useState(120);
  const [note, setNote] = useState("");
  const [addCode, setAddCode] = useState("");
  if (!active) return <p className="text-[10px] text-[#5f5d56]">Adoptez un référentiel depuis la vue d’ensemble.</p>;
  const rows = (detail?.requirements ?? []).filter((item) => (filter === "all" || item.status === filter) && `${item.id} ${item.title}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">{snapshot.adoptions.map((item) => <button key={item.frameworkId} type="button" aria-pressed={active === item.frameworkId} onClick={() => choose(item.frameworkId)} className={cn("border px-3 py-1.5 text-[10px]", active === item.frameworkId ? "border-[#171713] bg-[#171713] text-white" : "border-[#cbc7bd] hover:border-[#171713]")}>{SHORT[item.frameworkId]}</button>)}</div>
      {!detail ? <p className="text-[9px] text-[#63615a]">Chargement…</p> : (
        <>
          <div className="grid gap-4 border border-[#cbc7bd] p-5 lg:grid-cols-[1fr_auto]">
            <div><p className="text-[13px] font-semibold">{detail.framework.name} <span className="font-normal text-[#63615a]">{detail.framework.version}</span></p><p className="text-[9px] text-[#5f5d56]">{detail.framework.granularity}</p><Bar value={detail.score} className="mt-3 max-w-md" /><p className="mt-2 font-mono text-[9px]">{detail.score}% · {detail.readiness} · {detail.verifiedShare}% étayé par des preuves collectées · {detail.notApplicable} exclue(s)</p><p className="mt-1 font-mono text-[8px] text-[#5f5d56]">Mapping : {detail.mapping.links} liens · {detail.mapping.published} issus d’une source publiée · {detail.mapping.validated} validés · {detail.mapping.rejected} rejetés · {detail.mapping.added} ajoutés · {detail.mapping.reviewedShare}% revus · {detail.mapping.suggested} suggestion(s) publiée(s) à examiner</p></div>
            <div className="flex flex-wrap items-start gap-2">
              <a href={`/api/compliance/report?framework=${active}`} download className="inline-flex h-8 items-center border border-[#171713] px-3 text-[9px] font-semibold hover:bg-[#171713] hover:text-white"><FileText className="me-1.5 h-3 w-3" aria-hidden="true" />PDF</a>
              <a href={`/api/compliance/frameworks/${active}?format=csv`} download className="inline-flex h-8 items-center border border-[#171713] px-3 text-[9px] font-semibold hover:bg-[#171713] hover:text-white"><Download className="me-1.5 h-3 w-3" aria-hidden="true" />SoA CSV</a>
              <a href={`/api/compliance/frameworks/${active}?format=json`} download className="inline-flex h-8 items-center border border-[#171713] px-3 text-[9px] font-semibold hover:bg-[#171713] hover:text-white"><FileCheck2 className="me-1.5 h-3 w-3" aria-hidden="true" />SoA JSON</a>
            </div>
          </div>
          <LicensedPanel framework={active} imports={snapshot.imports} imported={snapshot.catalog.find((item) => item.id === active)?.imported ?? 0} run={runLicensed} pending={pending} />
          <div className="grid gap-px border border-[#cbc7bd] bg-[#cbc7bd] sm:grid-cols-2 lg:grid-cols-3">{detail.groups.map((group) => <div key={group.group} className="bg-[#f4f1e9] p-3"><div className="flex justify-between text-[9px]"><span className="font-medium">{group.group}</span><span className="font-mono">{group.score}%</span></div><Bar value={group.score} className="mt-2" /></div>)}</div>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label="Search requirements" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher une exigence…" className={cn(field, "w-60")} />
            <select aria-label="Filter by status" value={filter} onChange={(event) => setFilter(event.target.value as ReqStatus | "all")} className={select}><option value="all">Tous les statuts</option>{["compliant", "partial", "initial", "gap", "not_applicable"].map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select>
            <span className="font-mono text-[8px] text-[#63615a]">{Math.min(limit, rows.length)} / {rows.length} affichées · {detail.requirements.length} au total</span>
          </div>
          <div tabIndex={0} role="region" aria-label="Table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[860px] text-left text-[9px]"><caption className="sr-only">Requirements</caption><thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["Exigence", "Intitulé", "Statut", "Score", "Contrôles unifiés", "Couvre aussi", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
            <tbody>{rows.slice(0, limit).map((item) => (
              <Fragment key={item.id}>
              <tr className="border-t border-[#d8d4ca] align-top hover:bg-[#eeeadf]">
                <td className="px-3 py-3 font-mono font-semibold">{item.id}{item.custom ? <span className="ms-1 bg-[#e5e2d8] px-1 text-[7px] font-normal uppercase text-[#55534b]">importé</span> : null}</td>
                <td className="max-w-[300px] px-3 py-3">{item.title}<span className="block text-[8px] text-[#63615a]">{item.group}</span>{item.justification ? <span className="mt-1 block text-[8px] italic text-[#5f5d56]">Exclue : {item.justification}</span> : null}</td>
                <td className="px-3 py-3"><Badge value={item.status} />{item.verified ? <span className="ms-1 text-[#2f6f4f]" title="Étayé par des preuves collectées"><CheckCircle2 className="inline h-3 w-3" aria-label="Evidence verified" /></span> : null}</td>
                <td className="px-3 py-3 font-mono">{item.score === null ? "—" : `${Math.round(item.score * 100)}%`}</td>
                <td className="px-3 py-3 font-mono text-[8px]"><button type="button" aria-expanded={openLinks === item.id} onClick={() => { setOpenLinks(openLinks === item.id ? null : item.id); setNote(""); setAddCode(""); }} className="inline-flex items-center gap-1 text-start hover:underline">{item.controls.join(" · ") || "aucun"}<ChevronDown className={cn("h-2.5 w-2.5 transition-transform", openLinks === item.id && "rotate-180")} aria-hidden="true" /></button></td>
                <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{item.related.filter((entry) => adoptedCheck(snapshot, entry.frameworkId)).map((entry) => <span key={entry.frameworkId} title={entry.ids.join(", ")} className="inline-flex items-center gap-0.5 border border-[#cbc7bd] px-1 font-mono text-[7px]"><Link2 className="h-2 w-2" aria-hidden="true" />{SHORT[entry.frameworkId]} {entry.ids.length}</span>)}</div></td>
                <td className="px-3 py-3 text-end">
                  {item.status === "not_applicable" ? <Button type="button" variant="outline" disabled={pending} onClick={() => setScope(active, item.id, true)} className="h-6 rounded-none border-[#171713] bg-transparent text-[8px]">Réintégrer</Button> : excluding === item.id ? (
                    <div className="flex min-w-[220px] flex-col gap-1"><Textarea aria-label="Exclusion justification" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Justification (15 caractères minimum)" className="min-h-14 rounded-none text-[9px] placeholder:text-[#63615a]" /><div className="flex gap-1"><Button type="button" disabled={pending || reason.trim().length < 15} onClick={() => { setScope(active, item.id, false, reason); setExcluding(null); setReason(""); }} className="h-6 rounded-none bg-[#171713] text-[8px] text-white">Exclure</Button><Button type="button" variant="ghost" onClick={() => setExcluding(null)} className="h-6 rounded-none text-[8px]">Annuler</Button></div></div>
                  ) : <Button type="button" variant="ghost" onClick={() => { setExcluding(item.id); setReason(""); }} className="h-6 rounded-none text-[8px] text-[#5f5d56]">Hors périmètre</Button>}
                </td>
              </tr>
              {openLinks === item.id ? <tr className="bg-[#f1eee5]"><td colSpan={7} className="px-5 py-4">
                {item.licensed.length ? <div className="mb-4 space-y-2 border border-[#cbc7bd] bg-[#f8f6f0] p-3"><p className="font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Texte importé par votre organisation (contenu sous licence)</p>{item.licensed.map((text) => <div key={text.kind}><p className="font-mono text-[7px] uppercase text-[#5f5d56]">{text.kind === "procedure" ? "Procédure de test" : "Orientation"} · {text.sourceLabel}</p><p className="whitespace-pre-wrap text-[9px] text-[#34332e]">{text.body}</p></div>)}</div> : null}
                <p className="mb-2 font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Liens du crosswalk pour {item.id}</p>
                <div className="space-y-1">{item.links.map((link) => (
                  <div key={link.ucCode} className="flex flex-wrap items-center gap-2 text-[9px]">
                    <span className="font-mono font-semibold">{link.ucCode}</span><span className="text-[#55534b]">{link.title}</span>
                    <span title={link.source ?? undefined} className={cn("px-1 font-mono text-[7px] uppercase", link.basis === "published" ? "bg-[#dcebe1] text-[#245c3f]" : link.basis === "tenant" ? "bg-[#e5e2d8] text-[#55534b]" : "bg-[#f1e7cc] text-[#7a5a1a]")}>{link.basis === "published" ? `source publiée${link.source ? ` · ${link.source.split(" (")[0].split(" via")[0]}` : ""}` : link.basis === "tenant" ? "ajouté par vous" : "éditorial"}</span>
                    {link.review ? <span className="font-mono text-[7px] uppercase text-[#55534b]">{link.review} par {link.reviewer}{link.note ? ` : ${link.note}` : ""}</span> : null}
                    {link.review === "added" || link.review ? <Button type="button" variant="ghost" disabled={pending} onClick={() => review({ frameworkId: active, requirementId: item.id, ucCode: link.ucCode, decision: "reset" })} className="h-5 rounded-none px-1 text-[8px]">Réinitialiser</Button> : null}
                    {link.basis !== "tenant" && link.review !== "rejected" ? <><Button type="button" variant="outline" disabled={pending || note.trim().length < 10} onClick={() => review({ frameworkId: active, requirementId: item.id, ucCode: link.ucCode, decision: "validated", note })} className="h-5 rounded-none border-[#2f6f4f] bg-transparent px-1.5 text-[8px] text-[#245c3f]">Valider</Button><Button type="button" variant="outline" disabled={pending || note.trim().length < 10} onClick={() => review({ frameworkId: active, requirementId: item.id, ucCode: link.ucCode, decision: "rejected", note })} className="h-5 rounded-none border-[#b8322a] bg-transparent px-1.5 text-[8px] text-[#b8322a]">Rejeter</Button></> : null}
                  </div>))}</div>
                {item.suggestions.length ? <div className="mt-3 border-t border-[#cbc7bd] pt-3"><p className="mb-2 font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Suggérés par une source publiée</p><div className="space-y-1">{item.suggestions.map((suggestion) => (
                  <div key={suggestion.ucCode} className="flex flex-wrap items-center gap-2 text-[9px]"><span className="font-mono font-semibold">{suggestion.ucCode}</span><span className="text-[#55534b]">{suggestion.title}</span><span className="font-mono text-[7px] text-[#5f5d56]">{suggestion.source}</span>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => review({ frameworkId: active, requirementId: item.id, ucCode: suggestion.ucCode, decision: "added", note: `Suggested by ${suggestion.source}` })} className="h-5 rounded-none border-[#171713] bg-transparent px-1.5 text-[8px]">Accepter</Button></div>))}</div></div> : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input aria-label="Review note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note de revue (10 caractères minimum)" className={cn(field, "w-72")} />
                  <select aria-label="Control to link" value={addCode} onChange={(event) => setAddCode(event.target.value)} className={select}><option value="">Ajouter un lien…</option>{snapshot.controls.filter((control) => !item.links.some((link) => link.ucCode === control.code)).map((control) => <option key={control.code} value={control.code}>{control.code} — {control.title}</option>)}</select>
                  <Button type="button" variant="outline" disabled={pending || !addCode || note.trim().length < 10} onClick={() => { review({ frameworkId: active, requirementId: item.id, ucCode: addCode, decision: "added", note }); setAddCode(""); }} className="h-7 rounded-none border-[#171713] bg-transparent text-[9px]">Ajouter</Button>
                </div>
              </td></tr> : null}
              </Fragment>))}</tbody></table></div>
          {rows.length > limit ? <div className="text-center"><Button type="button" variant="outline" onClick={() => setLimit(limit + 120)} className="h-8 rounded-none border-[#171713] bg-transparent text-[9px]">Afficher plus ({rows.length - limit} restantes)</Button></div> : null}
        </>
      )}
    </div>
  );
}

function adoptedCheck(snapshot: Snapshot, id: string) { return snapshot.adoptions.some((item) => item.frameworkId === id); }

function Library({ controls, evidence, requireCountersign, save, act, upload, pending }: { controls: Control[]; evidence: EvidenceItem[]; requireCountersign: boolean; save: (body: Record<string, unknown>) => void; act: (body: Record<string, unknown>, success: string, after?: () => void) => void; upload: (form: FormData) => void; pending: boolean }) {
  const [edits, setEdits] = useState<Record<string, { status: Status; maturity: number; link: string; notes: string }>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ title: "", kind: "document", validUntil: "", note: "" });
  const domains = [...new Set(controls.map((control) => control.domainLabel))];
  const day = (value: string | null) => (value ? value.slice(0, 10) : "—");
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-[10px] text-[#55534b]"><Layers className="me-1 inline h-3 w-3" aria-hidden="true" />Chaque contrôle unifié satisfait des exigences de plusieurs référentiels. Liez-le à des contrôles exécutables (par ex. <span className="font-mono">CTL-SDLC-004, CTL-GH-002</span>) : la preuve collectée vérifie ou contredit votre déclaration. Les contrôles organisationnels s’appuient sur des attestations qui expirent, une contresignature et des preuves documentaires relues par une autre personne.{requireCountersign ? " Cette organisation exige une contresignature : une déclaration non confirmée compte comme partielle." : ""}</p>
      {domains.map((domain) => (
        <div key={domain}><MicroLabel>{domain}</MicroLabel>
          <div tabIndex={0} role="region" aria-label="Table, scrollable" className="mt-2 overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[980px] text-left text-[9px]"><caption className="sr-only">{domain}</caption><thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["Contrôle", "Statut", "Maturité", "Contrôle lié", "Preuve", "Revue", "Référentiels", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
            <tbody>{controls.filter((control) => control.domainLabel === domain).map((control) => {
              const edit = edits[control.code] ?? { status: control.status, maturity: control.maturity, link: control.linkedControlCode ?? "", notes: control.notes };
              const dirty = edits[control.code] !== undefined;
              const update = (patch: Partial<typeof edit>) => setEdits((current) => ({ ...current, [control.code]: { ...edit, ...patch } }));
              const mine = evidence.filter((item) => item.uc_code === control.code);
              const attested = ["implemented", "partial", "planned"].includes(control.status);
              return (
                <Fragment key={control.code}>
                <tr className="border-t border-[#d8d4ca] align-top">
                  <td className="max-w-[280px] px-3 py-3"><span className="font-mono font-semibold">{control.code}</span><span className="block font-medium">{control.title}</span><span className="block text-[8px] text-[#63615a]">{control.description}</span>{control.excepted ? <span className="mt-1 inline-block bg-[#f1e7cc] px-1 font-mono text-[7px] text-[#7a5a1a]">RISK ACCEPTED</span> : null}</td>
                  <td className="px-3 py-3"><select aria-label={`Status of ${control.code}`} value={edit.status} onChange={(event) => update({ status: event.target.value as Status })} className={select}>{["not_started", "planned", "partial", "implemented", "not_applicable"].map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></td>
                  <td className="px-3 py-3"><select aria-label={`Maturity of ${control.code}`} value={edit.maturity} onChange={(event) => update({ maturity: Number(event.target.value) })} className={select}>{[0, 1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}</select></td>
                  <td className="px-3 py-3"><Input aria-label={`Linked control of ${control.code}`} value={edit.link} onChange={(event) => update({ link: event.target.value })} placeholder="CTL-A, CTL-B" className={cn(field, "w-40 font-mono")} /></td>
                  <td className={cn("px-3 py-3 font-mono text-[8px] uppercase", VERIFY_STYLE[control.verification])}>{control.verification}{control.source === "demo" ? <span className="block text-[#7a5a1a]">sample</span> : null}</td>
                  <td className="px-3 py-3 font-mono text-[8px]">{attested ? <><span className={cn("block", control.attestationExpired && "font-bold text-[#b8322a]")}>{control.attestationExpired ? "EXPIRÉE " : "revue "}{day(control.reviewDue)}</span>{control.countersignedBy ? <span className="block text-[#245c3f]">contresignée</span> : control.awaitingCountersignature ? <span className="block text-[#7a5a1a]">à contresigner</span> : null}</> : <span className="text-[#63615a]">—</span>}</td>
                  <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{control.frameworks.map((item) => <span key={item.frameworkId} className="border border-[#cbc7bd] px-1 font-mono text-[7px]">{SHORT[item.frameworkId]} {item.requirements}</span>)}</div></td>
                  <td className="px-3 py-3 text-end"><div className="flex flex-col items-end gap-1"><Button type="button" disabled={!dirty || pending} onClick={() => { save({ ucCode: control.code, status: edit.status, maturity: edit.maturity, linkedControlCode: edit.link.trim() || undefined, notes: edit.notes }); setEdits((current) => { const next = { ...current }; delete next[control.code]; return next; }); }} className="h-7 rounded-none bg-[#171713] text-[9px] text-white disabled:opacity-30">Enregistrer</Button><Button type="button" variant="ghost" aria-expanded={open === control.code} onClick={() => { setOpen(open === control.code ? null : control.code); setNote(""); }} className="h-6 rounded-none px-1 text-[8px]">Attestation et preuves ({mine.length}) <ChevronDown className={cn("ms-0.5 h-2.5 w-2.5 transition-transform", open === control.code && "rotate-180")} aria-hidden="true" /></Button></div></td>
                </tr>
                {open === control.code ? <tr className="bg-[#f1eee5]"><td colSpan={8} className="px-5 py-4">
                  <div className="grid gap-6 lg:grid-cols-2">
                    <div className="space-y-2">
                      <p className="font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Attestation</p>
                      {attested ? <p className="text-[9px] text-[#55534b]">Déclarée par <span className="font-mono">{control.attestedBy}</span> le {day(control.attestedAt)} · revue due le {day(control.reviewDue)}{control.countersignedBy ? <> · contresignée par <span className="font-mono">{control.countersignedBy}</span></> : " · pas encore contresignée"}</p> : <p className="text-[9px] text-[#55534b]">Aucune déclaration à renouveler : passez le statut à planifié, partiel ou implémenté.</p>}
                      <div className="flex flex-wrap items-center gap-2"><Input aria-label={`Attestation note for ${control.code}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Note (10 caractères minimum)" className={cn(field, "w-64")} />
                        <Button type="button" variant="outline" disabled={pending || !attested || note.trim().length < 10} onClick={() => act({ action: "reattest", ucCode: control.code, note }, "Attestation renouvelée", () => setNote(""))} className="h-8 rounded-none border-[#171713] bg-transparent text-[9px]">Réattester</Button>
                        <Button type="button" variant="outline" disabled={pending || !["implemented", "partial"].includes(control.status) || note.trim().length < 10} onClick={() => act({ action: "countersign", ucCode: control.code, note }, "Attestation contresignée", () => setNote(""))} className="h-8 rounded-none border-[#245c3f] bg-transparent text-[9px] text-[#245c3f]">Contresigner</Button></div>
                      <p className="text-[8px] text-[#63615a]">Le déclarant ne peut pas contresigner sa propre attestation. Toute modification de la déclaration annule la contresignature.</p>
                    </div>
                    <div className="space-y-2">
                      <p className="font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Preuves documentaires</p>
                      {mine.length === 0 ? <p className="text-[9px] text-[#55534b]">Aucune pièce déposée.</p> : mine.map((item) => (
                        <div key={item.id} className="border border-[#cbc7bd] bg-[#f8f6f0] p-2 text-[9px]">
                          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{item.title}</span><Badge value={item.status === "accepted" ? "compliant" : item.status === "rejected" ? "gap" : "partial"} label={item.status} /><span className="font-mono text-[8px] text-[#5f5d56]">{item.kind} · valide jusqu’au {day(item.valid_until)}{item.status === "accepted" && item.valid_until < new Date().toISOString() ? " · EXPIRÉE" : ""}</span></div>
                          <p className="font-mono text-[7px] text-[#5f5d56]">sha256 {item.content_hash.slice(0, 16)}… · déposée par {item.uploaded_by}{item.reviewed_by ? ` · relue par ${item.reviewed_by}` : ""}{item.review_note ? ` : ${item.review_note}` : ""}</p>
                          {item.status === "pending" ? <div className="mt-1 flex flex-wrap gap-1"><Input aria-label={`Review note for ${item.title}`} value={reviewNotes[item.id] ?? ""} onChange={(event) => setReviewNotes({ ...reviewNotes, [item.id]: event.target.value })} placeholder="Note de relecture" className={cn(field, "h-7 w-52")} /><Button type="button" disabled={pending || (reviewNotes[item.id] ?? "").trim().length < 10} onClick={() => act({ action: "review_evidence", id: item.id, accept: true, note: reviewNotes[item.id] }, "Preuve acceptée")} className="h-7 rounded-none bg-[#245c3f] text-[8px] text-white">Accepter</Button><Button type="button" variant="outline" disabled={pending || (reviewNotes[item.id] ?? "").trim().length < 10} onClick={() => act({ action: "review_evidence", id: item.id, accept: false, note: reviewNotes[item.id] }, "Preuve refusée")} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[8px] text-[#b8322a]">Refuser</Button></div> : null}
                        </div>))}
                      <form className="flex flex-wrap items-end gap-2 border-t border-[#cbc7bd] pt-2" onSubmit={(event) => { event.preventDefault(); const element = event.currentTarget; const file = (element.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0]; if (!file) return; const data = new FormData(); data.set("file", file); data.set("ucCode", control.code); data.set("title", form.title); data.set("kind", form.kind); data.set("validUntil", `${form.validUntil}T00:00:00.000Z`); data.set("note", form.note); upload(data); setForm({ title: "", kind: "document", validUntil: "", note: "" }); element.reset(); }}>
                        <Input aria-label={`Evidence title for ${control.code}`} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Titre de la pièce" className={cn(field, "w-44")} />
                        <select aria-label="Evidence kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} className={select}>{["document", "record", "report", "certificate"].map((value) => <option key={value}>{value}</option>)}</select>
                        <label className="text-[8px] text-[#55534b]">Valide jusqu’au <Input type="date" aria-label={`Evidence valid until for ${control.code}`} required value={form.validUntil} onChange={(event) => setForm({ ...form, validUntil: event.target.value })} className={cn(field, "mt-0.5 w-36")} /></label>
                        <Input type="file" name="file" aria-label={`Evidence file for ${control.code}`} required className={cn(field, "w-52 pt-1")} />
                        <Button type="submit" disabled={pending || form.title.trim().length < 3 || !form.validUntil} className="h-8 rounded-none bg-[#171713] text-[9px] text-white">Déposer</Button>
                      </form>
                    </div>
                  </div>
                </td></tr> : null}
                </Fragment>);
            })}</tbody></table></div>
        </div>))}
    </div>
  );
}

function RoadmapView({ items, adopted, start, pending }: { items: Roadmap[]; adopted: number; start: (code: string) => void; pending: boolean }) {
  if (!adopted) return <p className="text-[10px] text-[#5f5d56]">Adoptez au moins un référentiel pour générer une feuille de route.</p>;
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[10px] text-[#55534b]">Les contrôles incomplets sont classés par <strong>levier ÷ effort</strong> : combien d’exigences vos référentiels adoptés avancent grâce à eux, rapporté à l’effort typique de mise en œuvre.</p>
      <div tabIndex={0} role="region" aria-label="Table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[860px] text-left text-[9px]"><caption className="sr-only">Remediation roadmap</caption><thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["#", "Contrôle", "Statut actuel", "Effort", "Levier", "Priorité", "Fait avancer", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
        <tbody>{items.map((item, index) => (
          <tr key={item.code} className="border-t border-[#d8d4ca] align-top">
            <td className="px-3 py-3 font-mono text-[#a8391a]">{index + 1}</td>
            <td className="px-3 py-3"><span className="font-mono font-semibold">{item.code}</span><span className="block">{item.title}</span></td>
            <td className="px-3 py-3"><Badge value={item.currentStatus} />{item.verification === "failing" ? <span className="ms-1 font-mono text-[7px] text-[#b8322a]">EVIDENCE FAILING</span> : null}</td>
            <td className="px-3 py-3 font-mono">{"●".repeat(item.effort)}<span className="text-[#cbc7bd]">{"●".repeat(5 - item.effort)}</span></td>
            <td className="px-3 py-3 font-mono">{item.leverage}</td><td className="px-3 py-3 font-mono font-semibold">{item.priority}</td>
            <td className="px-3 py-3"><div className="flex flex-wrap gap-1">{item.closes.map((close) => <span key={close.frameworkId} className="border border-[#cbc7bd] px-1 font-mono text-[7px]">{SHORT[close.frameworkId]} {close.requirements}</span>)}</div></td>
            <td className="px-3 py-3 text-end">{item.currentStatus === "not_started" ? <Button type="button" variant="outline" disabled={pending} onClick={() => start(item.code)} className="h-6 rounded-none border-[#171713] bg-transparent text-[8px]">Planifier</Button> : null}</td>
          </tr>))}</tbody></table></div>
      {items.length === 0 ? <p className="text-[10px] text-[#245c3f]">Tous les contrôles applicables sont mis en œuvre.</p> : null}
    </div>
  );
}

function Exceptions({ snapshot, act, pending }: { snapshot: Snapshot; act: (body: Record<string, unknown>, success: string, after?: () => void) => void; pending: boolean }) {
  const [form, setForm] = useState({ ucCode: "UC-OPS-02", title: "", justification: "", compensatingControls: "", riskLevel: "medium", days: 90 });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const valid = form.title.length >= 5 && form.justification.length >= 20 && form.compensatingControls.length >= 10;
  return (
    <div className="grid gap-8 xl:grid-cols-[360px_1fr]">
      <form className="space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "request_exception", ucCode: form.ucCode, title: form.title, justification: form.justification, compensatingControls: form.compensatingControls, riskLevel: form.riskLevel, expiresAt: new Date(Date.now() + form.days * 86_400_000).toISOString() }, "Demande d’exception créée", () => setForm({ ...form, title: "", justification: "", compensatingControls: "" })); }}>
        <MicroLabel>Demander une acceptation de risque</MicroLabel>
        <select aria-label="Control" value={form.ucCode} onChange={(event) => setForm({ ...form, ucCode: event.target.value })} className={cn(select, "w-full")}>{snapshot.controls.map((control) => <option key={control.code} value={control.code}>{control.code} — {control.title}</option>)}</select>
        <Input aria-label="Title" placeholder="Titre" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={field} />
        <Textarea aria-label="Justification" placeholder="Justification métier (20 caractères minimum)" value={form.justification} onChange={(event) => setForm({ ...form, justification: event.target.value })} className="min-h-16 rounded-none text-[10px] placeholder:text-[#63615a]" />
        <Textarea aria-label="Compensating controls" placeholder="Mesures compensatoires" value={form.compensatingControls} onChange={(event) => setForm({ ...form, compensatingControls: event.target.value })} className="min-h-14 rounded-none text-[10px] placeholder:text-[#63615a]" />
        <div className="flex gap-2"><select aria-label="Risk level" value={form.riskLevel} onChange={(event) => setForm({ ...form, riskLevel: event.target.value })} className={select}>{["low", "medium", "high", "critical"].map((value) => <option key={value}>{value}</option>)}</select><select aria-label="Duration" value={form.days} onChange={(event) => setForm({ ...form, days: Number(event.target.value) })} className={select}>{[30, 60, 90, 180, 365].map((value) => <option key={value} value={value}>{value} jours</option>)}</select></div>
        <Button type="submit" disabled={!valid || pending} className="h-8 w-full rounded-none bg-[#171713] text-[10px] text-white">Soumettre pour décision</Button>
        <p className="text-[8px] text-[#63615a]">Le demandeur ne peut pas décider sa propre demande ; une exception dure 365 jours au maximum.</p>
      </form>
      <div className="space-y-3">
        {snapshot.exceptions.length === 0 ? <p className="text-[10px] text-[#5f5d56]">Aucune exception enregistrée.</p> : null}
        {snapshot.exceptions.map((item) => (
          <article key={item.id} className="border border-[#cbc7bd] p-4">
            <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[9px] font-semibold">{item.uc_code}</span><Badge value={item.expired ? "gap" : item.status === "approved" ? "compliant" : item.status === "pending" ? "partial" : "not_applicable"} label={item.expired ? "expired" : item.status} /><span className="font-mono text-[8px] uppercase text-[#63615a]">risque {item.risk_level} · expire {item.expires_at.slice(0, 10)}</span></div>
            <h3 className="mt-2 text-[11px] font-semibold">{item.title}</h3><p className="mt-1 text-[9px] text-[#55534b]">{item.justification}</p><p className="mt-1 text-[9px] text-[#55534b]"><strong>Compensation :</strong> {item.compensating_controls}</p>
            {item.decision_note ? <p className="mt-1 text-[9px] italic text-[#5f5d56]">Décision : {item.decision_note}</p> : null}
            {item.status === "pending" ? <div className="mt-3 flex flex-wrap gap-2"><Input aria-label="Decision note" value={notes[item.id] ?? ""} onChange={(event) => setNotes({ ...notes, [item.id]: event.target.value })} placeholder="Note de décision (10 caractères minimum)" className={cn(field, "w-72")} /><Button type="button" disabled={pending || (notes[item.id] ?? "").length < 10} onClick={() => act({ action: "decide_exception", id: item.id, approve: true, note: notes[item.id] }, "Exception approuvée")} className="h-8 rounded-none bg-[#2f6f4f] text-[9px] text-white">Approuver</Button><Button type="button" variant="outline" disabled={pending || (notes[item.id] ?? "").length < 10} onClick={() => act({ action: "decide_exception", id: item.id, approve: false, note: notes[item.id] }, "Exception rejetée")} className="h-8 rounded-none border-[#b8322a] bg-transparent text-[9px] text-[#b8322a]">Rejeter</Button></div> : null}
          </article>))}
      </div>
    </div>
  );
}

function Policies({ snapshot, act, pending }: { snapshot: Snapshot; act: (body: Record<string, unknown>, success: string, after?: () => void) => void; pending: boolean }) {
  const [form, setForm] = useState({ title: "", version: "1.0", status: "draft", ucCode: "UC-GOV-01", reviewDays: 365, content: "" });
  return (
    <div className="grid gap-8 xl:grid-cols-[360px_1fr]">
      <form className="space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "save_policy", title: form.title, version: form.version, status: form.status, ucCodes: [form.ucCode], nextReview: new Date(Date.now() + form.reviewDays * 86_400_000).toISOString(), content: form.content || undefined }, "Politique enregistrée", () => setForm({ ...form, title: "", content: "" })); }}>
        <MicroLabel>Enregistrer une politique</MicroLabel>
        <Input aria-label="Policy title" placeholder="Titre de la politique" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={field} />
        <div className="flex gap-2"><Input aria-label="Version" value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} className={cn(field, "w-20")} /><select aria-label="Status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })} className={select}>{["draft", "in_review", "approved", "retired"].map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select><select aria-label="Review cycle" value={form.reviewDays} onChange={(event) => setForm({ ...form, reviewDays: Number(event.target.value) })} className={select}>{[90, 180, 365].map((value) => <option key={value} value={value}>revue {value} j</option>)}</select></div>
        <select aria-label="Unified control" value={form.ucCode} onChange={(event) => setForm({ ...form, ucCode: event.target.value })} className={cn(select, "w-full")}>{snapshot.controls.map((control) => <option key={control.code} value={control.code}>{control.code} — {control.title}</option>)}</select>
        <Textarea aria-label="Policy content" placeholder="Contenu (optionnel) : son empreinte SHA-256 est conservée" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} className="min-h-20 rounded-none text-[10px] placeholder:text-[#63615a]" />
        <Button type="submit" disabled={form.title.length < 3 || pending} className="h-8 w-full rounded-none bg-[#171713] text-[10px] text-white">Enregistrer</Button>
      </form>
      <div tabIndex={0} role="region" aria-label="Table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[620px] text-left text-[9px]"><caption className="sr-only">Policy register</caption><thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["Politique", "Version", "Statut", "Prochaine revue", "Contrôles", "Empreinte"].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
        <tbody>{snapshot.policies.map((item) => <tr key={item.id} className="border-t border-[#d8d4ca]"><td className="px-3 py-3 font-medium">{item.title}</td><td className="px-3 py-3 font-mono">{item.version}</td><td className="px-3 py-3"><Badge value={item.status === "approved" ? "compliant" : item.status === "retired" ? "not_applicable" : "partial"} label={item.status} /></td><td className="px-3 py-3 font-mono">{item.next_review?.slice(0, 10) ?? "—"}{item.overdue ? <span className="ms-1 text-[#b8322a]">EN RETARD</span> : null}</td><td className="px-3 py-3 font-mono text-[8px]">{item.ucCodes.join(" · ")}</td><td className="px-3 py-3 font-mono text-[8px]">{item.document_hash ? item.document_hash.slice(0, 12) : "—"}</td></tr>)}</tbody></table>
        {snapshot.policies.length === 0 ? <p className="p-6 text-[10px] text-[#5f5d56]">Aucune politique enregistrée.</p> : null}</div>
    </div>
  );
}


/** Lets an organisation import its own licensed copy of framework text. It stays in this tenant and can be removed at any time. */
function LicensedPanel({ framework, imports, imported, run, pending }: { framework: FrameworkId; imports: ImportRecord[]; imported: number; run: (method: "POST" | "DELETE", framework: FrameworkId, payload?: Record<string, unknown>) => void; pending: boolean }) {
  const [label, setLabel] = useState("");
  const [licence, setLicence] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [items, setItems] = useState<unknown[] | null>(null);
  const [fileError, setFileError] = useState("");
  const current = imports.find((item) => item.framework_id === framework);

  async function readFile(file: File | undefined) {
    setItems(null);
    setFileError("");
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const list = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown }).items;
      if (!Array.isArray(list) || list.length === 0) throw new Error("Le fichier doit être un tableau JSON ou { \"items\": [...] }");
      setItems(list);
    } catch (error) { setFileError(errorMessage(error, "Fichier illisible")); }
  }

  return (
    <details className="border border-[#cbc7bd] p-3">
      <summary className="cursor-pointer font-mono text-[8px] uppercase tracking-wider text-[#5f5d56]">Contenu sous licence{current ? ` · importé (${imported} sous-exigence(s))` : ""}</summary>
      <div className="mt-3 space-y-3 text-[9px] text-[#55534b]">
        <p className="max-w-3xl">Certains référentiels sont sous licence (procédures de test PCI DSS, points de focus SOC 2). Kontrol ne fournit que les identifiants et titres courts. Si votre organisation détient la licence, importez votre propre copie : elle reste dans ce tenant, jamais dans le dépôt, et peut être retirée à tout moment. Format : un tableau JSON d’éléments <span className="font-mono">{"{ id, title?, parent?, procedure?, guidance? }"}</span>. Un id nouveau crée une sous-exigence sous <span className="font-mono">parent</span> (elle hérite de ses contrôles et remplace le parent dans le score) ; un id existant reçoit seulement du texte.</p>
        {current ? <div className="flex flex-wrap items-center gap-3 border border-[#cbc7bd] bg-[#f8f6f0] p-2"><span>Import actif : <strong>{current.source_label}</strong> · licence « {current.licence_reference} » confirmée par <span className="font-mono">{current.acknowledged_by}</span> le {current.acknowledged_at.slice(0, 10)} · {current.items} élément(s) · <span className="font-mono">sha256 {current.content_hash.slice(0, 12)}…</span></span><Button type="button" variant="outline" disabled={pending} onClick={() => { if (window.confirm("Supprimer le contenu importé pour ce référentiel ? Les scores reviennent au catalogue.")) run("DELETE", framework); }} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[8px] text-[#b8322a]"><Trash2 className="me-1 h-3 w-3" aria-hidden="true" />Retirer</Button></div> : null}
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[8px]">Fichier JSON <Input type="file" accept="application/json,.json" aria-label="Licensed content file" onChange={(event) => void readFile(event.target.files?.[0])} className={cn(field, "mt-0.5 w-56 pt-1")} /></label>
          <Input aria-label="Source label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Source (ex. PCI DSS v4.0.1, copie licenciée)" className={cn(field, "w-64")} />
          <Input aria-label="Licence reference" value={licence} onChange={(event) => setLicence(event.target.value)} placeholder="Référence de la licence" className={cn(field, "w-52")} />
        </div>
        <label className="flex max-w-3xl items-start gap-2"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5" /><span>Je confirme que mon organisation est autorisée par licence à détenir et utiliser ce contenu en interne.</span></label>
        {fileError ? <p role="alert" className="text-[#9f2923]">{fileError}</p> : null}
        <Button type="button" disabled={pending || !items || !acknowledged || label.trim().length < 3 || licence.trim().length < 3} onClick={() => run("POST", framework, { sourceLabel: label, licenceReference: licence, acknowledgeLicence: true, items })} className="h-8 rounded-none bg-[#171713] text-[9px] text-white">Importer{items ? ` ${items.length} élément(s)` : ""}</Button>
      </div>
    </details>
  );
}
