"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import { ChevronDown, Copy, Download, Plus, Send } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Provider = { id: string; name: string; lei: string | null; country: string; provider_type: string; status: string };
type Arrangement = { id: string; provider_id: string; ref: string; service_type: string; function_supported: string; criticality: string; start_date: string; end_date: string | null; governing_law: string | null; service_country: string | null; data_country: string | null; data_sensitivity: string; subcontractors: Array<{ name: string; country?: string }>; substitutability: string; exit_plan: boolean; exit_tested_at: string | null; audit_rights: boolean; incident_notification_hours: number | null; status: string };
type Issue = { severity: "error" | "warning"; code: string; ref: string; provider: string; message: string };
type Concentration = { criticalArrangements: number; hhi: number; level: "low" | "moderate" | "high"; providers: Array<{ providerId: string; name: string; critical: number; share: number; countries: string[] }> };
type Questionnaire = { id: string; provider_id: string; status: string; expires_at: string; expired: boolean; score: number | null; critical_failures: number; respondent_name: string | null; submitted_at: string | null; review_note: string | null };
type Snapshot = { providers: Provider[]; arrangements: Arrangement[]; issues: Issue[]; exportable: boolean; concentration: Concentration; questionnaires: Questionnaire[] };
type Detail = { id: string; status: string; score: number; scored: { score: number; level: string; criticalFailures: string[] }; respondent: { name: string; email: string }; answers: Array<{ id: string; section: string; text: string; critical: boolean; ucCode: string; answer: string | null; comment: string }> };

