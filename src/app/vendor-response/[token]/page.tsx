"use client";

import { use, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, fetchJson, isAbort } from "@/components/api-client";

type Form = { organisation: string; provider: string; expiresAt: string; questions: Array<{ id: string; section: string; text: string; evidence: string | null }> };
type Value = "yes" | "partial" | "no" | "na";
const CHOICES: Array<[Value, string]> = [["yes", "Yes"], ["partial", "Partially"], ["no", "No"], ["na", "Not applicable"]];

/** Public page: the vendor answers without an account. The link is the only credential and works once. */
export default function VendorResponse({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, { answer: Value; comment: string }>>({});
  const [who, setWho] = useState({ name: "", email: "" });
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchJson<Form>(`/api/vendor-response/${token}`, { signal: controller.signal }).then(setForm).catch((failure: unknown) => { if (!isAbort(failure)) setError(errorMessage(failure, "This link is not valid")); });
    return () => controller.abort();
  }, [token]);

  const complete = form !== null && form.questions.every((question) => answers[question.id]) && who.name.trim().length >= 2 && who.email.includes("@");
  async function submit() {
    setBusy(true); setError("");
    try {
      await fetchJson(`/api/vendor-response/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ respondentName: who.name, respondentEmail: who.email, answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, { answer: value.answer, comment: value.comment || undefined }])) }) });
      setDone(true);
    } catch (failure) { setError(errorMessage(failure, "Could not send your answers")); }
    setBusy(false);
  }

  const sections = form ? [...new Set(form.questions.map((question) => question.section))] : [];
  return (
    <main id="main-content" className="mx-auto min-h-screen max-w-3xl bg-[#f4f1e9] px-5 py-10 text-[#1c1c18]">
      <h1 className="text-[22px] font-semibold tracking-tight">Security questionnaire</h1>
      {done ? <p role="status" className="mt-6 border border-[#245c3f] bg-[#dcebe1] p-4 text-[14px] text-[#173d2a]">Thank you. Your answers were received and this link no longer works.</p> : null}
      {error ? <p role="alert" className="mt-6 border border-[#b8322a] bg-[#f5e5e1] p-4 text-[14px] text-[#9f2923]">{error}</p> : null}
      {form && !done ? (
        <div className="mt-4 space-y-8">
          <p className="text-[14px] text-[#34332e]">{form.organisation} asks {form.provider} to describe its security and resilience practices for the services it provides. Answer honestly: your answers may be requested as evidence. This link works once and expires on {form.expiresAt.slice(0, 10)}.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[13px] font-medium">Your name<Input value={who.name} onChange={(event) => setWho({ ...who, name: event.target.value })} className="mt-1 h-9 rounded-none border-[#cbc7bd] bg-white text-[14px]" /></label>
            <label className="text-[13px] font-medium">Your work email<Input type="email" value={who.email} onChange={(event) => setWho({ ...who, email: event.target.value })} className="mt-1 h-9 rounded-none border-[#cbc7bd] bg-white text-[14px]" /></label>
          </div>
          {sections.map((section) => (
            <section key={section} aria-labelledby={`s-${section}`} className="space-y-4">
              <h2 id={`s-${section}`} className="font-mono text-[12px] uppercase tracking-wider text-[#5f5d56]">{section}</h2>
              {form.questions.filter((question) => question.section === section).map((question) => (
                <fieldset key={question.id} className="border border-[#cbc7bd] bg-white p-4">
                  <legend className="px-1 text-[14px] font-medium">{question.text}</legend>
                  {question.evidence ? <p className="mb-2 text-[12px] text-[#5f5d56]">Useful to include: {question.evidence}</p> : null}
                  <div className="flex flex-wrap gap-4">{CHOICES.map(([value, text]) => <label key={value} className="flex items-center gap-1.5 text-[13px]"><input type="radio" name={question.id} checked={answers[question.id]?.answer === value} onChange={() => setAnswers({ ...answers, [question.id]: { answer: value, comment: answers[question.id]?.comment ?? "" } })} />{text}</label>)}</div>
                  <Textarea aria-label={`Comment on ${question.id}`} placeholder="Comment or reference (optional)" value={answers[question.id]?.comment ?? ""} disabled={!answers[question.id]} onChange={(event) => setAnswers({ ...answers, [question.id]: { answer: answers[question.id].answer, comment: event.target.value } })} className="mt-3 min-h-12 rounded-none text-[13px]" />
                </fieldset>))}
            </section>))}
          <Button type="button" disabled={!complete || busy} onClick={() => void submit()} className="h-10 rounded-none bg-[#171713] px-6 text-[14px] text-white">{busy ? "Sending…" : "Submit answers"}</Button>
          {!complete ? <p className="text-[12px] text-[#5f5d56]">Answer every question and give your name and email to submit.</p> : null}
        </div>
      ) : null}
    </main>
  );
}
