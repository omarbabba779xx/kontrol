"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CircleAlert, CircleCheck, Scale } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";
import { cn } from "@/lib/utils";

/**
 * The decision room reads the organisation's own records and answers two questions: where does it stand today, and what is
 * waiting for someone to decide. It shows nothing that is not in those records; an organisation that has recorded nothing
 * sees the first steps to take.
 */
type Clause = { clause: string; title: string; status: "met" | "partial" | "missing"; detail: string; next: string | null };
type Isms = {
  clauses: Clause[];
  summary: { met: number; partial: number; missing: number; total: number };
  nonconformities: Array<{ id: string; ref: string; title: string; status: string; due_at: string | null }>;
  reviews: Array<{ id: string; status: string; held_at: string }>;
  objectives: Array<{ id: string; title: string; target: string; current_value: string | null; status: string; overdue?: boolean }>;
};
type Rating = { score: number; band: string; level: { label: string } | null };
type Risk = { id: string; ref: string; title: string; treatment: string; status: string; effectiveStatus: string; accepted_until: string | null; aboveAppetite: boolean; acceptanceExpired: boolean; residual: Rating };
type Register = { risks: Risk[]; summary: { open: number; aboveAppetite: number; untreated: number; acceptanceExpired: number } };
type Compliance = {
  overall: { score: number; readiness: string; frameworks: number };
  alerts: { contradictions: Array<{ code: string; title: string; attested: string }>; expiredAttestations: unknown[]; pendingEvidence: number; pendingExceptions: number; overduePolicies: number };
};
type Tasks = { tasks: Array<{ status: string; overdue: boolean }> };
type Data = { isms: Isms; register: Register; compliance: Compliance; tasks: Tasks };
type Waiting = { key: string; text: string; detail: string; href: string; urgent: boolean };

const day = (value: string) => value.slice(0, 10);
const SOON = 30 * 86_400_000;

/** Everything in the records that cannot move without a person deciding, most pressing first. */
function waitingFor(data: Data, now: number): Waiting[] {
  const items: Waiting[] = [];
  for (const risk of data.register.risks) {
    if (risk.status === "closed") continue;
    if (risk.acceptanceExpired) items.push({ key: `lapsed-${risk.id}`, text: `${risk.ref}: the acceptance has lapsed`, detail: `${risk.title}. Accept it again, or treat it.`, href: "/risk-register", urgent: true });
    else if (risk.treatment === "undecided" && risk.status !== "accepted") items.push({ key: `undecided-${risk.id}`, text: `${risk.ref}: no treatment decided`, detail: `${risk.title}${risk.aboveAppetite ? ". Above the risk appetite." : "."}`, href: "/risk-register", urgent: risk.aboveAppetite });
    else if (risk.status === "accepted" && risk.accepted_until && Date.parse(risk.accepted_until) - now < SOON) items.push({ key: `expiring-${risk.id}`, text: `${risk.ref}: the acceptance ends on ${day(risk.accepted_until)}`, detail: risk.title, href: "/risk-register", urgent: false });
  }
  for (const item of data.isms.nonconformities) {
    if (item.status === "implemented") items.push({ key: `verify-${item.id}`, text: `${item.ref}: the corrective action awaits its effectiveness review`, detail: `${item.title}. Someone other than its owner verifies it.`, href: "/isms", urgent: false });
    else if (item.status === "open") items.push({ key: `plan-${item.id}`, text: `${item.ref}: no corrective action planned`, detail: item.title, href: "/isms", urgent: true });
  }
  for (const review of data.isms.reviews) {
    if (review.status !== "approved") items.push({ key: `review-${review.id}`, text: `The management review of ${day(review.held_at)} is not approved`, detail: "An administrator records the decisions and approves it.", href: "/isms", urgent: false });
  }
  const { alerts } = data.compliance;
  for (const item of alerts.contradictions) items.push({ key: `contradiction-${item.code}`, text: `${item.code}: the evidence contradicts the claim`, detail: `${item.title} is attested as ${item.attested.replace("_", " ")} while its collected evidence fails.`, href: "/compliance", urgent: true });
  if (alerts.pendingExceptions > 0) items.push({ key: "exceptions", text: `${alerts.pendingExceptions} exception request(s) await a decision`, detail: "The requester cannot decide their own request.", href: "/compliance", urgent: false });
  if (alerts.pendingEvidence > 0) items.push({ key: "evidence", text: `${alerts.pendingEvidence} document(s) await review`, detail: "A document backs a control once a second person accepts it.", href: "/compliance", urgent: false });
  if (alerts.expiredAttestations.length > 0) items.push({ key: "attestations", text: `${alerts.expiredAttestations.length} control claim(s) are past their review date`, detail: "The owner confirms the claim again, or changes it.", href: "/compliance", urgent: false });
  if (alerts.overduePolicies > 0) items.push({ key: "policies", text: `${alerts.overduePolicies} policy document(s) are past their review date`, detail: "The policy owner reviews and re-approves them.", href: "/compliance", urgent: false });
  return items.sort((a, b) => Number(b.urgent) - Number(a.urgent));
}

