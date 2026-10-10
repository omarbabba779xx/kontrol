"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import { ChevronDown, Download, FolderPlus, Wand2 } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Counts = { open: number; provided: number; accepted: number; needs_more: number };
type Engagement = { id: string; name: string; framework_id: string; kind: string; scope: string; period_start: string; period_end: string; auditor_org: string; status: string; requests: Counts };
type AuditEvent = { id: string; kind: string; author_id: string; author_name: string | null; body: string; reference: Record<string, unknown>; created_at: string };
type AuditRequest = { id: string; ref: string; title: string; description: string; uc_code: string | null; assignee_name: string | null; status: string; due_at: string | null; overdue: boolean; events: AuditEvent[] };
type Coverage = { periodDays: number; elapsedDays: number; controls: Array<{ ucCode: string; title: string; healthyDays: number; failingDays: number; gapDays: number; effectiveness: number | null; controls: Array<{ code: string; points: number; failures: number; longestGapDays: number }> }> };
type Detail = { engagement: Engagement; evidenceOptions: Array<{ id: string; uc_code: string; title: string }>; requests: AuditRequest[]; access: Array<{ user_id: string; name: string; email: string; expires_at: string; active: boolean }>; coverage: Coverage; canManage: boolean; viewer: { external: boolean; auditor: boolean } };
type Person = { id: string; name: string; role: string; external: boolean };
type EvidenceOption = { id: string; uc_code: string; title: string };

