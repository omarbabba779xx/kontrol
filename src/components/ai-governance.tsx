"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { MicroLabel, PageHeading } from "@/components/platform-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Tier = "prohibited" | "high" | "limited" | "minimal";
type Answers = { prohibited: string[]; annexIIIArea: string; derogationClaimed: boolean; profilesPeople: boolean; annexIProduct: boolean; interactsWithPeople: boolean; generatesSyntheticContent: boolean; emotionRecognitionOrBiometricCategorisation: boolean; gpaiProvider: boolean; gpaiSystemic: boolean; publicService: boolean };
type Obligation = { id: string; article: string; title: string; ucCode: string; state: "met" | "partial" | "open"; control: { status: string; verification: string } };
type FriaContent = { description: string; affectedGroups: string; rights: Array<{ right: string; impact: string; note: string }>; mitigations: string; oversight: string; remedy: string };
type UseCase = {
  id: string; ref: string; name: string; purpose: string; role: string; ownerId: string | null; status: string; tier: Tier | null; createdBy: string; answers: Partial<Answers>;
  classification: { reasons: string[]; gpai: { provider: boolean; systemic: boolean }; friaRequired: boolean; needsLegalReview: string[] } | null;
  approvedAt: string | null; approvalNote: string | null; obligations: Obligation[]; readiness: number | null;
  modelCard: { version: number; sha256: string; content: Record<string, string>; versions: number } | null;
  fria: { status: string; reviewedBy: string | null; content: FriaContent } | null;
};
type Library = { prohibited: Array<{ id: string; label: string; article: string }>; areas: Array<{ id: string; label: string }>; modelCardFields: Array<{ id: string; label: string; required: boolean }>; rights: string[] };
type Snapshot = { useCases: UseCase[]; summary: { total: number; high: number; prohibited: number; unclassified: number; approved: number; awaitingApproval: number }; library: Library };
type Person = { id: string; name: string; role: string; external: boolean };

const TIER: Record<Tier, string> = { prohibited: "bg-[#f5e5e1] text-[#9f2923]", high: "bg-[#f6e3d3] text-[#944a15]", limited: "bg-[#f1e7cc] text-[#7a5a1a]", minimal: "bg-[#dcebe1] text-[#245c3f]" };
const STATE: Record<string, string> = { met: "text-[#245c3f]", partial: "text-[#7a5a1a]", open: "text-[#b8322a]" };
const field = "h-8 rounded-none border-[#cbc7bd] bg-transparent text-[10px] shadow-none placeholder:text-[#63615a]";
const select = "h-8 border border-[#cbc7bd] bg-transparent px-2 text-[10px] focus-visible:outline-2 focus-visible:outline-[#171713]";
const BLANK: Answers = { prohibited: [], annexIIIArea: "none", derogationClaimed: false, profilesPeople: false, annexIProduct: false, interactsWithPeople: false, generatesSyntheticContent: false, emotionRecognitionOrBiometricCategorisation: false, gpaiProvider: false, gpaiSystemic: false, publicService: false };

type Act = (body: Record<string, unknown>, success: string, after?: (result: Record<string, unknown>) => void) => void;

