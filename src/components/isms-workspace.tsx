"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";
import { AuditsTab, IncidentsTab, RecordsTab, type Incident, type InternalAudit, type IsmsRecord } from "@/components/isms-operations";

type ClauseStatus = "met" | "partial" | "missing";
type Clause = { clause: string; title: string; status: ClauseStatus; detail: string; next: string | null };
type ContextItem = { id: string; kind: "internal_issue" | "external_issue" | "interested_party"; title: string; detail: string; requirement: string; updated_at: string };
type Objective = { id: string; title: string; measure: string; target: string; current_value: string; owner_id: string | null; due_at: string; status: string; measured_at: string | null; overdue: boolean };
type Review = { id: string; held_at: string; attendees: string; decisions: string; status: "draft" | "approved"; approved_at: string | null; inputs: { risk?: { open: number; aboveAppetite: number; untreated: number }; nonconformities?: { open: number; majorOpen: number }; previousReview?: { actions: number; actionsDone: number } | null } };
type Nonconformity = { id: string; ref: string; source: string; severity: string; title: string; requirement: string; root_cause: string; corrective_action: string; owner_id: string | null; due_at: string | null; status: "open" | "action_planned" | "implemented" | "closed"; effectiveness_note: string | null; overdue: boolean };
type Snapshot = {
  clauses: Clause[];
  summary: { met: number; partial: number; missing: number; total: number; next: string[] };
  context: ContextItem[];
  scope: { statement: string; boundaries: string; exclusions: string; version: number; approved_at: string } | null;
  objectives: Objective[];
  reviews: Review[];
  nonconformities: Nonconformity[];
  internalAudits: InternalAudit[];
  incidents: Incident[];
  records: IsmsRecord[];
};
type Person = { id: string; name: string; role: string };