const KINDS: Array<[string, string]> = [["soc2_type2", "SOC 2 Type II"], ["soc2_type1", "SOC 2 Type I"], ["iso27001_certification", "ISO 27001 certification"], ["internal", "Internal audit"], ["other", "Other"]];
const FRAMEWORKS: Array<[string, string]> = [["soc2", "SOC 2"], ["iso27001", "ISO 27001"], ["nist_csf", "NIST CSF"], ["gdpr", "GDPR"], ["nis2", "NIS2"], ["dora", "DORA"], ["eu_ai_act", "EU AI Act"], ["iso42001", "ISO 42001"], ["pci_dss", "PCI DSS"], ["cis_v8", "CIS v8"]];
const STATUS_STYLE: Record<string, string> = { open: "bg-[#f1e7cc] text-[#7a5a1a]", provided: "bg-[#e5e2d8] text-[#34332e]", accepted: "bg-[#dcebe1] text-[#245c3f]", needs_more: "bg-[#f5e5e1] text-[#9f2923]", planning: "bg-[#e5e2d8] text-[#34332e]", fieldwork: "bg-[#f1e7cc] text-[#7a5a1a]", review: "bg-[#f6e3d3] text-[#944a15]", closed: "bg-[#dcebe1] text-[#245c3f]" };
const NEXT: Record<string, string | null> = { planning: "fieldwork", fieldwork: "review", review: "closed", closed: null };
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[12px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[12px] focus-visible:outline-2 focus-visible:outline-[#171713]";
const tabs = ["Requests", "Period coverage", "Access", "Evidence pack"] as const;
type Tab = (typeof tabs)[number];
const day = (value: string | null) => (value ? value.slice(0, 10) : "—");

function Pill({ value }: { value: string }) { return <span className={cn("px-1.5 py-0.5 font-mono text-[10px] uppercase", STATUS_STYLE[value] ?? "bg-[#e5e2d8]")}>{value.replace("_", " ")}</span>; }

export function AuditWorkspace() {
  const [engagements, setEngagements] = useState<Engagement[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [tab, setTab] = useState<Tab>("Requests");
  const [status, setStatus] = useState("Loading…");
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  const loadList = useCallback((signal?: AbortSignal) => fetchJson<{ engagements: Engagement[] }>("/api/audit", { signal }).then((data) => { setEngagements(data.engagements); setFailed(false); return data.engagements; }), []);
  const loadDetail = useCallback((id: string, signal?: AbortSignal) => fetchJson<Detail>(`/api/audit/${id}`, { signal }).then(setDetail), []);

  useEffect(() => {
    const controller = new AbortController();
    loadList(controller.signal).then((list) => { setStatus("Up to date"); setSelected((current) => current ?? list[0]?.id ?? null); }).catch((error: unknown) => { if (!isAbort(error)) { setFailed(true); setStatus(errorMessage(error, "Audit workspace unavailable")); } });
    fetchJson<{ users: Person[] }>("/api/users", { signal: controller.signal }).then((data) => setPeople(data.users)).catch(() => undefined);
    return () => controller.abort();
  }, [loadList]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    loadDetail(selected, controller.signal).catch((error: unknown) => { if (!isAbort(error)) setStatus(errorMessage(error, "Engagement unavailable")); });
    return () => controller.abort();
  }, [selected, loadDetail]);

  function act(body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) {
    startTransition(async () => {
      let result: Record<string, unknown> = {};
      try { setStatus("Saving…"); result = await fetchJson<Record<string, unknown>>("/api/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
      catch (error) { setStatus(errorMessage(error, "Action failed")); return; }
      try { await loadList(); if (selected) await loadDetail(selected); setStatus(success); after?.(result); } catch (error) { setStatus(`Done, but refresh failed: ${errorMessage(error, "unknown error")}`); }
    });
  }

  const canCreate = !detail?.viewer.external && people.length > 0;
  return (
    <div>
      <PageHeading index="15" title="Audit workspace" description="Engagements, auditor requests and responses, operating effectiveness over the audit period, and a self-verifying evidence pack." meta={status} />
      <section className="p-5 sm:p-7 lg:p-9" aria-busy={engagements === null && !failed}>
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[11px] text-[#9f2923]">{status}</div> : null}
        <div className="grid gap-8 xl:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <MicroLabel>Engagements</MicroLabel>
            {(engagements ?? []).map((item) => (
              <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => setSelected(item.id)} className={cn("block w-full border p-3 text-start", selected === item.id ? "border-[#171713] bg-[#f8f6f0]" : "border-[#cbc7bd] hover:border-[#171713]")}>
                <div className="flex items-start justify-between gap-2"><span className="text-[13px] font-semibold">{item.name}</span><Pill value={item.status} /></div>
                <p className="mt-1 font-mono text-[10px] text-[#5f5d56]">{KINDS.find(([key]) => key === item.kind)?.[1]} · {day(item.period_start)} to {day(item.period_end)}</p>
                <p className="mt-1 font-mono text-[10px] text-[#5f5d56]">{item.requests.open + item.requests.needs_more} open · {item.requests.provided} provided · {item.requests.accepted} accepted</p>
              </button>))}
            {engagements && engagements.length === 0 ? <p className="text-[12px] text-[#5f5d56]">No engagements{canCreate ? " yet" : " have been shared with you"}.</p> : null}
            {canCreate || (engagements && engagements.length === 0 && people.length > 0) ? <NewEngagement people={people} act={act} pending={isPending} onCreated={setSelected} /> : null}
          </div>

          <div>
            {detail ? (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3 border border-[#cbc7bd] p-4">
                  <div><div className="flex items-center gap-2"><h2 className="text-[14px] font-semibold">{detail.engagement.name}</h2><Pill value={detail.engagement.status} /></div>
                    <p className="mt-1 text-[11px] text-[#55534b]">{FRAMEWORKS.find(([key]) => key === detail.engagement.framework_id)?.[1]} · {KINDS.find(([key]) => key === detail.engagement.kind)?.[1]} · {day(detail.engagement.period_start)} to {day(detail.engagement.period_end)}{detail.engagement.auditor_org ? ` · ${detail.engagement.auditor_org}` : ""}</p>
                    {detail.engagement.scope ? <p className="mt-1 max-w-2xl text-[11px] text-[#34332e]">{detail.engagement.scope}</p> : null}</div>
                  {detail.canManage && NEXT[detail.engagement.status] ? <Button type="button" variant="outline" disabled={isPending} onClick={() => { if (NEXT[detail.engagement.status] !== "closed" || window.confirm("Close this engagement? Auditor access is revoked and it can no longer change.")) act({ action: "set_status", id: detail.engagement.id, status: NEXT[detail.engagement.status] }, `Engagement moved to ${NEXT[detail.engagement.status]}`); }} className="h-8 rounded-none border-[#171713] bg-transparent text-[11px]">Move to {NEXT[detail.engagement.status]}</Button> : null}
                </div>
                <div role="tablist" aria-label="Engagement sections" className="flex flex-wrap border-b border-[#cbc7bd]">{tabs.filter((name) => name !== "Access" || !detail.viewer.external).map((name) => <button key={name} role="tab" aria-selected={tab === name} type="button" onClick={() => setTab(name)} className={cn("px-4 py-2.5 text-[12px] font-medium", tab === name ? "border-b-2 border-[#171713]" : "text-[#5f5d56] hover:text-[#171713]")}>{name}</button>)}</div>
                {tab === "Requests" ? <Requests detail={detail} people={people} evidence={detail.evidenceOptions} act={act} pending={isPending} /> : null}
                {tab === "Period coverage" ? <CoverageTable coverage={detail.coverage} /> : null}
                {tab === "Access" ? <Access detail={detail} people={people} act={act} pending={isPending} /> : null}
                {tab === "Evidence pack" ? <PackPanel detail={detail} /> : null}
              </div>
            ) : <p className="text-[12px] text-[#5f5d56]">{selected ? "Loading…" : "Select an engagement."}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

type Act = (body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => void;

function NewEngagement({ people, act, pending, onCreated }: { people: Person[]; act: Act; pending: boolean; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ name: "", frameworkId: "soc2", kind: "soc2_type2", periodStart: "", periodEnd: "", auditorOrg: "", scope: "", leadId: "" });
  return (
    <details className="border border-[#cbc7bd] p-3">
      <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">New engagement</summary>
      <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); act({ action: "create_engagement", name: form.name, frameworkId: form.frameworkId, kind: form.kind, scope: form.scope || undefined, periodStart: `${form.periodStart}T00:00:00.000Z`, periodEnd: `${form.periodEnd}T23:59:59.000Z`, auditorOrg: form.auditorOrg || undefined, leadId: form.leadId || undefined }, "Engagement created", (result) => onCreated(String(result.id))); }}>
        <Input aria-label="Engagement name" placeholder="Name (SOC 2 Type II 2026)" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={field} />
        <div className="flex gap-2"><select aria-label="Framework" value={form.frameworkId} onChange={(event) => setForm({ ...form, frameworkId: event.target.value })} className={cn(select, "flex-1")}>{FRAMEWORKS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select aria-label="Engagement type" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })} className={cn(select, "flex-1")}>{KINDS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
        <div className="flex gap-2"><label className="flex-1 text-[10px]">Period start<Input type="date" aria-label="Period start" value={form.periodStart} onChange={(event) => setForm({ ...form, periodStart: event.target.value })} className={field} /></label><label className="flex-1 text-[10px]">Period end<Input type="date" aria-label="Period end" value={form.periodEnd} onChange={(event) => setForm({ ...form, periodEnd: event.target.value })} className={field} /></label></div>
        <Input aria-label="Audit firm" placeholder="Audit firm (optional)" value={form.auditorOrg} onChange={(event) => setForm({ ...form, auditorOrg: event.target.value })} className={field} />
        <select aria-label="Engagement lead" value={form.leadId} onChange={(event) => setForm({ ...form, leadId: event.target.value })} className={cn(select, "w-full")}><option value="">No lead</option>{people.filter((person) => !person.external).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
        <Textarea aria-label="Scope" placeholder="Scope (systems, locations, services)" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })} className="min-h-14 rounded-none text-[12px] placeholder:text-[#63615a]" />
        <Button type="submit" disabled={pending || form.name.trim().length < 3 || !form.periodStart || !form.periodEnd} className="h-8 w-full rounded-none bg-[#171713] text-[12px] text-white"><FolderPlus className="me-1.5 h-3 w-3" aria-hidden="true" />Create engagement</Button>
      </form>
    </details>
  );
}

function Requests({ detail, people, evidence, act, pending }: { detail: Detail; people: Person[]; evidence: EvidenceOption[]; act: Act; pending: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [evidenceId, setEvidenceId] = useState("");
  const [form, setForm] = useState({ title: "", description: "", dueAt: "", assigneeId: "" });
  const locked = detail.engagement.status === "closed";
  return (
    <div className="space-y-4">
      {!locked ? <div className="flex flex-wrap items-start gap-4">
        <form className="flex min-w-[320px] flex-1 flex-wrap items-end gap-2 border border-[#cbc7bd] p-3" onSubmit={(event) => { event.preventDefault(); act({ action: "create_request", engagementId: detail.engagement.id, title: form.title, description: form.description || undefined, dueAt: form.dueAt ? `${form.dueAt}T12:00:00.000Z` : undefined, assigneeId: form.assigneeId || undefined }, "Request created", () => setForm({ title: "", description: "", dueAt: "", assigneeId: "" })); }}>
          <Input aria-label="Request title" placeholder="New request" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={cn(field, "min-w-48 flex-1")} />
          <Input aria-label="Request due date" type="date" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} className={cn(field, "w-36")} />
          {detail.canManage ? <select aria-label="Request assignee" value={form.assigneeId} onChange={(event) => setForm({ ...form, assigneeId: event.target.value })} className={select}><option value="">Unassigned</option>{people.filter((person) => !person.external).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select> : null}
          <Button type="submit" disabled={pending || form.title.trim().length < 3} className="h-8 rounded-none bg-[#171713] text-[11px] text-white">Add request</Button>
        </form>
        {detail.canManage ? <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "generate_requests", engagementId: detail.engagement.id, limit: 40 }, "Requests generated from controls")} className="h-8 rounded-none border-[#171713] bg-transparent text-[11px]"><Wand2 className="me-1.5 h-3 w-3" aria-hidden="true" />Generate from controls</Button> : null}
      </div> : null}
      <div tabIndex={0} role="region" aria-label="Requests table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[720px] text-left text-[11px]"><caption className="sr-only">Auditor requests</caption>
        <thead><tr className="bg-[#e9e5db] font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">{["Ref", "Request", "Status", "Assignee", "Due", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
        <tbody>{detail.requests.map((request) => (
          <Fragment key={request.id}>
            <tr className="border-t border-[#d8d4ca] align-top"><td className="px-3 py-3 font-mono font-semibold">{request.ref}</td><td className="max-w-[300px] px-3 py-3"><span className="font-medium">{request.title}</span>{request.uc_code ? <span className="block font-mono text-[10px] text-[#5f5d56]">{request.uc_code}</span> : null}</td><td className="px-3 py-3"><Pill value={request.status} /></td><td className="px-3 py-3">{request.assignee_name ?? "—"}</td><td className={cn("px-3 py-3 font-mono", request.overdue && "font-bold text-[#b8322a]")}>{day(request.due_at)}{request.overdue ? " · OVERDUE" : ""}</td>
              <td className="px-3 py-3 text-end"><Button type="button" variant="ghost" aria-expanded={open === request.id} onClick={() => { setOpen(open === request.id ? null : request.id); setText(""); setEvidenceId(""); }} className="h-6 rounded-none px-1 text-[10px]">Thread ({request.events.filter((event) => event.kind !== "status").length}) <ChevronDown className={cn("ms-0.5 h-2.5 w-2.5 transition-transform", open === request.id && "rotate-180")} aria-hidden="true" /></Button></td></tr>
            {open === request.id ? <tr className="bg-[#f1eee5]"><td colSpan={6} className="px-5 py-4"><div className="max-w-3xl space-y-2">
              {request.description ? <p className="whitespace-pre-wrap text-[11px] text-[#34332e]">{request.description}</p> : null}
              {request.events.map((event) => <p key={event.id} className={cn("border-s-2 ps-2 text-[11px]", event.kind === "response" ? "border-[#245c3f]" : event.kind === "comment" ? "border-[#7a5a1a]" : "border-[#cbc7bd] text-[#5f5d56]")}><span className="font-mono text-[10px] text-[#5f5d56]">{event.created_at.slice(0, 16).replace("T", " ")} · {event.author_name ?? event.author_id} · {event.kind}</span><br />{event.body}{event.reference.title ? <span className="mt-0.5 block font-mono text-[10px] text-[#245c3f]">Evidence: {String(event.reference.title)} · sha256 {String(event.reference.hash ?? "").slice(0, 16)}…</span> : null}</p>)}
              {!locked ? <div className="space-y-2 pt-1">
                <Textarea aria-label={`Message on ${request.ref}`} value={text} onChange={(event) => setText(event.target.value)} placeholder="Comment or response" className="min-h-14 rounded-none text-[12px] placeholder:text-[#63615a]" />
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" disabled={pending || text.trim().length < 2} onClick={() => act({ action: "comment", requestId: request.id, body: text }, "Comment added", () => setText(""))} className="h-7 rounded-none border-[#171713] bg-transparent text-[11px]">Comment</Button>
                  {detail.canManage ? <><select aria-label={`Evidence for ${request.ref}`} value={evidenceId} onChange={(event) => setEvidenceId(event.target.value)} className={cn(select, "h-7 max-w-56")}><option value="">No evidence attached</option>{evidence.map((item) => <option key={item.id} value={item.id}>{item.uc_code} · {item.title}</option>)}</select>
                    <Button type="button" disabled={pending || (text.trim().length < 2 && !evidenceId)} onClick={() => act({ action: "respond", requestId: request.id, note: text.trim() || undefined, evidence: evidenceId ? { type: "control_evidence", id: evidenceId } : undefined }, "Response provided", () => { setText(""); setEvidenceId(""); })} className="h-7 rounded-none bg-[#171713] text-[11px] text-white">Provide response</Button></> : null}
                  {detail.viewer.auditor && request.status === "provided" ? <><Button type="button" disabled={pending} onClick={() => act({ action: "set_request_status", requestId: request.id, status: "accepted" }, "Response accepted")} className="h-7 rounded-none bg-[#245c3f] text-[11px] text-white">Accept</Button><Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "set_request_status", requestId: request.id, status: "needs_more" }, "Sent back for more")} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[11px] text-[#b8322a]">Needs more</Button></> : null}
                </div>
              </div> : null}
            </div></td></tr> : null}
          </Fragment>))}</tbody></table>
        {detail.requests.length === 0 ? <p className="p-8 text-center text-[12px] text-[#5f5d56]">No requests yet.</p> : null}
      </div>
    </div>
  );
}

function CoverageTable({ coverage }: { coverage: Coverage }) {
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-[12px] text-[#55534b]">Operating effectiveness over the period ({coverage.elapsedDays} of {coverage.periodDays} days elapsed): for each control backed by automated evidence, the days with healthy evidence, failing evidence, or none. A point of evidence counts until the next one or its expiry; after that is a gap, not a pass.</p>
      <div tabIndex={0} role="region" aria-label="Period coverage, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[720px] text-left text-[11px]"><caption className="sr-only">Period coverage</caption>
        <thead><tr className="bg-[#e9e5db] font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">{["Control", "Effectiveness", "Healthy days", "Failing days", "No evidence", "Evaluations"].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
        <tbody>{coverage.controls.map((item) => <tr key={item.ucCode} className="border-t border-[#d8d4ca]"><td className="px-3 py-3"><span className="font-mono font-semibold">{item.ucCode}</span><span className="block">{item.title}</span><span className="font-mono text-[10px] text-[#5f5d56]">{item.controls.map((control) => control.code).join(" · ")}</span></td>
          <td className="px-3 py-3"><div className="h-1.5 w-28 bg-[#ddd9cf]" role="img" aria-label={`${Math.round((item.effectiveness ?? 0) * 100)} percent`}><div className={cn("h-full", (item.effectiveness ?? 0) >= 0.9 ? "bg-[#2f6f4f]" : (item.effectiveness ?? 0) >= 0.6 ? "bg-[#a98a45]" : "bg-[#b8322a]")} style={{ width: `${Math.round((item.effectiveness ?? 0) * 100)}%` }} /></div><span className="font-mono">{item.effectiveness === null ? "n/a" : `${Math.round(item.effectiveness * 100)}%`}</span></td>
          <td className="px-3 py-3 font-mono">{item.healthyDays}</td><td className={cn("px-3 py-3 font-mono", item.failingDays > 0 && "font-bold text-[#b8322a]")}>{item.failingDays}</td><td className="px-3 py-3 font-mono">{item.gapDays}</td><td className="px-3 py-3 font-mono">{item.controls.reduce((sum, control) => sum + control.points, 0)}</td></tr>)}</tbody></table>
        {coverage.controls.length === 0 ? <p className="p-8 text-center text-[12px] text-[#5f5d56]">No control is linked to automated evidence yet. Link executable controls in the compliance hub.</p> : null}</div>
    </div>
  );
}

function Access({ detail, people, act, pending }: { detail: Detail; people: Person[]; act: Act; pending: boolean }) {
  const [userId, setUserId] = useState("");
  const [days, setDays] = useState(30);
  const externals = people.filter((person) => person.external);
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[12px] text-[#55534b]">External auditors see only the engagements they are granted, until the access expires, and nothing else in the platform. Closing the engagement revokes every grant. Create external auditor accounts in Administration.</p>
      {detail.canManage && detail.engagement.status !== "closed" ? <form className="flex flex-wrap items-end gap-2 border border-[#cbc7bd] p-3" onSubmit={(event) => { event.preventDefault(); act({ action: "grant_access", engagementId: detail.engagement.id, userId, days }, "Access granted"); }}>
        <select aria-label="External auditor" value={userId} onChange={(event) => setUserId(event.target.value)} className={cn(select, "min-w-56")}><option value="">Choose an external auditor</option>{externals.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
        <select aria-label="Access duration" value={days} onChange={(event) => setDays(Number(event.target.value))} className={select}>{[7, 14, 30, 60, 90, 180].map((value) => <option key={value} value={value}>{value} days</option>)}</select>
        <Button type="submit" disabled={pending || !userId} className="h-8 rounded-none bg-[#171713] text-[11px] text-white">Grant access</Button>
      </form> : null}
      <div className="max-w-2xl border border-[#cbc7bd]">{detail.access.map((row) => <div key={row.user_id} className="flex items-center justify-between border-b border-[#d8d4ca] p-3 text-[11px] last:border-b-0"><div><span className="font-medium">{row.name}</span><span className="block font-mono text-[10px] text-[#5f5d56]">{row.email} · {row.active ? `until ${day(row.expires_at)}` : "inactive"}</span></div>{row.active && detail.canManage ? <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "revoke_access", engagementId: detail.engagement.id, userId: row.user_id }, "Access revoked")} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[11px] text-[#b8322a]">Revoke</Button> : null}</div>)}
        {detail.access.length === 0 ? <p className="p-6 text-[12px] text-[#5f5d56]">No external auditor has access.</p> : null}</div>
    </div>
  );
}

function PackPanel({ detail }: { detail: Detail }) {
  return (
    <div className="max-w-3xl space-y-3 text-[12px] text-[#34332e]">
      <p>A ZIP the auditor can verify without trusting Kontrol: the statement of applicability and readiness report, one file per control with its attestation, documents and the full population of automated evaluations during the period, the period coverage, the requests and their conversation, and the complete hash-chained audit log.</p>
      <ul className="list-disc space-y-1 ps-5 text-[11px] text-[#55534b]"><li>Every file is listed with its SHA-256 in a signed manifest.</li><li>The audit log can be recomputed from the file alone; any edit breaks the chain.</li><li>Every download is recorded in the engagement and in the audit log.</li></ul>
      <a href={`/api/audit/${detail.engagement.id}/pack`} download className="inline-flex h-9 items-center border border-[#171713] px-4 text-[12px] font-semibold hover:bg-[#171713] hover:text-white"><Download className="me-2 h-3.5 w-3.5" aria-hidden="true" />Download evidence pack</a>
    </div>
  );
}