export function AiGovernance() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [failed, setFailed] = useState(false);
  const [isPending, startTransition] = useTransition();

  const load = useCallback((signal?: AbortSignal) => fetchJson<Snapshot>("/api/ai-governance", { signal }).then((data) => { setSnapshot(data); setFailed(false); }), []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(() => setStatus("Up to date")).catch((error: unknown) => { if (!isAbort(error)) { setFailed(true); setStatus(errorMessage(error, "AI governance unavailable")); } });
    fetchJson<{ users: Person[] }>("/api/users", { signal: controller.signal }).then((data) => setPeople(data.users.filter((person) => !person.external))).catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  const act: Act = (body, success, after) => {
    startTransition(async () => {
      let result: Record<string, unknown> = {};
      try { setStatus("Saving…"); result = await fetchJson<Record<string, unknown>>("/api/ai-governance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
      catch (error) { setStatus(errorMessage(error, "Action failed")); return; }
      try { await load(); setStatus(success); after?.(result); } catch (error) { setStatus(`Done, but refresh failed: ${errorMessage(error, "unknown error")}`); }
    });
  };

  const s = snapshot?.summary;
  return (
    <div>
      <PageHeading index="18" title="AI governance" description="Register AI systems, classify them under the EU AI Act with the reasoning recorded, document them with versioned model cards, and approve them only when the paperwork and the controls are in place." meta={status} />
      <section className="p-5 sm:p-7 lg:p-9" aria-busy={snapshot === null && !failed}>
        {failed ? <div role="alert" className="mb-4 border border-[#b8322a] bg-[#f5e5e1] p-3 text-[9px] text-[#9f2923]">{status}</div> : null}
        {snapshot && s ? (
          <div className="space-y-6">
            <div className="grid gap-px border border-[#cbc7bd] bg-[#cbc7bd] sm:grid-cols-3 lg:grid-cols-6">
              {([["AI systems", s.total], ["High-risk", s.high], ["Prohibited", s.prohibited], ["Unclassified", s.unclassified], ["Awaiting approval", s.awaitingApproval], ["Approved", s.approved]] as const).map(([name, value]) => <div key={name} className="bg-[#f4f1e9] p-4"><MicroLabel>{name}</MicroLabel><p className={cn("mt-1 font-mono text-[22px] font-semibold", name === "Prohibited" && value > 0 && "text-[#b8322a]")}>{value}</p></div>)}
            </div>
            <p className="max-w-3xl border-s-2 border-[#a98a45] ps-3 text-[10px] text-[#55534b]">Classification is a triage that records its reasoning; it is not legal advice. Borderline calls (the Art.6(3) derogation, systemic-risk designation) should be confirmed with counsel, and application dates should be checked against the current timeline rather than assumed.</p>
            <div className="grid gap-8 xl:grid-cols-[320px_1fr]">
              <NewUseCase people={people} act={act} pending={isPending} onCreated={(id) => setOpen(id)} />
              <div tabIndex={0} role="region" aria-label="AI systems table, scrollable" className="overflow-x-auto border border-[#cbc7bd] focus-visible:outline-2 focus-visible:outline-[#171713]"><table className="w-full min-w-[720px] text-left text-[9px]"><caption className="sr-only">AI systems register</caption>
                <thead><tr className="bg-[#e9e5db] font-mono text-[7px] uppercase tracking-wider text-[#5f5d56]">{["Ref", "System", "Risk tier", "Status", "Readiness", ""].map((h) => <th key={h} scope="col" className="px-3 py-2.5">{h}</th>)}</tr></thead>
                <tbody>{snapshot.useCases.map((item) => (
                  <Fragment key={item.id}>
                    <tr className={cn("border-t border-[#d8d4ca] align-top", item.status === "retired" && "opacity-50")}>
                      <td className="px-3 py-3 font-mono font-semibold">{item.ref}</td>
                      <td className="px-3 py-3"><span className="font-medium">{item.name}</span><span className="block font-mono text-[8px] text-[#5f5d56]">{item.role}{item.classification?.gpai.provider ? " · GPAI provider" : ""}</span></td>
                      <td className="px-3 py-3">{item.tier ? <span className={cn("px-1.5 py-0.5 font-mono text-[8px] uppercase", TIER[item.tier])}>{item.tier}</span> : <span className="font-mono text-[8px] uppercase text-[#5f5d56]">not classified</span>}</td>
                      <td className="px-3 py-3 font-mono">{item.status}</td>
                      <td className="px-3 py-3 font-mono">{item.readiness === null ? "—" : `${item.readiness}%`}</td>
                      <td className="px-3 py-3 text-end"><Button type="button" variant="ghost" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)} className="h-6 rounded-none px-1 text-[8px]">Open <ChevronDown className={cn("ms-0.5 h-2.5 w-2.5 transition-transform", open === item.id && "rotate-180")} aria-hidden="true" /></Button></td>
                    </tr>
                    {open === item.id ? <tr className="bg-[#f1eee5]"><td colSpan={6} className="px-5 py-4"><Detail item={item} library={snapshot.library} act={act} pending={isPending} /></td></tr> : null}
                  </Fragment>))}</tbody></table>
                {snapshot.useCases.length === 0 ? <p className="p-8 text-center text-[10px] text-[#5f5d56]">No AI systems registered yet.</p> : null}</div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function NewUseCase({ people, act, pending, onCreated }: { people: Person[]; act: Act; pending: boolean; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ name: "", purpose: "", role: "deployer", ownerId: "" });
  return (
    <form className="h-fit space-y-2 border border-[#cbc7bd] p-4" onSubmit={(event) => { event.preventDefault(); act({ action: "create", name: form.name, purpose: form.purpose || undefined, role: form.role, ownerId: form.ownerId || undefined }, "AI system registered", (result) => { onCreated(String(result.id)); setForm({ name: "", purpose: "", role: "deployer", ownerId: "" }); }); }}>
      <MicroLabel>Register an AI system</MicroLabel>
      <Input aria-label="AI system name" placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className={field} />
      <Input aria-label="Purpose" placeholder="What it is used for" value={form.purpose} onChange={(event) => setForm({ ...form, purpose: event.target.value })} className={field} />
      <select aria-label="Our role" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })} className={cn(select, "w-full")}><option value="deployer">We deploy it (use a system built by others)</option><option value="provider">We provide it (we built and place it on the market)</option><option value="both">Both</option></select>
      <select aria-label="Owner" value={form.ownerId} onChange={(event) => setForm({ ...form, ownerId: event.target.value })} className={cn(select, "w-full")}><option value="">No owner yet</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
      <Button type="submit" disabled={pending || form.name.trim().length < 3} className="h-8 w-full rounded-none bg-[#171713] text-[10px] text-white"><Plus className="me-1.5 h-3 w-3" aria-hidden="true" />Register</Button>
    </form>
  );
}