function Stat({ label, value, note, href, urgent }: { label: string; value: string; note: string; href: string; urgent?: boolean }) {
  return (
    <Link href={href} className="group block min-h-[112px] border-e border-b border-[#cbc7bd] px-5 py-4 last:border-e-0 hover:bg-[#ece8de] sm:px-6">
      <span className="flex items-center justify-between"><MicroLabel>{label}</MicroLabel><ArrowUpRight aria-hidden="true" className="h-3 w-3 text-[#8c8981] transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></span>
      <span className={cn("mt-3 block text-[22px] font-medium tracking-[-.04em]", urgent ? "text-[#b8322a]" : "text-[#171713]")}>{value}</span>
      <span className="mt-1 block font-mono text-[10px] uppercase tracking-wider text-[#6f6c64]">{note}</span>
    </Link>
  );
}

const BAND: Record<string, string> = { critical: "border-[#b8322a] text-[#9f2923]", high: "border-[#e4582f] text-[#a63b1c]", medium: "border-[#a8853a] text-[#7a5a1a]", low: "border-[#2d6a4f] text-[#2d6a4f]" };

export function OverviewDashboard() {
  const [data, setData] = useState<Data | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    const get = <T,>(url: string) => fetchJson<T>(url, { signal: controller.signal });
    Promise.all([get<Isms>("/api/isms"), get<Register>("/api/risk-register"), get<Compliance>("/api/compliance"), get<Tasks>("/api/tasks")])
      .then(([isms, register, compliance, tasks]) => setData({ isms, register, compliance, tasks }))
      .catch((error: unknown) => { if (!isAbort(error)) setFailure(errorMessage(error, "The records could not be read")); });
    return () => controller.abort();
  }, []);

  const heading = (meta: string) => <PageHeading index="01" title="Decision room" description="Where the organisation stands today, read from its own records, and what is waiting for someone to decide." meta={meta} />;
  if (failure) return <div>{heading("Unavailable")}<p role="alert" className="px-5 py-8 text-[13px] text-[#9f2923] sm:px-7 lg:px-9">{failure}</p></div>;
  if (!data) return <div>{heading("Reading the records…")}<p className="px-5 py-8 text-[13px] text-[#6f6c64] sm:px-7 lg:px-9">Reading the records…</p></div>;

  const { isms, register, compliance, tasks } = data;
  const waiting = waitingFor(data, now);
  const open = register.risks.filter((risk) => risk.status !== "closed");
  const worst = [...open].sort((a, b) => b.residual.score - a.residual.score).slice(0, 6);
  const unmet = isms.clauses.filter((clause) => clause.status !== "met");
  const openTasks = tasks.tasks.filter((task) => task.status === "open");
  const overdueTasks = openTasks.filter((task) => task.overdue).length;
  const offTrack = isms.objectives.filter((objective) => objective.status === "at_risk" || objective.status === "missed" || objective.overdue);
  const started = isms.summary.met > 1 || open.length > 0 || compliance.overall.frameworks > 0;

  return (
    <div>
      {heading(waiting.length ? `${waiting.length} waiting for a decision` : "Nothing waiting")}

      <section className="grid grid-cols-1 border-b border-[#cbc7bd] sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Management system" value={`${isms.summary.met} / ${isms.summary.total} clauses met`} note={`${isms.summary.partial} partial · ${isms.summary.missing} missing`} href="/isms" urgent={isms.summary.missing > 0} />
        <Stat label="Risks above appetite" value={`${register.summary.aboveAppetite} of ${register.summary.open} open`} note={`${register.summary.untreated} untreated · ${register.summary.acceptanceExpired} acceptance(s) lapsed`} href="/risk-register" urgent={register.summary.untreated > 0 || register.summary.acceptanceExpired > 0} />
        <Stat label="Compliance posture" value={compliance.overall.frameworks ? `${compliance.overall.score}%` : "No framework adopted"} note={compliance.overall.frameworks ? `${compliance.overall.readiness} · ${compliance.overall.frameworks} framework(s)` : "Adopt one in the compliance hub"} href="/compliance" />
        <Stat label="Open actions" value={`${openTasks.length} task(s)`} note={`${overdueTasks} overdue`} href="/tasks" urgent={overdueTasks > 0} />
      </section>

      <section className="grid grid-cols-1 border-b border-[#cbc7bd] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="border-b border-[#cbc7bd] xl:border-b-0 xl:border-e">
          <div className="flex items-center justify-between border-b border-[#cbc7bd] px-5 py-3 sm:px-7"><MicroLabel>Waiting for a decision</MicroLabel><span className="font-mono text-[10px] text-[#6f6c64]">{waiting.length}</span></div>
          {waiting.length === 0 ? (
            <div className="flex items-start gap-3 p-5 sm:p-7"><CircleCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[#2d6a4f]" /><p className="text-[13px] leading-6 text-[#4f4d47]">{started ? "Nothing in the records is waiting for someone to decide." : "Nothing is recorded yet. Start with the context and the scope of the management system."}</p></div>
          ) : (
            <ul className="divide-y divide-[#cbc7bd]">
              {waiting.map((item) => (
                <li key={item.key}>
                  <Link href={item.href} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 px-5 py-4 hover:bg-[#ece8de] sm:px-7">
                    <span className={cn("grid h-7 w-7 place-items-center border", item.urgent ? "border-[#b8322a] text-[#b8322a]" : "border-[#8c8981] text-[#5f5d56]")}>{item.urgent ? <CircleAlert aria-hidden="true" className="h-3.5 w-3.5" /> : <Scale aria-hidden="true" className="h-3.5 w-3.5" />}</span>
                    <span><span className="block text-[13px] font-semibold text-[#2b2a26]">{item.text}</span><span className="mt-1 block text-[12px] leading-5 text-[#5f5c55]">{item.detail}</span></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between border-b border-[#cbc7bd] px-5 py-3 sm:px-7"><MicroLabel>Highest residual risks</MicroLabel><Link href="/risk-register" className="font-mono text-[10px] uppercase tracking-wider text-[#5f5d56] underline-offset-2 hover:underline">Register</Link></div>
          {worst.length === 0 ? <p className="p-5 text-[13px] leading-6 text-[#4f4d47] sm:p-7">No risk is recorded. Value the assets and assess the threats that apply to them.</p> : (
            <ul className="divide-y divide-[#cbc7bd]">
              {worst.map((risk) => (
                <li key={risk.id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-start gap-3 px-5 py-3.5 sm:px-7">
                  <span className="font-mono text-[11px] font-semibold text-[#2b2a26]">{risk.ref}</span>
                  <span className="text-[12px] leading-5 text-[#45433e]">{risk.title}<span className="block font-mono text-[10px] uppercase tracking-wider text-[#6f6c64]">{risk.effectiveStatus.replace("_", " ")}{risk.aboveAppetite ? " · above appetite" : ""}</span></span>
                  <span className={cn("border px-2 py-1 font-mono text-[10px] uppercase tracking-wider", BAND[risk.residual.band] ?? BAND.medium)}>{risk.residual.score} {risk.residual.level?.label ?? risk.residual.band}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="border-b border-[#cbc7bd] xl:border-b-0 xl:border-e">
          <div className="border-b border-[#cbc7bd] px-5 py-3 sm:px-7"><MicroLabel>Clauses not yet met</MicroLabel></div>
          {unmet.length === 0 ? <p className="p-5 text-[13px] leading-6 text-[#4f4d47] sm:p-7">Every clause check is met by a current record.</p> : (
            <ul className="divide-y divide-[#cbc7bd]">
              {unmet.slice(0, 8).map((clause) => (
                <li key={clause.clause} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 px-5 py-3.5 sm:px-7">
                  <span className="font-mono text-[11px] font-semibold text-[#2b2a26]">{clause.clause}</span>
                  <span className="text-[12px] leading-5 text-[#45433e]"><span className="font-semibold">{clause.title}</span><span className="ms-2 font-mono text-[10px] uppercase tracking-wider text-[#a63b1c]">{clause.status}</span><span className="block text-[#5f5c55]">{clause.next ?? clause.detail}</span></span>
                </li>
              ))}
              {unmet.length > 8 ? <li className="px-5 py-3 text-[12px] text-[#5f5c55] sm:px-7"><Link href="/isms" className="underline underline-offset-2">{unmet.length - 8} more in the management system</Link></li> : null}
            </ul>
          )}
        </div>

        <div>
          <div className="border-b border-[#cbc7bd] px-5 py-3 sm:px-7"><MicroLabel>Objectives off track</MicroLabel></div>
          {isms.objectives.length === 0 ? <p className="p-5 text-[13px] leading-6 text-[#4f4d47] sm:p-7">No objective is set.</p> : offTrack.length === 0 ? <p className="p-5 text-[13px] leading-6 text-[#4f4d47] sm:p-7">All {isms.objectives.length} objective(s) are on track.</p> : (
            <ul className="divide-y divide-[#cbc7bd]">
              {offTrack.map((objective) => (
                <li key={objective.id} className="px-5 py-3.5 text-[12px] leading-5 text-[#45433e] sm:px-7">
                  <span className="font-semibold">{objective.title}</span>
                  <span className="block text-[#5f5c55]">Target {objective.target}{objective.current_value ? ` · measured ${objective.current_value}` : " · not measured"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
