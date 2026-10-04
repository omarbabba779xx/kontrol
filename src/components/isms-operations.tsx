"use client";

import { useState } from "react";
import { MicroLabel } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type Person = { id: string; name: string; role: string };
export type Act = (body: Record<string, unknown>, success: string, after?: () => void) => void;
export type Incident = { id: string; ref: string; title: string; severity: string; status: "reported" | "contained" | "resolved" | "closed"; detected_at: string; personal_data: boolean; notification_due: string | null; notified_at: string | null; notificationOverdue: boolean; root_cause: string; lessons: string; nonconformity_id: string | null };
export type InternalAudit = { id: string; name: string; status: string; period_start?: string; period_end: string; closed_at: string | null; objectives?: string; criteria?: string; auditor_id?: string; controls?: string[]; conclusion?: string | null; findings?: number };
export type IsmsRecord = { id: string; kind: "change" | "competence" | "communication"; title: string; detail: Record<string, string>; status: string; owner_id: string | null; due_at: string | null; updated_at: string; overdue: boolean };

const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[10px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[10px] focus-visible:outline-2 focus-visible:outline-[#171713]";
const button = "h-8 rounded-none border-[#171713] bg-transparent text-[9px]";
const good = "bg-[#dcebe1] text-[#245c3f]", warn = "bg-[#f1e7cc] text-[#7a5a1a]", bad = "bg-[#f5e5e1] text-[#9f2923]";
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : "no date");
const toIso = (date: string) => new Date(`${date}T12:00:00Z`).toISOString();
const badge = (text: string, style: string) => <span className={cn("ms-1 px-1 font-mono text-[8px] uppercase", style)}>{text}</span>;
const people = (list: Person[]) => list.map((person) => <option key={person.id} value={person.id}>{person.name}</option>);

export function IncidentsTab({ incidents, act, pending }: { incidents: Incident[]; act: Act; pending: boolean }) {
  const [form, setForm] = useState({ title: "", severity: "medium", detectedAt: "", personalData: false });
  const [review, setReview] = useState<Record<string, { rootCause: string; lessons: string; reason: string; ncTitle: string }>>({});
  const of = (id: string) => review[id] ?? { rootCause: "", lessons: "", reason: "", ncTitle: "" };
  const set = (id: string, patch: Partial<ReturnType<typeof of>>) => setReview((current) => ({ ...current, [id]: { ...of(id), ...patch } }));
  return (
    <div className="space-y-4">
      <form className="grid gap-2 border border-[#cbc7bd] bg-[#f8f6f0] p-4 sm:grid-cols-2 lg:grid-cols-[1fr_120px_150px_auto_auto]" onSubmit={(event) => { event.preventDefault(); act({ action: "report_incident", title: form.title, severity: form.severity, detectedAt: toIso(form.detectedAt), personalData: form.personalData }, "Incident reported", () => setForm({ title: "", severity: "medium", detectedAt: "", personalData: false })); }}>
        <Input aria-label="Incident" required minLength={3} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="What happened" className={field} />
        <select aria-label="Incident severity" value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value })} className={select}>{["low", "medium", "high", "critical"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
        <Input aria-label="Detected on" type="date" required value={form.detectedAt} onChange={(event) => setForm({ ...form, detectedAt: event.target.value })} className={field} />
        <label className="flex items-center gap-1.5 text-[9px]"><input type="checkbox" checked={form.personalData} onChange={(event) => setForm({ ...form, personalData: event.target.checked })} />Personal data</label>
        <Button type="submit" variant="outline" disabled={pending} className={button}>Report</Button>
      </form>
      <p className="text-[9px] text-[#55534b]">An incident involving personal data starts the 72-hour notification clock from its detection. Closing an incident is its post-incident review: a high or critical one needs a nonconformity carrying the corrective action, or the reason none is needed.</p>
      <ul className="space-y-3">
        {incidents.map((item) => {
          const entry = of(item.id);
          const next = item.status === "reported" ? "contained" : item.status === "contained" ? "resolved" : null;
          return (
            <li key={item.id} className="border border-[#cbc7bd] p-3 text-[10px]">
              <p><span className="font-mono font-semibold">{item.ref}</span> {item.title}{badge(item.status, item.status === "closed" ? good : warn)}{badge(item.severity, item.severity === "high" || item.severity === "critical" ? bad : warn)}{item.notificationOverdue ? badge("notification overdue", bad) : null}</p>
              <p className="mt-1 text-[9px] text-[#55534b]">Detected {day(item.detected_at)}{item.personal_data ? ` · personal data · notify by ${day(item.notification_due)}${item.notified_at ? ` · notified ${day(item.notified_at)}` : ""}` : ""}{item.root_cause ? ` · cause: ${item.root_cause}` : ""}</p>
              {next ? <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "update_incident", id: item.id, status: next }, `Incident ${next}`)} className={cn(button, "mt-2")}>Mark {next}</Button> : null}
              {item.personal_data && !item.notified_at && item.status !== "closed" ? <Button type="button" variant="outline" disabled={pending} onClick={() => act({ action: "update_incident", id: item.id, notified: { at: new Date().toISOString(), note: "Notification decision recorded" } }, "Notification recorded")} className={cn(button, "ms-2 mt-2")}>Record notification</Button> : null}
              {item.status === "resolved" ? (
                <form className="mt-2 grid gap-2 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); act({ action: "close_incident", id: item.id, rootCause: entry.rootCause, lessons: entry.lessons, ...(entry.ncTitle ? { nonconformity: { severity: "minor", title: entry.ncTitle } } : { noNonconformityReason: entry.reason || undefined }) }, "Incident closed"); }}>
                  <Input aria-label={`Root cause of ${item.ref}`} required minLength={10} value={entry.rootCause} onChange={(event) => set(item.id, { rootCause: event.target.value })} placeholder="Root cause" className={field} />
                  <Input aria-label={`Lessons from ${item.ref}`} required minLength={10} value={entry.lessons} onChange={(event) => set(item.id, { lessons: event.target.value })} placeholder="What was learned" className={field} />
                  <Input aria-label={`Nonconformity for ${item.ref}`} value={entry.ncTitle} onChange={(event) => set(item.id, { ncTitle: event.target.value })} placeholder="Nonconformity to raise (optional)" className={field} />
                  <Input aria-label={`Reason no nonconformity for ${item.ref}`} value={entry.reason} onChange={(event) => set(item.id, { reason: event.target.value })} placeholder="Or why none is needed" className={field} />
                  <Button type="submit" variant="outline" disabled={pending} className={button}>Close with review</Button>
                </form>
              ) : null}
            </li>
          );
        })}
        {incidents.length === 0 ? <li className="border border-[#cbc7bd] p-3 text-[9px] text-[#63615a]">No incident recorded. Record minor ones and exercises too: a process that never ran is not shown to work.</li> : null}
      </ul>
    </div>
  );
}