function Detail({ item, library, act, pending }: { item: UseCase; library: Library; act: Act; pending: boolean }) {
  const [tab, setTab] = useState<"Classification" | "Obligations" | "Model card" | "Impact assessment" | "Decision">("Classification");
  const names = ["Classification", "Obligations", "Model card", "Impact assessment", "Decision"] as const;
  const retired = item.status === "retired";
  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={`${item.ref} sections`} className="flex flex-wrap border-b border-[#cbc7bd]">{names.map((name) => <button key={name} role="tab" aria-selected={tab === name} type="button" onClick={() => setTab(name)} className={cn("px-3 py-2 text-[10px] font-medium", tab === name ? "border-b-2 border-[#171713]" : "text-[#5f5d56] hover:text-[#171713]")}>{name}</button>)}</div>
      {tab === "Classification" ? <Classify item={item} library={library} act={act} pending={pending || retired} /> : null}
      {tab === "Obligations" ? <Obligations item={item} /> : null}
      {tab === "Model card" ? <ModelCard item={item} library={library} act={act} pending={pending || retired} /> : null}
      {tab === "Impact assessment" ? <Fria item={item} library={library} act={act} pending={pending || retired} /> : null}
      {tab === "Decision" ? <Decision item={item} act={act} pending={pending} /> : null}
    </div>
  );
}

