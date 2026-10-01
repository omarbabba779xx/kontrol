"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  GitCommitHorizontal,
  Link2,
  LockKeyhole,
  Scale,
  ShieldCheck,
  Timer,
  TriangleAlert,
  X,
} from "lucide-react";
import { PageHeading, MicroLabel } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type NodeKey = "change" | "system" | "process" | "risk" | "control" | "evidence";

const nodes: Array<{ key: NodeKey; code: string; type: string; title: string; state: string; tone: "blue" | "orange" | "black" | "red" | "green" }> = [
  { key: "change", code: "REG-26-041", type: "Regulatory change", title: "AI Act Art. 14", state: "Effective", tone: "blue" },
  { key: "system", code: "AI-014", type: "AI system", title: "Lending Copilot", state: "High-risk", tone: "orange" },
  { key: "process", code: "BPS-003", type: "Business process", title: "Credit decision", state: "Critical", tone: "black" },
  { key: "risk", code: "RSK-035", type: "Risk", title: "Automation bias", state: "16 / 25", tone: "red" },
  { key: "control", code: "CTL-014", type: "Control", title: "Human override", state: "Partial", tone: "orange" },
  { key: "evidence", code: "EVD-2029", type: "Evidence", title: "Override log", state: "Stale", tone: "red" },
];

const detail: Record<NodeKey, { summary: string; owner: string; changed: string; basis: string[] }> = {
  change: { summary: "Human oversight must allow a competent person to understand limitations, detect anomalies, and safely disregard or override the output.", owner: "Regulatory Office", changed: "30 Sep 2026", basis: ["EU AI Act · Article 14", "High-risk system obligation", "Applies from 02 Dec 2027"] },
  system: { summary: "Recommends credit eligibility and limit bands to loan officers. It processes identity and financial data for EU residents.", owner: "Leila Mansour", changed: "26 Sep 2026", basis: ["Annex III · 5(b)", "Version Atlas Finance 3.2", "3 unresolved findings"] },
  process: { summary: "Decision workflow for unsecured consumer loans. The recommendation materially shapes access to an essential financial service.", owner: "Consumer Lending", changed: "18 Sep 2026", basis: ["Tier 1 business service", "€42M monthly originations", "Maximum outage: 4 hours"] },
  risk: { summary: "Loan officers may over-rely on model recommendations when the confidence score appears high, reducing meaningful human review.", owner: "Maya Chen", changed: "28 Sep 2026", basis: ["Likelihood 4 / 5", "Impact 4 / 5", "Residual exposure €2.4M"] },
  control: { summary: "A loan officer can reject the model recommendation, but the override reason is optional and no second-line sampling is performed.", owner: "Credit Operations", changed: "21 Sep 2026", basis: ["Design: adequate", "Operation: partial", "11 obligations mapped"] },
  evidence: { summary: "The latest override-log extract covers July only. August and September records are absent, breaking the operating-effectiveness chain.", owner: "Data Platform", changed: "31 Jul 2026", basis: ["Source: Snowflake", "SHA-256 verified", "60 days outside SLA"] },
};

const toneStyle = {
  blue: "border-[#1d4ed8] text-[#1d4ed8]",
  orange: "border-[#e4582f] text-[#b9401e]",
  black: "border-[#171713] text-[#171713]",
  red: "border-[#b8322a] text-[#9f2923]",
  green: "border-[#2d6a4f] text-[#2d6a4f]",
};

function Stat({ label, value, note, urgent }: { label: string; value: string; note: string; urgent?: boolean }) {
  return <div className="min-h-[104px] border-e border-b border-[#cbc7bd] px-5 py-4 last:border-e-0 sm:px-6"><MicroLabel>{label}</MicroLabel><div className={cn("mt-3 text-[22px] font-medium tracking-[-.04em]", urgent ? "text-[#b8322a]" : "text-[#171713]")}>{value}</div><div className="mt-1 font-mono text-[8px] uppercase tracking-wider text-[#8c8981]">{note}</div></div>;
}