const SERVICE_TYPES = ["cloud_iaas", "cloud_paas", "cloud_saas", "data_centre", "network_telecom", "security_services", "software_licensing", "data_analytics", "payment_services", "market_data", "other_ict"];
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[12px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[12px] focus-visible:outline-2 focus-visible:outline-[#171713]";
const tabs = ["Register", "Findings", "Questionnaires", "Export"] as const;
type Tab = (typeof tabs)[number];
const STATUS: Record<string, string> = { sent: "bg-[#f1e7cc] text-[#7a5a1a]", submitted: "bg-[#f6e3d3] text-[#944a15]", accepted: "bg-[#dcebe1] text-[#245c3f]", rejected: "bg-[#f5e5e1] text-[#9f2923]", revoked: "bg-[#e5e2d8] text-[#55534b]" };
const LEVEL: Record<string, string> = { low: "text-[#245c3f]", moderate: "text-[#7a5a1a]", medium: "text-[#7a5a1a]", high: "text-[#b8322a]" };
const day = (value: string | null) => (value ? value.slice(0, 10) : "—");
const label = (value: string) => value.replace(/_/g, " ");

type Act = (body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => void;

export function ThirdParty() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [tab, setTab] = useState<Tab>("Register");
  const [status, setStatus] = useState("Loading…");
  const [failed, setFailed] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback((signal?: AbortSignal) => fetchJson<Snapshot>("/api/third-party", { signal }).then((data) => { setSnapshot(data); setFailed(false); }), []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(() => setStatus("Up to date")).catch((error: unknown) => { if (!isAbort(error)) { setFailed(true); setStatus(errorMessage(error, "Third parties unavailable")); } });
    return () => controller.abort();
  }, [load]);

  const act: Act = (body, success, after) => {
    startTransition(async () => {
      let result: Record<string, unknown> = {};
      try { setStatus("Saving…"); result = await fetchJson<Record<string, unknown>>("/api/third-party", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
      catch (error) { setStatus(errorMessage(error, "Action failed")); return; }
      try { await load(); setStatus(success); after?.(result); } catch (error) { setStatus(`Done, but refresh failed: ${errorMessage(error, "unknown error")}`); }
    });
  };

  const errors = snapshot?.issues.filter((issue) => issue.severity === "error").length ?? 0;
  return (
    <div>
      <PageHeading index="16" title="Third parties" description="The DORA register of information, ICT concentration and exit readiness, and security questionnaires that vendors answer through a one-time link." meta={status} />
      <section className="p-5 sm:p-7 lg:p-9" aria-busy={snapshot === null && !failed}>
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[11px] text-[#9f2923]">{status}</div> : null}
        {snapshot ? (
          <div className="space-y-6">
            <div className="grid gap-px border border-[#cbc7bd] bg-[#cbc7bd] sm:grid-cols-4">
              {[["Providers", snapshot.providers.filter((p) => p.status === "active").length], ["Active arrangements", snapshot.arrangements.filter((a) => a.status === "active").length], ["Critical or important", snapshot.concentration.criticalArrangements], ["Blocking errors", errors]].map(([name, value]) => <div key={String(name)} className="bg-[#f4f1e9] p-4"><MicroLabel>{String(name)}</MicroLabel><p className={cn("mt-1 font-mono text-[22px] font-semibold", name === "Blocking errors" && errors > 0 && "text-[#b8322a]")}>{value}</p></div>)}
            </div>
            <div role="tablist" aria-label="Third-party sections" className="flex flex-wrap border-b border-[#cbc7bd]">{tabs.map((name) => <button key={name} role="tab" aria-selected={tab === name} type="button" onClick={() => setTab(name)} className={cn("px-4 py-2.5 text-[12px] font-medium", tab === name ? "border-b-2 border-[#171713]" : "text-[#5f5d56] hover:text-[#171713]")}>{name}</button>)}</div>
            {tab === "Register" ? <Register snapshot={snapshot} act={act} pending={isPending} /> : null}
            {tab === "Findings" ? <Findings snapshot={snapshot} /> : null}
            {tab === "Questionnaires" ? <Questionnaires snapshot={snapshot} act={act} pending={isPending} link={link} setLink={setLink} /> : null}
            {tab === "Export" ? <ExportPanel snapshot={snapshot} /> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Register({ snapshot, act, pending }: { snapshot: Snapshot; act: Act; pending: boolean }) {
  const [provider, setProvider] = useState({ name: "", lei: "", country: "", providerType: "third_party" });
  const [form, setForm] = useState({ providerId: "", functionSupported: "", serviceType: "cloud_saas", criticality: "critical_or_important", startDate: "", endDate: "", governingLaw: "", serviceCountry: "", dataCountry: "", dataSensitivity: "personal", substitutability: "not_assessed", exitPlan: false, exitTestedAt: "", auditRights: false, incidentNotificationHours: "", subcontractors: "" });
  const name = (id: string) => snapshot.providers.find((item) => item.id === id)?.name ?? id;
  const needsDate = (value: string) => `${value}T00:00:00.000Z`;
  const subs = form.subcontractors.split(",").map((item) => item.trim()).filter(Boolean).map((item) => { const [subName, country] = item.split(":").map((part) => part.trim()); return country ? { name: subName, country: country.toUpperCase() } : { name: subName }; });
  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div className="space-y-4">
        <form className="space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "create_provider", name: provider.name, lei: provider.lei || undefined, country: provider.country.toUpperCase(), providerType: provider.providerType }, "Provider added", () => setProvider({ name: "", lei: "", country: "", providerType: "third_party" })); }}>
          <MicroLabel>Add an ICT provider</MicroLabel>
          <Input aria-label="Provider name" placeholder="Legal name" value={provider.name} onChange={(event) => setProvider({ ...provider, name: event.target.value })} className={field} />
          <Input aria-label="Provider LEI" placeholder="LEI (20 characters)" value={provider.lei} onChange={(event) => setProvider({ ...provider, lei: event.target.value.toUpperCase() })} className={cn(field, "font-mono")} />
          <div className="flex gap-2"><Input aria-label="Provider country" placeholder="Country (FR)" maxLength={2} value={provider.country} onChange={(event) => setProvider({ ...provider, country: event.target.value })} className={cn(field, "w-24")} /><select aria-label="Provider type" value={provider.providerType} onChange={(event) => setProvider({ ...provider, providerType: event.target.value })} className={cn(select, "flex-1")}><option value="third_party">Third party</option><option value="intra_group">Intra-group</option></select></div>
          <Button type="submit" disabled={pending || provider.name.trim().length < 2 || provider.country.length !== 2} className="h-8 w-full rounded-none bg-[#171713] text-[12px] text-white"><Plus className="me-1.5 h-3 w-3" aria-hidden="true" />Add provider</Button>
        </form>
        <details className="border border-[#cbc7bd] p-4">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">Add a contractual arrangement</summary>
          <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); act({ action: "create_arrangement", providerId: form.providerId, functionSupported: form.functionSupported, serviceType: form.serviceType, criticality: form.criticality, startDate: needsDate(form.startDate), endDate: form.endDate ? needsDate(form.endDate) : null, governingLaw: form.governingLaw ? form.governingLaw.toUpperCase() : null, serviceCountry: form.serviceCountry ? form.serviceCountry.toUpperCase() : null, dataCountry: form.dataCountry ? form.dataCountry.toUpperCase() : null, dataSensitivity: form.dataSensitivity, subcontractors: subs, substitutability: form.substitutability, exitPlan: form.exitPlan, exitTestedAt: form.exitTestedAt && form.exitPlan ? needsDate(form.exitTestedAt) : null, auditRights: form.auditRights, incidentNotificationHours: form.incidentNotificationHours ? Number(form.incidentNotificationHours) : null }, "Arrangement added"); }}>
            <select aria-label="Arrangement provider" value={form.providerId} onChange={(event) => setForm({ ...form, providerId: event.target.value })} className={cn(select, "w-full")}><option value="">Choose a provider</option>{snapshot.providers.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <Input aria-label="Function supported" placeholder="Function supported (e.g. core banking hosting)" value={form.functionSupported} onChange={(event) => setForm({ ...form, functionSupported: event.target.value })} className={field} />
            <div className="flex gap-2"><select aria-label="Service type" value={form.serviceType} onChange={(event) => setForm({ ...form, serviceType: event.target.value })} className={cn(select, "flex-1")}>{SERVICE_TYPES.map((type) => <option key={type} value={type}>{label(type)}</option>)}</select><select aria-label="Criticality" value={form.criticality} onChange={(event) => setForm({ ...form, criticality: event.target.value })} className={cn(select, "flex-1")}><option value="critical_or_important">Critical or important</option><option value="not_critical">Not critical</option></select></div>
            <div className="flex gap-2"><label className="flex-1 text-[10px]">Start<Input type="date" aria-label="Start date" value={form.startDate} onChange={(event) => setForm({ ...form, startDate: event.target.value })} className={field} /></label><label className="flex-1 text-[10px]">End<Input type="date" aria-label="End date" value={form.endDate} onChange={(event) => setForm({ ...form, endDate: event.target.value })} className={field} /></label></div>
            <div className="flex gap-2">{([["governingLaw", "Law"], ["serviceCountry", "Service in"], ["dataCountry", "Data in"]] as const).map(([key, text]) => <Input key={key} aria-label={text} placeholder={text} maxLength={2} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} className={field} />)}</div>
            <div className="flex gap-2"><select aria-label="Data sensitivity" value={form.dataSensitivity} onChange={(event) => setForm({ ...form, dataSensitivity: event.target.value })} className={cn(select, "flex-1")}><option value="none">No data</option><option value="personal">Personal data</option><option value="special_or_confidential">Special or confidential</option></select><select aria-label="Substitutability" value={form.substitutability} onChange={(event) => setForm({ ...form, substitutability: event.target.value })} className={cn(select, "flex-1")}>{["not_assessed", "easy", "difficult", "impossible"].map((value) => <option key={value} value={value}>{label(value)}</option>)}</select></div>
            <Input aria-label="Subcontractors" placeholder="Subcontractors: Name:NL, Other:DE" value={form.subcontractors} onChange={(event) => setForm({ ...form, subcontractors: event.target.value })} className={field} />
            <Input aria-label="Incident notification hours" type="number" min={1} placeholder="Incident notification (hours)" value={form.incidentNotificationHours} onChange={(event) => setForm({ ...form, incidentNotificationHours: event.target.value })} className={field} />
            <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={form.auditRights} onChange={(event) => setForm({ ...form, auditRights: event.target.checked })} />Audit and access rights in the contract</label>
            <label className="flex items-center gap-2 text-[11px]"><input type="checkbox" checked={form.exitPlan} onChange={(event) => setForm({ ...form, exitPlan: event.target.checked })} />Exit plan exists</label>
            {form.exitPlan ? <label className="block text-[10px]">Exit plan last tested<Input type="date" aria-label="Exit plan tested" value={form.exitTestedAt} onChange={(event) => setForm({ ...form, exitTestedAt: event.target.value })} className={field} /></label> : null}
            <Button type="submit" disabled={pending || !form.providerId || form.functionSupported.trim().length < 2 || !form.startDate} className="h-8 w-full rounded-none bg-[#171713] text-[12px] text-white">Add arrangement</Button>
          </form>
        </details>
      </div>
      <div tabIndex={0} role="region" aria-label="Arrangements table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[820px] text-left text-[11px]"><caption className="sr-only">Contractual arrangements</caption>
        <thead><tr className="bg-[#e9e5db] font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">{["Ref", "Provider and function", "Criticality", "Term", "Exit", "Substitutability", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
        <tbody>{snapshot.arrangements.map((item) => (
          <tr key={item.id} className={cn("border-t border-[#d8d4ca] align-top", item.status === "terminated" && "opacity-50")}>
            <td className="px-3 py-3 font-mono font-semibold">{item.ref}</td>
            <td className="px-3 py-3"><span className="font-medium">{name(item.provider_id)}</span><span className="block text-[#55534b]">{item.function_supported}</span><span className="font-mono text-[10px] text-[#5f5d56]">{label(item.service_type)} · {item.service_country ?? "?"}{item.subcontractors.length ? ` · ${item.subcontractors.length} subcontractor(s)` : ""}</span></td>
            <td className="px-3 py-3">{item.criticality === "critical_or_important" ? <span className="bg-[#f5e5e1] px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#9f2923]">critical</span> : <span className="font-mono text-[10px] uppercase text-[#5f5d56]">standard</span>}</td>
            <td className="px-3 py-3 font-mono">{day(item.start_date)}<br />{day(item.end_date)}</td>
            <td className="px-3 py-3 font-mono">{item.exit_plan ? `plan · tested ${day(item.exit_tested_at)}` : "no plan"}</td>
            <td className="px-3 py-3 font-mono">{label(item.substitutability)}</td>
            <td className="px-3 py-3 text-end">{item.status === "active" ? <Button type="button" variant="outline" disabled={pending} onClick={() => { const reason = window.prompt(`Why is ${item.ref} terminated?`); if (reason && reason.trim().length >= 5) act({ action: "terminate_arrangement", id: item.id, reason }, `${item.ref} terminated`); }} className="h-6 rounded-none border-[#b8322a] bg-transparent px-2 text-[10px] text-[#b8322a]">Terminate</Button> : <span className="font-mono text-[10px] uppercase">terminated</span>}</td>
          </tr>))}</tbody></table>
        {snapshot.arrangements.length === 0 ? <p className="p-8 text-center text-[12px] text-[#5f5d56]">No arrangements yet. Add a provider, then its contractual arrangements.</p> : null}
      </div>
    </div>
  );
}

function Findings({ snapshot }: { snapshot: Snapshot }) {
  const c = snapshot.concentration;
  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="space-y-3 border border-[#cbc7bd] p-4">
        <MicroLabel>ICT concentration</MicroLabel>
        <p className="text-[12px] text-[#55534b]">Herfindahl index over critical or important arrangements by provider (0 to 10,000; 1,500 moderate, 2,500 high). Not meaningful below three critical arrangements.</p>
        <p className={cn("font-mono text-[28px] font-semibold", LEVEL[c.level])}>{c.hhi}<span className="ms-2 text-[12px] uppercase">{c.level}</span></p>
        {c.providers.map((row) => <div key={row.providerId} className="text-[11px]"><div className="flex justify-between"><span>{row.name}</span><span className="font-mono">{row.critical} · {Math.round(row.share * 100)}% · {row.countries.join(", ") || "?"}</span></div><div className="mt-1 h-1.5 bg-[#ddd9cf]"><div className="h-full bg-[#171713]" style={{ width: `${Math.round(row.share * 100)}%` }} /></div></div>)}
      </div>
      <div className="space-y-2">
        <MicroLabel>Register findings ({snapshot.issues.length})</MicroLabel>
        {snapshot.issues.map((issue, index) => <div key={`${issue.ref}${issue.code}${index}`} className={cn("border-s-4 bg-[#f8f6f0] p-3 text-[11px]", issue.severity === "error" ? "border-[#b8322a]" : "border-[#a98a45]")}><span className="font-mono text-[10px] uppercase">{issue.severity} · {issue.ref} · {issue.provider}</span><p className="mt-0.5">{issue.message}</p></div>)}
        {snapshot.issues.length === 0 ? <p className="text-[12px] text-[#245c3f]">No findings: the register is complete and no supervisory red flag is raised.</p> : null}
      </div>
    </div>
  );
}

function Questionnaires({ snapshot, act, pending, link, setLink }: { snapshot: Snapshot; act: Act; pending: boolean; link: string | null; setLink: (value: string | null) => void }) {
  const [providerId, setProviderId] = useState("");
  const [days, setDays] = useState(14);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const name = (id: string) => snapshot.providers.find((item) => item.id === id)?.name ?? id;
  const toggle = (id: string) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id); setDetail(null); setNote("");
    fetchJson<Detail>(`/api/third-party/questionnaires/${id}`).then(setDetail).catch((error: unknown) => setMessage(errorMessage(error, "Could not load the answers")));
  };
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-[12px] text-[#55534b]">The vendor receives a link that works once and expires. They answer {20} questions mapped to unified controls; blocking questions (MFA, encryption, incident notification, audit rights, exit) cap the result at high risk. Answers are self-declared.</p>
      <form className="flex flex-wrap items-end gap-2 border border-[#cbc7bd] p-3" onSubmit={(event) => { event.preventDefault(); act({ action: "send_questionnaire", providerId, days }, "Questionnaire link created", (result) => setLink(String(result.link))); }}>
        <select aria-label="Questionnaire provider" value={providerId} onChange={(event) => setProviderId(event.target.value)} className={cn(select, "min-w-56")}><option value="">Choose a provider</option>{snapshot.providers.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select aria-label="Link validity" value={days} onChange={(event) => setDays(Number(event.target.value))} className={select}>{[7, 14, 30, 60].map((value) => <option key={value} value={value}>{value} days</option>)}</select>
        <Button type="submit" disabled={pending || !providerId} className="h-8 rounded-none bg-[#171713] text-[11px] text-white"><Send className="me-1.5 h-3 w-3" aria-hidden="true" />Create link</Button>
      </form>
      {link ? <div role="status" className="border border-[#245c3f] bg-[#dcebe1] p-4 text-[12px] text-[#173d2a]"><p className="font-semibold">Send this link to the vendor now. It is shown once; only a hash is kept.</p><div className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all bg-white px-2 py-1 font-mono text-[12px]">{link.startsWith("http") ? link : `${window.location.origin}${link}`}</code><Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(link.startsWith("http") ? link : `${window.location.origin}${link}`)} className="h-7 rounded-none border-[#245c3f] bg-transparent text-[11px] text-[#245c3f]"><Copy className="me-1 h-3 w-3" aria-hidden="true" />Copy</Button><Button type="button" variant="ghost" onClick={() => setLink(null)} className="h-7 rounded-none text-[11px]">Done</Button></div></div> : null}
      {message ? <p role="alert" className="text-[11px] text-[#9f2923]">{message}</p> : null}
      <div tabIndex={0} role="region" aria-label="Questionnaires table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[680px] text-left text-[11px]"><caption className="sr-only">Vendor questionnaires</caption>
        <thead><tr className="bg-[#e9e5db] font-mono text-[10px] uppercase tracking-wider text-[#5f5d56]">{["Provider", "Status", "Score", "Blocking", "Sent / expires", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
        <tbody>{snapshot.questionnaires.map((row) => (
          <Fragment key={row.id}>
            <tr className="border-t border-[#d8d4ca]"><td className="px-3 py-3 font-medium">{name(row.provider_id)}</td><td className="px-3 py-3"><span className={cn("px-1.5 py-0.5 font-mono text-[10px] uppercase", STATUS[row.status])}>{row.expired ? "expired" : row.status}</span></td><td className="px-3 py-3 font-mono">{row.score ?? "—"}</td><td className={cn("px-3 py-3 font-mono", row.critical_failures > 0 && "font-bold text-[#b8322a]")}>{row.score === null ? "—" : row.critical_failures}</td><td className="px-3 py-3 font-mono">{day(row.expires_at)}</td>
              <td className="px-3 py-3 text-end">{row.status === "sent" && !row.expired ? <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "revoke_questionnaire", id: row.id }, "Link revoked")} className="h-6 rounded-none border-[#b8322a] bg-transparent px-2 text-[10px] text-[#b8322a]">Revoke</Button> : row.score !== null ? <Button type="button" variant="ghost" aria-expanded={open === row.id} onClick={() => toggle(row.id)} className="h-6 rounded-none px-1 text-[10px]">Answers <ChevronDown className={cn("ms-0.5 h-2.5 w-2.5 transition-transform", open === row.id && "rotate-180")} aria-hidden="true" /></Button> : null}</td></tr>
            {open === row.id ? <tr className="bg-[#f1eee5]"><td colSpan={6} className="px-5 py-4">{detail ? <div className="max-w-3xl space-y-2">
              <p className="text-[12px]">Answered by {detail.respondent.name} ({detail.respondent.email}). Risk level <b className={LEVEL[detail.scored.level]}>{detail.scored.level}</b>, score {detail.scored.score}/100.</p>
              {detail.answers.filter((item) => item.answer !== "yes").map((item) => <p key={item.id} className={cn("border-s-2 ps-2 text-[11px]", item.critical && item.answer === "no" ? "border-[#b8322a]" : "border-[#a98a45]")}><span className="font-mono text-[10px] text-[#5f5d56]">{item.id} · {item.ucCode} · {item.answer}{item.critical ? " · blocking" : ""}</span><br />{item.text}{item.comment ? <span className="block text-[#55534b]">“{item.comment}”</span> : null}</p>)}
              {row.status === "submitted" ? <div className="space-y-2 pt-1"><Textarea aria-label="Review note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Review note (required)" className="min-h-14 rounded-none text-[12px] placeholder:text-[#63615a]" /><div className="flex gap-2"><Button type="button" disabled={pending || note.trim().length < 10} onClick={() => act({ action: "review_questionnaire", id: row.id, accept: true, note }, "Questionnaire accepted; blocking findings became tasks")} className="h-7 rounded-none bg-[#245c3f] text-[11px] text-white">Accept and open tasks</Button><Button type="button" variant="outline" disabled={pending || note.trim().length < 10} onClick={() => act({ action: "review_questionnaire", id: row.id, accept: false, note }, "Questionnaire rejected")} className="h-7 rounded-none border-[#b8322a] bg-transparent text-[11px] text-[#b8322a]">Reject</Button></div></div> : row.review_note ? <p className="text-[11px] text-[#55534b]">Review: {row.review_note}</p> : null}
            </div> : <p className="text-[11px]">Loading…</p>}</td></tr> : null}
          </Fragment>))}</tbody></table>
        {snapshot.questionnaires.length === 0 ? <p className="p-8 text-center text-[12px] text-[#5f5d56]">No questionnaires sent.</p> : null}
      </div>
    </div>
  );
}

function ExportPanel({ snapshot }: { snapshot: Snapshot }) {
  const errors = snapshot.issues.filter((issue) => issue.severity === "error");
  return (
    <div className="max-w-3xl space-y-3 text-[12px] text-[#34332e]">
      <p>Exports the providers, contractual arrangements, supply chain and assessment in the structure of the ITS templates for the register of information. It is an internal, validated working file, not the xBRL-CSV package a regulator portal expects: see docs/DORA_REGISTER.md for what is and is not covered.</p>
      {errors.length ? <div role="alert" className="border border-[#b8322a] bg-[#f5e5e1] p-3 text-[11px] text-[#9f2923]">Export is blocked until {errors.length} error(s) are fixed: {errors.slice(0, 4).map((issue) => `${issue.ref} ${issue.code}`).join(", ")}{errors.length > 4 ? "…" : ""}</div> : null}
      <div className="flex gap-2">{(["json", "csv"] as const).map((format) => errors.length ? <span key={format} className="inline-flex h-9 items-center border border-[#cbc7bd] px-4 text-[12px] text-[#63615a]">{format.toUpperCase()} unavailable</span> : <a key={format} href={`/api/third-party/export?format=${format}`} download className="inline-flex h-9 items-center border border-[#171713] px-4 text-[12px] font-semibold hover:bg-[#171713] hover:text-white"><Download className="me-2 h-3.5 w-3.5" aria-hidden="true" />Download {format.toUpperCase()}</a>)}</div>
    </div>
  );
}