function Classify({ item, library, act, pending }: { item: UseCase; library: Library; act: Act; pending: boolean }) {
  const [a, setA] = useState<Answers>({ ...BLANK, ...item.answers });
  const flag = (key: keyof Answers, text: string) => <label key={key} className="flex items-start gap-2 text-[10px]"><input type="checkbox" className="mt-0.5" checked={a[key] as boolean} onChange={(event) => setA({ ...a, [key]: event.target.checked })} />{text}</label>;
  return (
    <div className="grid max-w-5xl gap-6 md:grid-cols-2">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); act({ action: "classify", id: item.id, answers: { ...a, role: item.role } }, "Classified"); }}>
        <fieldset className="space-y-1.5"><legend className="mb-1 font-mono text-[8px] uppercase text-[#5f5d56]">1. Prohibited practices (Art.5)</legend>
          {library.prohibited.map((practice) => <label key={practice.id} className="flex items-start gap-2 text-[10px]"><input type="checkbox" className="mt-0.5" checked={a.prohibited.includes(practice.id)} onChange={(event) => setA({ ...a, prohibited: event.target.checked ? [...a.prohibited, practice.id] : a.prohibited.filter((id) => id !== practice.id) })} />{practice.label}</label>)}</fieldset>
        <fieldset className="space-y-1.5"><legend className="mb-1 font-mono text-[8px] uppercase text-[#5f5d56]">2. High-risk triggers (Art.6)</legend>
          <label className="block text-[10px]">Annex III area<select aria-label="Annex III area" value={a.annexIIIArea} onChange={(event) => setA({ ...a, annexIIIArea: event.target.value })} className={cn(select, "mt-1 w-full")}>{library.areas.map((area) => <option key={area.id} value={area.id}>{area.label}</option>)}</select></label>
          {flag("derogationClaimed", "Art.6(3) derogation: only a narrow procedural or preparatory task, or improves a prior human activity, with no replacement of human assessment")}
          {flag("profilesPeople", "It profiles natural persons")}
          {flag("annexIProduct", "It is, or is a safety component of, a product covered by Annex I legislation needing third-party conformity assessment")}
          {flag("publicService", "We are a public body or provide public services")}</fieldset>
        <fieldset className="space-y-1.5"><legend className="mb-1 font-mono text-[8px] uppercase text-[#5f5d56]">3. Transparency and general-purpose models</legend>
          {flag("interactsWithPeople", "It interacts directly with people (chatbot, voice agent)")}
          {flag("generatesSyntheticContent", "It generates synthetic audio, image, video or text")}
          {flag("emotionRecognitionOrBiometricCategorisation", "Emotion recognition or biometric categorisation")}
          {flag("gpaiProvider", "We place a general-purpose AI model on the market")}
          {a.gpaiProvider ? flag("gpaiSystemic", "Presumed systemic risk (training compute above the Act's threshold, or designated)") : null}</fieldset>
        <Button type="submit" disabled={pending} className="h-8 rounded-none bg-[#171713] text-[10px] text-white">Classify</Button>
      </form>
      <div className="space-y-3">
        {item.classification && item.tier ? <>
          <p className="flex items-center gap-2 text-[11px] font-semibold">Result <span className={cn("px-1.5 py-0.5 font-mono text-[9px] uppercase", TIER[item.tier])}>{item.tier}</span></p>
          {item.classification.reasons.map((reason, index) => <p key={index} className="border-s-2 border-[#cbc7bd] ps-2 text-[10px]">{reason}</p>)}
          {item.classification.needsLegalReview.length ? <div className="border border-[#a98a45] bg-[#f8f1dc] p-3 text-[9px]"><p className="font-semibold">Confirm with counsel</p>{item.classification.needsLegalReview.map((text, index) => <p key={index} className="mt-1">{text}</p>)}</div> : null}
        </> : <p className="text-[10px] text-[#5f5d56]">Answer the questions and classify. The reasoning for each answer is kept with the result.</p>}
      </div>
    </div>
  );
}