export function OverviewDashboard() {
  const [selected, setSelected] = useState<NodeKey>("evidence");
  const [decision, setDecision] = useState<"pending" | "approved" | "rejected">("pending");
  const selectedNode = useMemo(() => nodes.find((node) => node.key === selected) ?? nodes[0], [selected]);
  const selectedDetail = detail[selected];

  return (
    <div>
      <PageHeading
        index="01 / 08"
        title="Decision room"
        description="One decision packet that joins regulation, operational reality, risk, controls and evidence. Every conclusion below is traceable to its source."
        meta="SAMPLE CASE 24–017 · ILLUSTRATIVE DATA"
        action={<span role="status" className={cn("border px-2.5 py-1.5 font-mono text-[8px] uppercase tracking-wider", decision === "approved" ? "border-[#2d6a4f] bg-[#e2eee6] text-[#2d6a4f]" : decision === "rejected" ? "border-[#b8322a] bg-[#f4e4e0] text-[#9f2923]" : "border-[#e4582f] bg-[#f7e5dc] text-[#a63b1c]")}>{decision === "pending" ? "Decision due · 8 days" : decision}</span>}
      />

      <section className="grid border-b border-[#cbc7bd] sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Decision requested" value="Conditional approval" note="Production expansion · EU" />
        <Stat label="Annualized exposure" value="€2.4M" note="P90 loss estimate · FAIR" urgent />
        <Stat label="Obligations touched" value="9 direct / 17 inherited" note="3 frameworks · 26 mappings" />
        <Stat label="Evidence integrity" value="19 / 22 current" note="3 broken chains · 1 material" urgent />
      </section>

      <section className="grid border-b border-[#cbc7bd] xl:grid-cols-[1fr_330px]">
        <div className="min-w-0 border-b border-[#cbc7bd] xl:border-b-0 xl:border-e">
          <div className="flex items-center justify-between border-b border-[#cbc7bd] px-5 py-3 sm:px-7">
            <div><MicroLabel>Impact trace / shortest material path</MicroLabel><p className="mt-1 text-[10px] text-[#5f5c55]">Select an object to inspect the assertion and its basis.</p></div>
            <div className="hidden items-center gap-4 font-mono text-[8px] text-[#8b887f] md:flex"><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#1d4ed8]" /> Source</span><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#b8322a]" /> Exception</span></div>
          </div>
          <div className="dot-grid overflow-x-auto px-5 py-10 sm:px-7">
            <div className="flex min-w-[820px] items-stretch">
              {nodes.map((node, index) => (
                <div key={node.key} className="flex min-w-0 flex-1 items-center">
                  <button type="button" aria-pressed={selected === node.key} onClick={() => setSelected(node.key)} className={cn("relative h-[118px] w-full border bg-[#f8f5ed] p-3 text-start transition-all hover:-translate-y-1 hover:shadow-[4px_4px_0_#cbc7bd]", toneStyle[node.tone], selected === node.key && "-translate-y-1 bg-white shadow-[4px_4px_0_#171713]")}>
                    <div className="flex items-center justify-between font-mono text-[7px] uppercase tracking-wider"><span>{node.type}</span><span>{node.code}</span></div>
                    <div className="mt-6 text-[12px] font-semibold text-[#24231f]">{node.title}</div>
                    <div className="absolute bottom-3 start-3 font-mono text-[8px] uppercase tracking-wider">{node.state}</div>
                  </button>
                  {index < nodes.length - 1 ? <div className="relative w-5 shrink-0"><div className="h-px bg-[#7e7b73]" /><ArrowRight className="absolute -end-0.5 -top-[5px] h-3 w-3 text-[#7e7b73]" /></div> : null}
                </div>
              ))}
            </div>
          </div>
          <div className="grid border-t border-[#cbc7bd] md:grid-cols-[170px_1fr]">
            <div className="border-b border-[#cbc7bd] bg-[#ece8de] p-5 md:border-b-0 md:border-e"><MicroLabel>Why this path matters</MicroLabel><div className="mt-4 flex items-center gap-2"><GitCommitHorizontal className="h-4 w-4 text-[#e4582f]" /><span className="font-mono text-[9px] text-[#5e5b54]">6 hops · 2 exceptions</span></div></div>
            <p className="p-5 text-[11px] leading-5 text-[#4f4d47]">The new oversight obligation is not the finding by itself. Material exposure appears only when it is connected to a critical credit process, a high automation-bias risk, a partially operating override control and stale operating evidence.</p>
          </div>
        </div>

        <aside aria-label="Object inspector" aria-live="polite" className="bg-[#ebe7dd]">
          <div className="border-b border-[#cbc7bd] p-5"><div className="flex items-center justify-between"><MicroLabel>Object inspector</MicroLabel><span className="font-mono text-[8px] text-[#89867e]">{selectedNode.code}</span></div><h2 className="mt-5 text-[20px] font-medium tracking-[-.035em] text-[#171713]">{selectedNode.title}</h2><span className={cn("mt-2 inline-block border px-2 py-1 font-mono text-[7px] uppercase tracking-wider", toneStyle[selectedNode.tone])}>{selectedNode.state}</span></div>
          <div className="border-b border-[#cbc7bd] p-5"><MicroLabel>Assertion</MicroLabel><p className="mt-3 text-[11px] leading-[1.65] text-[#4f4d46]">{selectedDetail.summary}</p></div>
          <div className="border-b border-[#cbc7bd] p-5"><MicroLabel>Basis</MicroLabel><div className="mt-3 space-y-2">{selectedDetail.basis.map((item) => <div key={item} className="flex items-start gap-2 text-[9px] text-[#5f5c55]"><Link2 className="mt-0.5 h-3 w-3 shrink-0 text-[#817e76]" /><span>{item}</span></div>)}</div></div>
          <div className="grid grid-cols-2"><div className="border-e border-[#cbc7bd] p-4"><MicroLabel>Owner</MicroLabel><p className="mt-2 text-[9px] font-medium text-[#34322d]">{selectedDetail.owner}</p></div><div className="p-4"><MicroLabel>Last changed</MicroLabel><p className="mt-2 font-mono text-[8px] text-[#56534d]">{selectedDetail.changed}</p></div></div>
        </aside>
      </section>

      <section className="grid border-b border-[#cbc7bd] xl:grid-cols-[1fr_1fr]">
        <div className="border-b border-[#cbc7bd] xl:border-b-0 xl:border-e">
          <div className="border-b border-[#cbc7bd] px-5 py-3 sm:px-7"><MicroLabel>Decision calculus</MicroLabel></div>
          <div className="grid sm:grid-cols-[1fr_190px]">
            <div className="p-5 sm:p-7">
              <div className="flex items-start gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center border border-[#e4582f] text-[#b9401e]"><Scale className="h-4 w-4" /></span><div><h3 className="text-[16px] font-medium tracking-[-.025em]">Approve with two pre-conditions</h3><p className="mt-2 max-w-xl text-[10px] leading-5 text-[#68655e]">The control design supports human intervention, but current evidence cannot prove that overrides operate consistently. Expansion is acceptable only after the missing log is restored and second-line sampling is activated.</p></div></div>
              <div className="mt-6 space-y-2">{["Restore Aug–Sep override evidence and validate completeness", "Activate weekly 10% override-quality sampling", "Limit rollout to existing product bands until closure"].map((item, index) => <div key={item} className="grid grid-cols-[24px_1fr_auto] items-center border-t border-[#d7d3c9] py-2.5 text-[9px]"><span className="font-mono text-[#e4582f]">0{index + 1}</span><span className="text-[#45433e]">{item}</span><span className="font-mono text-[7px] uppercase text-[#89867e]">Mandatory</span></div>)}</div>
            </div>
            <div className="border-t border-[#cbc7bd] bg-[#171713] p-5 text-[#f4f1e9] sm:border-s sm:border-t-0"><MicroLabel className="text-[#9e9b92]">Confidence</MicroLabel><div className="mt-4 font-mono text-[30px] font-medium">87<span className="text-sm text-[#8c8980]">%</span></div><p className="mt-2 text-[9px] leading-4 text-[#aaa79e]">Based on 22 evidence objects and 4 subject-matter attestations.</p><div className="mt-6 h-1 bg-[#4a4943]"><div className="h-full w-[87%] bg-[#f05a32]" /></div></div>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between border-b border-[#cbc7bd] px-5 py-3 sm:px-7"><MicroLabel>Contradictions to resolve</MicroLabel><span className="font-mono text-[8px] text-[#b8322a]">02 MATERIAL</span></div>
          <div className="divide-y divide-[#cbc7bd]">{[
            { icon: TriangleAlert, code: "C-01", title: "Policy says every override is justified", body: "Production telemetry shows 18.4% of overrides without a reason code.", source: "Policy v4.2 ↔ Snowflake extract" },
            { icon: CircleAlert, code: "C-02", title: "Control marked effective", body: "The last operating sample is 60 days old and misses two reporting periods.", source: "CTL-014 ↔ EVD-2029" },
          ].map((item) => <div key={item.code} className="grid grid-cols-[34px_1fr] gap-3 p-5"><span className="grid h-8 w-8 place-items-center border border-[#b8322a] text-[#b8322a]"><item.icon className="h-4 w-4" /></span><div><div className="flex items-center justify-between"><h3 className="text-[11px] font-semibold text-[#2b2a26]">{item.title}</h3><span className="font-mono text-[7px] text-[#a09d95]">{item.code}</span></div><p className="mt-1.5 text-[9px] leading-4 text-[#716e66]">{item.body}</p><p className="mt-2 font-mono text-[7px] uppercase tracking-wider text-[#9c3f35]">{item.source}</p></div></div>)}</div>
        </div>
      </section>

      <section className="grid lg:grid-cols-[1fr_330px]">
        <div className="border-b border-[#cbc7bd] lg:border-b-0 lg:border-e">
          <div className="flex items-center justify-between border-b border-[#cbc7bd] px-5 py-3 sm:px-7"><MicroLabel>Evidence chain</MicroLabel><span className="font-mono text-[8px] text-[#85827a]">IMMUTABLE LOG · 7 EVENTS</span></div>
          <div className="overflow-x-auto p-5 sm:p-7"><div className="flex min-w-[680px] items-start">{[
            { time: "09:12", label: "Source queried", icon: Link2, ok: true }, { time: "09:13", label: "Hash verified", icon: LockKeyhole, ok: true }, { time: "09:13", label: "Schema passed", icon: Check, ok: true }, { time: "09:14", label: "Period failed", icon: X, ok: false }, { time: "09:15", label: "Owner notified", icon: Timer, ok: true },
          ].map((event, index, all) => <div key={event.label} className="flex flex-1 items-start"><div className="w-24 text-center"><span className={cn("mx-auto grid h-7 w-7 place-items-center rounded-full border bg-[#f4f1e9]", event.ok ? "border-[#2d6a4f] text-[#2d6a4f]" : "border-[#b8322a] bg-[#f4e4e0] text-[#b8322a]")}><event.icon className="h-3 w-3" /></span><p className="mt-2 text-[8px] font-medium text-[#4b4943]">{event.label}</p><p className="mt-1 font-mono text-[7px] text-[#99968e]">{event.time}</p></div>{index < all.length - 1 ? <div className="mt-3.5 h-px flex-1 bg-[#bdb9af]" /> : null}</div>)}</div></div>
        </div>
        <div className="bg-[#e9e5db] p-5">
          <MicroLabel>Record decision (demo)</MicroLabel>
          {decision === "pending" ? <><p className="mt-3 text-[10px] leading-5 text-[#625f58]">Your decision, conditions and the evidence snapshot will be sealed into the audit log.</p><div className="mt-5 grid grid-cols-2 gap-2"><Button onClick={() => setDecision("rejected")} variant="outline" className="h-9 rounded-none border-[#171713] bg-transparent text-[9px] shadow-none hover:bg-[#f0ddd8]">Reject</Button><Button onClick={() => setDecision("approved")} className="h-9 rounded-none bg-[#171713] text-[9px] text-white shadow-none hover:bg-[#2d2d27]">Approve conditions</Button></div></> : <div className="mt-4 border border-[#2d6a4f] bg-[#e2eee6] p-4"><div className="flex items-center gap-2 text-[#2d6a4f]"><ShieldCheck className="h-4 w-4" /><span className="text-[10px] font-semibold">Decision sealed</span></div><p className="mt-2 font-mono text-[7px] uppercase leading-4 text-[#4b725c]">30 SEP 2026 · LM-2041 · SHA 81CE…220F</p><button type="button" onClick={() => setDecision("pending")} className="mt-3 text-[8px] underline underline-offset-2">Undo demo action</button></div>}
        </div>
      </section>
    </div>
  );
}