const STATUS_STYLE: Record<ClauseStatus, string> = { met: "bg-[#dcebe1] text-[#245c3f]", partial: "bg-[#f1e7cc] text-[#7a5a1a]", missing: "bg-[#f5e5e1] text-[#9f2923]" };
const KIND_LABEL: Record<ContextItem["kind"], string> = { internal_issue: "Internal issue", external_issue: "External issue", interested_party: "Interested party" };
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[12px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[12px] focus-visible:outline-2 focus-visible:outline-[#171713]";
const area = "min-h-16 rounded-none border-[#cbc7bd] bg-transparent text-[12px] shadow-none placeholder:text-[#63615a]";
const button = "h-8 rounded-none border-[#171713] bg-transparent text-[11px]";
const tabs = ["Clauses", "Context", "Scope", "Objectives", "Records", "Incidents", "Internal audits", "Reviews", "Nonconformities"] as const;
type Tab = (typeof tabs)[number];
const day = (value: string | null) => (value ? value.slice(0, 10) : "no date");
const toIso = (date: string) => new Date(`${date}T12:00:00Z`).toISOString();

export function IsmsWorkspace() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [me, setMe] = useState("");
  const [tab, setTab] = useState<Tab>("Clauses");
  const [status, setStatus] = useState("Loading…");
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [context, setContext] = useState({ kind: "internal_issue" as ContextItem["kind"], title: "", detail: "", requirement: "" });
  const [scope, setScope] = useState({ statement: "", boundaries: "", exclusions: "" });
  const [objective, setObjective] = useState({ title: "", measure: "", target: "", ownerId: "", dueAt: "" });
  const [measure, setMeasure] = useState<Record<string, { value: string; status: string }>>({});
  const [review, setReview] = useState({ heldAt: "", attendees: "" });
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [nc, setNc] = useState({ source: "internal_audit", severity: "minor", title: "", requirement: "" });
  const [plan, setPlan] = useState<Record<string, { rootCause: string; correctiveAction: string; ownerId: string; dueAt: string; note: string }>>({});

  const load = useCallback(
    (signal?: AbortSignal) =>
      Promise.all([fetchJson<Snapshot>("/api/isms", { signal }), fetchJson<{ users: Person[]; me?: string }>("/api/users", { signal })]).then(([snapshot, users]) => {
        setData(snapshot);
        setPeople(users.users);
        setMe(users.me ?? "");
        if (snapshot.scope) setScope((current) => (current.statement ? current : { statement: snapshot.scope!.statement, boundaries: snapshot.scope!.boundaries, exclusions: snapshot.scope!.exclusions }));
      }),
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then(() => setStatus("Up to date"))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setFailed(true);
          setStatus(errorMessage(error, "ISMS unavailable"));
        }
      });
    return () => controller.abort();
  }, [load]);

  function act(body: Record<string, unknown>, success: string, after?: () => void) {
    startTransition(async () => {
      try {
        setStatus("Saving…");
        await fetchJson("/api/isms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch (error) {
        setStatus(errorMessage(error, "Action failed"));
        return;
      }
      try {
        await load();
        setStatus(success);
        after?.();
      } catch (error) {
        setStatus(`Done, but refresh failed: ${errorMessage(error, "unknown error")}`);
      }
    });
  }

  const planOf = (id: string) => plan[id] ?? { rootCause: "", correctiveAction: "", ownerId: "", dueAt: "", note: "" };
  const setPlanField = (id: string, patch: Partial<ReturnType<typeof planOf>>) => setPlan((current) => ({ ...current, [id]: { ...planOf(id), ...patch } }));
  const owners = <option value="">Owner…</option>;

  return (
    <div>
      <PageHeading index="19" title="ISMS" description="The management system itself: context, scope, objectives, management review and corrective action, checked clause by clause against ISO/IEC 27001." meta={status} />
      <section className="p-5 sm:p-7 lg:p-9" aria-busy={data === null && !failed}>
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[11px] text-[#9f2923]">{status}</div> : null}
        {data ? (
          <>
            <div className="mb-6 grid grid-cols-3 border border-[#cbc7bd]">
              {[["Met", data.summary.met], ["Partly met", data.summary.partial], ["Missing", data.summary.missing]].map(([label, value]) => (
                <div key={label} className="border-e border-[#cbc7bd] p-4 last:border-e-0">
                  <MicroLabel>{label}</MicroLabel>
                  <p className="mt-2 text-2xl font-semibold tracking-tight">{value}<span className="text-xs font-normal text-[#63615a]"> / {data.summary.total}</span></p>
                </div>
              ))}
            </div>
            <div role="tablist" aria-label="ISMS sections" className="mb-5 flex flex-wrap gap-1">
              {tabs.map((name) => (
                <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)} className={cn("border px-3 py-1.5 text-[11px] font-semibold", tab === name ? "border-[#171713] bg-[#171713] text-white" : "border-[#cbc7bd] hover:border-[#171713]")}>
                  {name}
                </button>
              ))}
            </div>

            {tab === "Clauses" ? (
              <div className="overflow-x-auto border border-[#cbc7bd]">
                <table className="w-full min-w-[720px] text-left text-[12px]">
                  <caption className="sr-only">ISO/IEC 27001 clauses 4 to 10</caption>
                  <thead><tr className="bg-[#e9e5db] font-mono text-[10px] uppercase tracking-wider text-[#55534b]"><th className="px-3 py-2">Clause</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">What the records show</th><th className="px-3 py-2">Next step</th></tr></thead>
                  <tbody>
                    {data.clauses.map((item) => (
                      <tr key={item.clause} className="border-t border-[#d8d4ca] align-top">
                        <td className="px-3 py-3"><span className="font-mono font-semibold">{item.clause}</span><span className="block text-[11px] text-[#55534b]">{item.title}</span></td>
                        <td className="px-3 py-3"><span className={cn("px-1.5 py-0.5 font-mono text-[10px] uppercase", STATUS_STYLE[item.status])}>{item.status}</span></td>
                        <td className="px-3 py-3">{item.detail}</td>
                        <td className="px-3 py-3 text-[#55534b]">{item.next ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {tab === "Context" ? (
              <div className="space-y-4">
                <form className="grid grid-cols-1 gap-2 border border-[#cbc7bd] bg-[#f8f6f0] p-4 sm:grid-cols-[160px_1fr_1fr_auto]" onSubmit={(event) => { event.preventDefault(); act({ action: "save_context", ...context, requirement: context.requirement || undefined }, "Recorded", () => setContext({ ...context, title: "", detail: "", requirement: "" })); }}>
                  <select aria-label="Kind" value={context.kind} onChange={(event) => setContext({ ...context, kind: event.target.value as ContextItem["kind"] })} className={select}>{Object.entries(KIND_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                  <Input aria-label="Title" required minLength={3} value={context.title} onChange={(event) => setContext({ ...context, title: event.target.value })} placeholder={context.kind === "interested_party" ? "Who (customers, regulator, staff…)" : "The issue"} className={field} />
                  <Input aria-label={context.kind === "interested_party" ? "Requirement" : "Detail"} required={context.kind === "interested_party"} value={context.kind === "interested_party" ? context.requirement : context.detail} onChange={(event) => setContext(context.kind === "interested_party" ? { ...context, requirement: event.target.value } : { ...context, detail: event.target.value })} placeholder={context.kind === "interested_party" ? "What they require" : "Why it matters to security"} className={field} />
                  <Button type="submit" variant="outline" disabled={isPending} className={button}>Add</Button>
                </form>
                {(["internal_issue", "external_issue", "interested_party"] as const).map((kind) => (
                  <div key={kind}>
                    <MicroLabel>{KIND_LABEL[kind]}s</MicroLabel>
                    <ul className="mt-2 divide-y divide-[#d8d4ca] border border-[#cbc7bd]">
                      {data.context.filter((item) => item.kind === kind).map((item) => (
                        <li key={item.id} className="flex items-start justify-between gap-3 p-3 text-[12px]">
                          <span><span className="font-semibold">{item.title}</span><span className="block text-[11px] text-[#55534b]">{item.requirement || item.detail || "—"} · reviewed {day(item.updated_at)}</span></span>
                          <span className="flex gap-1">
                            <Button type="button" variant="ghost" disabled={isPending} onClick={() => act({ action: "save_context", id: item.id, kind: item.kind, title: item.title, detail: item.detail, requirement: item.requirement || undefined }, "Marked as reviewed")} className="h-6 rounded-none text-[10px]">Still current</Button>
                            <Button type="button" variant="ghost" disabled={isPending} onClick={() => act({ action: "remove_context", id: item.id }, "Removed")} className="h-6 rounded-none text-[10px] text-[#9f2923]">Remove</Button>
                          </span>
                        </li>
                      ))}
                      {data.context.every((item) => item.kind !== kind) ? <li className="p-3 text-[11px] text-[#63615a]">Nothing recorded.</li> : null}
                    </ul>
                  </div>
                ))}
              </div>
            ) : null}

            {tab === "Scope" ? (
              <form className="space-y-3 border border-[#cbc7bd] bg-[#f8f6f0] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "approve_scope", ...scope }, "Scope approved"); }}>
                <p className="text-[11px] text-[#55534b]">{data.scope ? `Version ${data.scope.version}, approved on ${day(data.scope.approved_at)}. Approving again creates a new version.` : "No scope is approved yet."} Approval is a management decision: it needs an administrator.</p>
                <label className="block text-[11px] font-semibold">Scope statement<Textarea required minLength={20} value={scope.statement} onChange={(event) => setScope({ ...scope, statement: event.target.value })} className={cn(area, "mt-1 min-h-24")} /></label>
                <label className="block text-[11px] font-semibold">Boundaries and interfaces<Textarea value={scope.boundaries} onChange={(event) => setScope({ ...scope, boundaries: event.target.value })} className={cn(area, "mt-1")} /></label>
                <label className="block text-[11px] font-semibold">Exclusions and their justification<Textarea value={scope.exclusions} onChange={(event) => setScope({ ...scope, exclusions: event.target.value })} className={cn(area, "mt-1")} /></label>
                <Button type="submit" variant="outline" disabled={isPending} className={button}>Approve scope</Button>
              </form>
            ) : null}

            {tab === "Objectives" ? (
              <div className="space-y-4">
                <form className="grid grid-cols-1 gap-2 border border-[#cbc7bd] bg-[#f8f6f0] p-4 sm:grid-cols-2 lg:grid-cols-[1.2fr_1.2fr_0.8fr_0.8fr_0.7fr_auto]" onSubmit={(event) => { event.preventDefault(); act({ action: "save_objective", title: objective.title, measure: objective.measure, target: objective.target, ownerId: objective.ownerId || undefined, dueAt: toIso(objective.dueAt) }, "Objective set", () => setObjective({ title: "", measure: "", target: "", ownerId: "", dueAt: "" })); }}>
                  <Input aria-label="Objective" required minLength={3} value={objective.title} onChange={(event) => setObjective({ ...objective, title: event.target.value })} placeholder="Objective" className={field} />
                  <Input aria-label="Measure" required minLength={3} value={objective.measure} onChange={(event) => setObjective({ ...objective, measure: event.target.value })} placeholder="How it is measured" className={field} />
                  <Input aria-label="Target" required value={objective.target} onChange={(event) => setObjective({ ...objective, target: event.target.value })} placeholder="Target" className={field} />
                  <select aria-label="Owner" value={objective.ownerId} onChange={(event) => setObjective({ ...objective, ownerId: event.target.value })} className={select}>{owners}{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
                  <Input aria-label="Due date" type="date" required value={objective.dueAt} onChange={(event) => setObjective({ ...objective, dueAt: event.target.value })} className={field} />
                  <Button type="submit" variant="outline" disabled={isPending} className={button}>Set</Button>
                </form>
                <ul className="divide-y divide-[#d8d4ca] border border-[#cbc7bd]">
                  {data.objectives.map((item) => {
                    const entry = measure[item.id] ?? { value: "", status: "on_track" };
                    return (
                      <li key={item.id} className="grid grid-cols-1 gap-2 p-3 text-[12px] lg:grid-cols-[1fr_auto]">
                        <span>
                          <span className="font-semibold">{item.title}</span> <span className={cn("ms-1 px-1 font-mono text-[10px] uppercase", item.overdue ? STATUS_STYLE.missing : item.status === "achieved" ? STATUS_STYLE.met : STATUS_STYLE.partial)}>{item.overdue ? "overdue" : item.status.replace("_", " ")}</span>
                          <span className="block text-[11px] text-[#55534b]">{item.measure} · target {item.target} · latest {item.current_value || "not measured"}{item.measured_at ? ` (${day(item.measured_at)})` : ""} · due {day(item.due_at)}</span>
                        </span>
                        <form className="flex flex-wrap items-center gap-1" onSubmit={(event) => { event.preventDefault(); act({ action: "measure_objective", id: item.id, value: entry.value, status: entry.status }, "Measurement recorded", () => setMeasure((current) => ({ ...current, [item.id]: { value: "", status: "on_track" } }))); }}>
                          <Input aria-label={`Measured value for ${item.title}`} required value={entry.value} onChange={(event) => setMeasure((current) => ({ ...current, [item.id]: { ...entry, value: event.target.value } }))} placeholder="Measured value" className={cn(field, "w-32")} />
                          <select aria-label="Standing" value={entry.status} onChange={(event) => setMeasure((current) => ({ ...current, [item.id]: { ...entry, status: event.target.value } }))} className={select}>{["on_track", "at_risk", "achieved", "missed"].map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select>
                          <Button type="submit" variant="outline" disabled={isPending} className={button}>Record</Button>
                        </form>
                      </li>
                    );
                  })}
                  {data.objectives.length === 0 ? <li className="p-3 text-[11px] text-[#63615a]">No objective yet.</li> : null}
                </ul>
              </div>
            ) : null}

            {tab === "Reviews" ? (
              <div className="space-y-4">
                <form className="grid grid-cols-1 gap-2 border border-[#cbc7bd] bg-[#f8f6f0] p-4 sm:grid-cols-[160px_1fr_auto]" onSubmit={(event) => { event.preventDefault(); act({ action: "prepare_review", heldAt: toIso(review.heldAt), attendees: review.attendees }, "Review prepared with today's inputs", () => setReview({ heldAt: "", attendees: "" })); }}>
                  <Input aria-label="Review date" type="date" required value={review.heldAt} onChange={(event) => setReview({ ...review, heldAt: event.target.value })} className={field} />
                  <Input aria-label="Attendees" required minLength={3} value={review.attendees} onChange={(event) => setReview({ ...review, attendees: event.target.value })} placeholder="Attendees" className={field} />
                  <Button type="submit" variant="outline" disabled={isPending} className={button}>Prepare review</Button>
                </form>
                <p className="text-[11px] text-[#55534b]">Preparing a review freezes the inputs clause 9.3 asks for (risks, nonconformities, audit results, objectives, monitoring) as they stand now. Internal audits are planned in the audit workspace: {data.internalAudits.length} on record.</p>
                <ul className="space-y-3">
                  {data.reviews.map((item) => (
                    <li key={item.id} className="border border-[#cbc7bd] p-3 text-[12px]">
                      <p><span className="font-semibold">Review of {day(item.held_at)}</span> <span className={cn("ms-1 px-1 font-mono text-[10px] uppercase", item.status === "approved" ? STATUS_STYLE.met : STATUS_STYLE.partial)}>{item.status}</span></p>
                      <p className="mt-1 text-[11px] text-[#55534b]">Attendees: {item.attendees}. Inputs at the time: {item.inputs.risk?.open ?? 0} open risk(s), {item.inputs.risk?.aboveAppetite ?? 0} above appetite, {item.inputs.nonconformities?.open ?? 0} open nonconformity(ies){item.inputs.previousReview ? `, ${item.inputs.previousReview.actionsDone} of ${item.inputs.previousReview.actions} earlier action(s) done` : ""}.</p>
                      {item.status === "approved" ? <p className="mt-2 whitespace-pre-wrap">{item.decisions}</p> : (
                        <form className="mt-2 space-y-2" onSubmit={(event) => { event.preventDefault(); act({ action: "approve_review", id: item.id, decisions: decisions[item.id] ?? "" }, "Review approved"); }}>
                          <Textarea aria-label="Decisions" required minLength={20} value={decisions[item.id] ?? ""} onChange={(event) => setDecisions((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Decisions and actions (administrator)" className={area} />
                          <Button type="submit" variant="outline" disabled={isPending} className={button}>Approve</Button>
                        </form>
                      )}
                    </li>
                  ))}
                  {data.reviews.length === 0 ? <li className="border border-[#cbc7bd] p-3 text-[11px] text-[#63615a]">No management review yet.</li> : null}
                </ul>
              </div>
            ) : null}

            {tab === "Records" ? <RecordsTab records={data.records} users={people} act={act} pending={isPending} /> : null}
            {tab === "Incidents" ? <IncidentsTab incidents={data.incidents} act={act} pending={isPending} /> : null}
            {tab === "Internal audits" ? <AuditsTab audits={data.internalAudits} users={people} me={me} act={act} pending={isPending} /> : null}

            {tab === "Nonconformities" ? (
              <div className="space-y-4">
                <form className="grid grid-cols-1 gap-2 border border-[#cbc7bd] bg-[#f8f6f0] p-4 sm:grid-cols-2 lg:grid-cols-[150px_120px_1fr_180px_auto]" onSubmit={(event) => { event.preventDefault(); act({ action: "raise_nonconformity", source: nc.source, severity: nc.severity, title: nc.title, requirement: nc.requirement || undefined }, "Nonconformity raised", () => setNc({ ...nc, title: "", requirement: "" })); }}>
                  <select aria-label="Source" value={nc.source} onChange={(event) => setNc({ ...nc, source: event.target.value })} className={select}>{["internal_audit", "external_audit", "incident", "monitoring", "management_review", "other"].map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select>
                  <select aria-label="Severity" value={nc.severity} onChange={(event) => setNc({ ...nc, severity: event.target.value })} className={select}>{["major", "minor", "observation"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
                  <Input aria-label="Finding" required minLength={3} value={nc.title} onChange={(event) => setNc({ ...nc, title: event.target.value })} placeholder="What was found" className={field} />
                  <Input aria-label="Requirement" value={nc.requirement} onChange={(event) => setNc({ ...nc, requirement: event.target.value })} placeholder="Requirement (e.g. A5.18)" className={field} />
                  <Button type="submit" variant="outline" disabled={isPending} className={button}>Raise</Button>
                </form>
                <ul className="space-y-3">
                  {data.nonconformities.map((item) => {
                    const entry = planOf(item.id);
                    return (
                      <li key={item.id} className="border border-[#cbc7bd] p-3 text-[12px]">
                        <p><span className="font-mono font-semibold">{item.ref}</span> {item.title} <span className={cn("ms-1 px-1 font-mono text-[10px] uppercase", item.status === "closed" ? STATUS_STYLE.met : item.overdue ? STATUS_STYLE.missing : STATUS_STYLE.partial)}>{item.overdue ? "overdue" : item.status.replace("_", " ")}</span></p>
                        <p className="mt-1 text-[11px] text-[#55534b]">{item.severity} · {item.source.replace("_", " ")}{item.requirement ? ` · ${item.requirement}` : ""}{item.due_at ? ` · due ${day(item.due_at)}` : ""}</p>
                        {item.root_cause ? <p className="mt-1 text-[11px]">Cause: {item.root_cause}. Action: {item.corrective_action}.</p> : null}
                        {item.effectiveness_note ? <p className="mt-1 text-[11px] text-[#55534b]">Effectiveness review: {item.effectiveness_note}</p> : null}
                        {item.status === "open" ? (
                          <form className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_140px_140px_auto]" onSubmit={(event) => { event.preventDefault(); act({ action: "plan_corrective_action", id: item.id, rootCause: entry.rootCause, correctiveAction: entry.correctiveAction, ownerId: entry.ownerId, dueAt: toIso(entry.dueAt) }, "Corrective action planned"); }}>
                            <Input aria-label="Root cause" required minLength={10} value={entry.rootCause} onChange={(event) => setPlanField(item.id, { rootCause: event.target.value })} placeholder="Root cause" className={field} />
                            <Input aria-label="Corrective action" required minLength={10} value={entry.correctiveAction} onChange={(event) => setPlanField(item.id, { correctiveAction: event.target.value })} placeholder="Action that removes the cause" className={field} />
                            <select aria-label="Action owner" required value={entry.ownerId} onChange={(event) => setPlanField(item.id, { ownerId: event.target.value })} className={select}>{owners}{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
                            <Input aria-label="Action due date" type="date" required value={entry.dueAt} onChange={(event) => setPlanField(item.id, { dueAt: event.target.value })} className={field} />
                            <Button type="submit" variant="outline" disabled={isPending} className={button}>Plan</Button>
                          </form>
                        ) : null}
                        {item.status === "action_planned" || item.status === "implemented" ? (
                          <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => event.preventDefault()}>
                            <Input aria-label="Note" minLength={10} value={entry.note} onChange={(event) => setPlanField(item.id, { note: event.target.value })} placeholder={item.status === "action_planned" ? "What was done" : "What you checked (a second person)"} className={cn(field, "w-72")} />
                            {item.status === "action_planned" ? <Button type="button" variant="outline" disabled={isPending || entry.note.trim().length < 10} onClick={() => act({ action: "mark_implemented", id: item.id, note: entry.note }, "Marked implemented", () => setPlanField(item.id, { note: "" }))} className={button}>Implemented</Button> : (
                              <>
                                <Button type="button" variant="outline" disabled={isPending || entry.note.trim().length < 10} onClick={() => act({ action: "verify_and_close", id: item.id, effective: true, note: entry.note }, "Closed as effective")} className={button}>Effective: close</Button>
                                <Button type="button" variant="ghost" disabled={isPending || entry.note.trim().length < 10} onClick={() => act({ action: "verify_and_close", id: item.id, effective: false, note: entry.note }, "Reopened")} className="h-8 rounded-none text-[11px] text-[#9f2923]">Not effective: reopen</Button>
                              </>
                            )}
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                  {data.nonconformities.length === 0 ? <li className="border border-[#cbc7bd] p-3 text-[11px] text-[#63615a]">No nonconformity recorded.</li> : null}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