function Obligations({ item }: { item: UseCase }) {
  if (!item.classification) return <p className="text-[10px] text-[#5f5d56]">Classify the system to see its obligations.</p>;
  if (item.obligations.length === 0) return <p className="text-[10px] text-[#5f5d56]">{item.tier === "prohibited" ? "A prohibited practice has no obligations to fulfil: it must not be deployed." : "No specific obligations beyond AI literacy (Art.4) and voluntary codes of conduct."}</p>;
  return (
    <div className="max-w-4xl space-y-1">
      <p className="text-[10px] text-[#55534b]">Each obligation is supported by a unified control; its state comes from the live compliance posture, so it moves when the control is attested, verified or lapses.</p>
      {item.obligations.map((obligation) => <p key={obligation.id} className="flex items-start justify-between gap-4 border-b border-[#d8d4ca] py-1.5 text-[10px]"><span><span className="font-mono text-[8px] text-[#5f5d56]">{obligation.article}</span> {obligation.title}</span><span className={cn("shrink-0 font-mono text-[8px] uppercase", STATE[obligation.state])}>{obligation.state} · {obligation.ucCode}</span></p>)}
    </div>
  );
}

function ModelCard({ item, library, act, pending }: { item: UseCase; library: Library; act: Act; pending: boolean }) {
  const [content, setContent] = useState<Record<string, string>>(item.modelCard?.content ?? {});
  return (
    <form className="max-w-3xl space-y-3" onSubmit={(event) => { event.preventDefault(); act({ action: "model_card", id: item.id, content }, "Model card saved as a new version"); }}>
      <p className="text-[10px] text-[#55534b]">{item.modelCard ? `Version ${item.modelCard.version} of ${item.modelCard.versions}, SHA-256 ${item.modelCard.sha256.slice(0, 16)}…. Saving creates a new version; earlier versions are never overwritten.` : "No model card yet. High-risk systems and general-purpose model providers need one before approval."}</p>
      {library.modelCardFields.map((fieldDef) => <label key={fieldDef.id} className="block text-[10px] font-medium">{fieldDef.label}{fieldDef.required ? " *" : ""}<Textarea value={content[fieldDef.id] ?? ""} onChange={(event) => setContent({ ...content, [fieldDef.id]: event.target.value })} className="mt-1 min-h-14 rounded-none text-[10px] font-normal" /></label>)}
      <Button type="submit" disabled={pending} className="h-8 rounded-none bg-[#171713] text-[10px] text-white">Save model card</Button>
    </form>
  );
}