export function AuditsTab({ audits, users, me, act, pending }: { audits: InternalAudit[]; users: Person[]; me: string; act: Act; pending: boolean }) {
  const [form, setForm] = useState({ name: "", objectives: "", criteria: "", auditorId: "", periodStart: "", periodEnd: "", controls: "" });
  const [finding, setFinding] = useState<Record<string, string>>({});
  const [conclusion, setConclusion] = useState<Record<string, string>>({});
  const codes = form.controls.split(/[\s,]+/).map((code) => code.trim().toUpperCase()).filter(Boolean);
  return (
    <div className="space-y-4">
      <form className="grid gap-2 border border-[#cbc7bd] bg-[#f8f6f0] p-4 sm:grid-cols-2 lg:grid-cols-3" onSubmit={(event) => { event.preventDefault(); act({ action: "plan_internal_audit", name: form.name, objectives: form.objectives, criteria: form.criteria, auditorId: form.auditorId, periodStart: toIso(form.periodStart), periodEnd: toIso(form.periodEnd), ucCodes: codes }, "Internal audit planned", () => setForm({ name: "", objectives: "", criteria: "", auditorId: "", periodStart: "", periodEnd: "", controls: "" })); }}>
        <Input aria-label="Audit name" required minLength={3} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Audit name" className={field} />
        <Input aria-label="Audit objectives" required minLength={10} value={form.objectives} onChange={(event) => setForm({ ...form, objectives: event.target.value })} placeholder="Objectives" className={field} />
        <Input aria-label="Audit criteria" required minLength={5} value={form.criteria} onChange={(event) => setForm({ ...form, criteria: event.target.value })} placeholder="Criteria (clauses, policies)" className={field} />
        <select aria-label="Auditor" required value={form.auditorId} onChange={(event) => setForm({ ...form, auditorId: event.target.value })} className={select}><option value="">Auditor…</option>{people(users)}</select>
        <Input aria-label="Audit start" type="date" required value={form.periodStart} onChange={(event) => setForm({ ...form, periodStart: event.target.value })} className={field} />
        <Input aria-label="Audit end" type="date" required value={form.periodEnd} onChange={(event) => setForm({ ...form, periodEnd: event.target.value })} className={field} />
        <Input aria-label="Controls in scope" value={form.controls} onChange={(event) => setForm({ ...form, controls: event.target.value })} placeholder="Controls in scope: UC-IAM-01, UC-TPM-01" className={cn(field, "font-mono sm:col-span-2")} />
        <Button type="submit" variant="outline" disabled={pending} className={button}>Plan audit</Button>
      </form>
      <p className="text-[9px] text-[#55534b]">An auditor does not audit controls they own. Only the auditor records findings and concludes; each finding becomes a nonconformity. One completed audit is not a programme: clause 9.2 is met when the next one is planned.</p>
      <ul className="space-y-3">
        {audits.map((item) => (
          <li key={item.id} className="border border-[#cbc7bd] p-3 text-[10px]">
            <p><span className="font-semibold">{item.name}</span>{badge(item.status, item.status === "closed" ? good : warn)}{typeof item.findings === "number" ? badge(`${item.findings} finding(s)`, item.findings ? warn : good) : null}</p>
            <p className="mt-1 text-[9px] text-[#55534b]">{day(item.period_start)} to {day(item.period_end)}{item.criteria ? ` · criteria: ${item.criteria}` : ""}{item.controls?.length ? ` · ${item.controls.join(", ")}` : ""}</p>
            {item.conclusion ? <p className="mt-1 text-[9px]">Conclusion: {item.conclusion}</p> : null}
            {item.status !== "closed" && item.auditor_id === me ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input aria-label={`Finding of ${item.name}`} value={finding[item.id] ?? ""} onChange={(event) => setFinding((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Finding" className={field} />
                <Button type="button" variant="outline" disabled={pending || (finding[item.id] ?? "").trim().length < 3} onClick={() => act({ action: "raise_audit_finding", auditId: item.id, severity: "minor", title: finding[item.id] }, "Finding recorded", () => setFinding((current) => ({ ...current, [item.id]: "" })))} className={button}>Record finding</Button>
                <Input aria-label={`Conclusion of ${item.name}`} value={conclusion[item.id] ?? ""} onChange={(event) => setConclusion((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Conclusion (20 characters minimum)" className={field} />
                <Button type="button" variant="outline" disabled={pending || (conclusion[item.id] ?? "").trim().length < 20} onClick={() => act({ action: "conclude_internal_audit", auditId: item.id, conclusion: conclusion[item.id] }, "Audit concluded")} className={button}>Conclude</Button>
              </div>
            ) : null}
          </li>
        ))}
        {audits.length === 0 ? <li className="border border-[#cbc7bd] p-3 text-[9px] text-[#63615a]">No internal audit planned.</li> : null}
      </ul>
    </div>
  );
}

const KIND_LABEL: Record<IsmsRecord["kind"], string> = { change: "Planned changes (6.3)", competence: "Competence (7.2)", communication: "Communication plan (7.4)" };

export function RecordsTab({ records, users, act, pending }: { records: IsmsRecord[]; users: Person[]; act: Act; pending: boolean }) {
  const [kind, setKind] = useState<IsmsRecord["kind"]>("change");
  const [form, setForm] = useState({ title: "", a: "", b: "", c: "", ownerId: "", dueAt: "", status: "", scope: "internal" });
  const labels = kind === "change" ? ["Purpose", "What it could affect", "Resources"] : kind === "competence" ? ["Competence needed", "Evidence it is met", "Action if there is a gap"] : ["To whom", "When", "How (channel)"];
  const detail = kind === "change" ? { purpose: form.a, consequences: form.b, resources: form.c } : kind === "competence" ? { competence: form.a, evidence: form.b, action: form.c } : { scope: form.scope, audience: form.a, timing: form.b, channel: form.c };
  const status = kind === "competence" ? (form.b.trim() ? "met" : "gap") : undefined;
  return (
    <div className="space-y-4">
      <form className="grid gap-2 border border-[#cbc7bd] bg-[#f8f6f0] p-4 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => { event.preventDefault(); act({ action: "save_record", kind, title: form.title, status, ownerId: form.ownerId || undefined, dueAt: form.dueAt ? toIso(form.dueAt) : undefined, detail }, "Recorded", () => setForm({ ...form, title: "", a: "", b: "", c: "" })); }}>
        <select aria-label="Record kind" value={kind} onChange={(event) => setKind(event.target.value as IsmsRecord["kind"])} className={select}>{(Object.keys(KIND_LABEL) as IsmsRecord["kind"][]).map((value) => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}</select>
        <Input aria-label="Record title" required minLength={3} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder={kind === "competence" ? "Role" : kind === "change" ? "The change" : "What is communicated"} className={field} />
        {kind === "communication" ? <select aria-label="Audience scope" value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })} className={select}><option value="internal">internal</option><option value="external">external</option></select> : null}
        <Input aria-label={labels[0]} required value={form.a} onChange={(event) => setForm({ ...form, a: event.target.value })} placeholder={labels[0]} className={field} />
        <Input aria-label={labels[1]} required={kind !== "competence"} value={form.b} onChange={(event) => setForm({ ...form, b: event.target.value })} placeholder={labels[1]} className={field} />
        <Input aria-label={labels[2]} required={kind === "communication"} value={form.c} onChange={(event) => setForm({ ...form, c: event.target.value })} placeholder={labels[2]} className={field} />
        <select aria-label="Record owner" required={kind !== "competence"} value={form.ownerId} onChange={(event) => setForm({ ...form, ownerId: event.target.value })} className={select}><option value="">{kind === "communication" ? "Who communicates…" : "Responsible…"}</option>{people(users)}</select>
        {kind === "change" ? <Input aria-label="Planned for" type="date" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} className={field} /> : null}
        <Button type="submit" variant="outline" disabled={pending} className={button}>Record</Button>
      </form>
      {(Object.keys(KIND_LABEL) as IsmsRecord["kind"][]).map((value) => (
        <div key={value}>
          <MicroLabel>{KIND_LABEL[value]}</MicroLabel>
          <ul className="mt-2 divide-y divide-[#d8d4ca] border border-[#cbc7bd]">
            {records.filter((record) => record.kind === value).map((record) => (
              <li key={record.id} className="p-3 text-[10px]">
                <span className="font-semibold">{record.title}</span>{badge(record.overdue ? "overdue" : record.status, record.overdue || record.status === "gap" ? bad : record.status === "planned" ? warn : good)}
                <span className="block text-[9px] text-[#55534b]">{Object.entries(record.detail).filter(([, text]) => text).map(([key, text]) => `${key}: ${text}`).join(" · ")}{record.due_at ? ` · ${day(record.due_at)}` : ""}</span>
                {record.kind === "change" && record.status === "planned" ? <Button type="button" variant="ghost" disabled={pending} onClick={() => act({ action: "save_record", id: record.id, kind: "change", title: record.title, status: "done", ownerId: record.owner_id, detail: record.detail }, "Change marked done")} className="mt-1 h-6 rounded-none text-[8px]">Mark done</Button> : null}
              </li>
            ))}
            {records.every((record) => record.kind !== value) ? <li className="p-3 text-[9px] text-[#63615a]">Nothing recorded.</li> : null}
          </ul>
        </div>
      ))}
    </div>
  );
}