function Fria({ item, library, act, pending }: { item: UseCase; library: Library; act: Act; pending: boolean }) {
  const initial: FriaContent = item.fria?.content ?? { description: "", affectedGroups: "", rights: library.rights.map((right) => ({ right, impact: "none", note: "" })), mitigations: "", oversight: "", remedy: "" };
  const [c, setC] = useState<FriaContent>(initial);
  const required = item.classification?.friaRequired === true;
  const send = (complete: boolean) => act({ action: "fria", id: item.id, content: { ...c, rights: c.rights.filter((entry) => entry.impact !== "none" || entry.note.trim()) }, complete }, complete ? "Impact assessment completed" : "Draft saved");
  return (
    <div className="max-w-3xl space-y-3">
      <p className="text-[10px] text-[#55534b]">{required ? "Required before first use (Art.27) for this system." : "Not required for this classification, but recommended for any system affecting people."}{item.fria ? ` Status: ${item.fria.status}${item.fria.reviewedBy ? ", reviewed" : item.fria.status === "completed" ? ", awaiting review by another person" : ""}.` : ""}</p>
      {([["description", "Process in which the system is used"], ["affectedGroups", "Categories of people affected"]] as const).map(([key, text]) => <label key={key} className="block text-[10px] font-medium">{text}<Textarea value={c[key]} onChange={(event) => setC({ ...c, [key]: event.target.value })} className="mt-1 min-h-12 rounded-none text-[10px] font-normal" /></label>)}
      <fieldset className="space-y-1"><legend className="font-mono text-[8px] uppercase text-[#5f5d56]">Fundamental rights and the impact on each</legend>
        {c.rights.map((entry, index) => <div key={entry.right} className="flex flex-wrap items-center gap-2 text-[10px]"><span className="w-56">{entry.right}</span>
          <select aria-label={`Impact on ${entry.right}`} value={entry.impact} onChange={(event) => setC({ ...c, rights: c.rights.map((r, i) => (i === index ? { ...r, impact: event.target.value } : r)) })} className={select}>{["none", "low", "medium", "high"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
          {entry.impact !== "none" ? <Input aria-label={`Note on ${entry.right}`} placeholder="Why, and for whom" value={entry.note} onChange={(event) => setC({ ...c, rights: c.rights.map((r, i) => (i === index ? { ...r, note: event.target.value } : r)) })} className={cn(field, "min-w-48 flex-1")} /> : null}</div>)}</fieldset>
      {([["mitigations", "Measures to mitigate the risks"], ["oversight", "Human oversight arrangements"], ["remedy", "Complaint and remedy mechanism"]] as const).map(([key, text]) => <label key={key} className="block text-[10px] font-medium">{text}<Textarea value={c[key]} onChange={(event) => setC({ ...c, [key]: event.target.value })} className="mt-1 min-h-12 rounded-none text-[10px] font-normal" /></label>)}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => send(false)} className="h-8 rounded-none border-[#171713] bg-transparent text-[10px]">Save draft</Button>
        <Button type="button" disabled={pending} onClick={() => send(true)} className="h-8 rounded-none bg-[#171713] text-[10px] text-white">Complete assessment</Button>
        {item.fria?.status === "completed" && !item.fria.reviewedBy ? <Button type="button" disabled={pending} onClick={() => act({ action: "review_fria", id: item.id }, "Assessment reviewed")} className="h-8 rounded-none bg-[#245c3f] text-[10px] text-white">Mark as reviewed</Button> : null}
      </div>
    </div>
  );
}

function Decision({ item, act, pending }: { item: UseCase; act: Act; pending: boolean }) {
  const [note, setNote] = useState("");
  return (
    <div className="max-w-2xl space-y-3 text-[10px]">
      {item.status === "approved" ? <p className="border-s-2 border-[#245c3f] ps-2">Approved on {item.approvedAt?.slice(0, 10)}: “{item.approvalNote}”. Re-classifying with a different outcome voids this approval.</p> : null}
      {item.status === "blocked" ? <p className="border-s-2 border-[#b8322a] ps-2 text-[#9f2923]">Blocked: a prohibited practice cannot be approved. Retire the system.</p> : null}
      <p className="text-[#55534b]">Approval needs someone other than the owner and the person who registered the system. A high-risk system also needs a model card, a reviewed impact assessment where required, and every control behind its obligations at least partially implemented.</p>
      {item.status !== "retired" ? <>
        <Textarea aria-label={`Decision note for ${item.ref}`} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Decision note (10+ characters)" className="min-h-14 rounded-none text-[10px] placeholder:text-[#63615a]" />
        <div className="flex gap-2">
          {item.status === "classified" ? <Button type="button" disabled={pending || note.trim().length < 10} onClick={() => act({ action: "approve", id: item.id, note }, "AI system approved", () => setNote(""))} className="h-8 rounded-none bg-[#245c3f] text-[10px] text-white">Approve for use</Button> : null}
          <Button type="button" variant="outline" disabled={pending || note.trim().length < 10} onClick={() => { if (window.confirm("Retire this AI system? This is final.")) act({ action: "retire", id: item.id, note }, "AI system retired", () => setNote("")); }} className="h-8 rounded-none border-[#b8322a] bg-transparent text-[10px] text-[#b8322a]">Retire</Button>
        </div></> : <p>Retired: this system is closed and can no longer change.</p>}
    </div>
  );
}
