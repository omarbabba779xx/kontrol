import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner } from "./setup";

isolateDatabase();

const tp = () => import("../src/lib/core/third-party");
const health = () => import("../src/lib/core/register-health");
const library = () => import("../src/lib/core/vendor-questionnaire");
const db = async () => (await import("../src/lib/db")).getDb();
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();

/** Builds a valid LEI from 18 characters by computing the ISO 17442 check digits. */
function lei(base: string) {
  const digits = [...`${base}00`].map((char) => (/[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char)).join("");
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return `${base}${String(98 - remainder).padStart(2, "0")}`;
}
const CLOUD_LEI = lei("5493001KJTIIGC8Y1R");
const SOC_LEI = lei("969500T3MBS4SQAMHJ");

const arrangement = (providerId: string, overrides: Record<string, unknown> = {}) => ({
  providerId, serviceType: "cloud_iaas" as const, functionSupported: "Core banking hosting", criticality: "critical_or_important" as const,
  startDate: iso(-400), endDate: iso(700), governingLaw: "IE", serviceCountry: "IE", dataCountry: "IE", dataSensitivity: "personal" as const,
  subcontractors: [{ name: "Colo Partner", country: "NL", service: "Data centre" }], substitutability: "difficult" as const, exitPlan: true, exitTestedAt: iso(-100), auditRights: true, incidentNotificationHours: 24, ...overrides,
});

test("LEIs are checked with the ISO 17442 algorithm", async () => {
  const { validLei } = await health();
  assert.equal(validLei(CLOUD_LEI), true);
  assert.equal(validLei("5493001KJTIIGC8Y1R12"), true, "a published LEI");
  assert.equal(validLei(`${CLOUD_LEI.slice(0, 19)}${(Number(CLOUD_LEI[19]) + 1) % 10}`), false);
  assert.equal(validLei("short"), false);
});

test("providers reject bad identifiers and duplicates; arrangements validate dates, countries and exit tests", async () => {
  const { createProvider, createArrangement } = await tp();
  await assert.rejects(createProvider(admin, { name: "Bad LEI", lei: "5493001KJTIIGC8Y1R13", country: "IE", providerType: "third_party" }), /LEI is not valid/);
  await assert.rejects(createProvider(admin, { name: "Bad country", country: "Ireland", providerType: "third_party" }), /alpha-2/);
  const cloud = await createProvider(admin, { name: "Nimbus Cloud", lei: CLOUD_LEI, country: "IE", providerType: "third_party" });
  await assert.rejects(createProvider(admin, { name: "nimbus cloud", country: "IE", providerType: "third_party" }), /duplicate/);
  await assert.rejects(createArrangement(admin, arrangement(cloud.id, { endDate: iso(-500) })), /must not precede/);
  await assert.rejects(createArrangement(admin, arrangement(cloud.id, { dataCountry: "Ireland" })), /alpha-2/);
  await assert.rejects(createArrangement(admin, arrangement(cloud.id, { exitPlan: false })), /requires an exit plan/);
  await assert.rejects(createArrangement(admin, arrangement("prv_nobody")), /Provider not found/);
  const first = await createArrangement(admin, arrangement(cloud.id));
  assert.equal(first.ref, "ARR-001");
});

test("the register flags what a supervisor would flag, and refuses to export while it is incomplete", async () => {
  const { createProvider, createArrangement, registerSnapshot, exportRegister } = await tp();
  const soc = await createProvider(admin, { name: "Sentinel SOC", country: "FR", providerType: "third_party" }); // no LEI
  await createArrangement(admin, arrangement(soc.id, { serviceType: "security_services", functionSupported: "24x7 monitoring", governingLaw: null, exitPlan: false, exitTestedAt: null, auditRights: false, substitutability: "impossible", incidentNotificationHours: 96, subcontractors: [{ name: "Offshore Ltd" }] }));
  const snapshot = await registerSnapshot(admin.tenantId);
  const codes = snapshot.issues.map((issue) => `${issue.ref}:${issue.code}`);
  for (const expected of ["ARR-002:provider.lei_missing", "ARR-002:arrangement.governing_law_missing", "ARR-002:arrangement.no_audit_rights", "ARR-002:arrangement.no_exit_plan", "ARR-002:arrangement.locked_in", "ARR-002:arrangement.incident_sla_slow", "ARR-002:supply_chain.country_missing"]) assert.ok(codes.includes(expected), `missing ${expected}`);
  assert.equal(snapshot.issues.filter((issue) => issue.ref === "ARR-001").length, 0, "the healthy arrangement raises nothing");
  assert.equal(snapshot.exportable, false);
  await assert.rejects(exportRegister(admin, "json"), /register is incomplete/);

  // Fix the errors and the export works.
  const provider = snapshot.providers.find((item) => item.name === "Sentinel SOC");
  const arr = snapshot.arrangements.find((item) => item.ref === "ARR-002");
  assert.ok(provider && arr);
  const { updateProvider, updateArrangement } = await tp();
  await updateProvider(admin, { id: provider.id, lei: SOC_LEI });
  await updateArrangement(admin, { id: arr.id, changes: { governingLaw: "FR" } });
  const file = await exportRegister(admin, "json");
  const parsed = JSON.parse(file.body) as { providers: unknown[]; contractualArrangements: Array<{ provider_lei: string }>; supplyChain: unknown[]; sha256: string; notice: string };
  assert.equal(parsed.providers.length, 2);
  assert.equal(parsed.contractualArrangements.length, 2);
  assert.equal(parsed.supplyChain.length, 2);
  assert.match(parsed.notice, /Not an xBRL-CSV/);
  assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
  const csv = await exportRegister(admin, "csv");
  assert.match(csv.body.split("\n")[0], /^arrangement_ref,provider_lei/);
});

test("concentration is measured over critical arrangements with an HHI", async () => {
  const { concentration } = await health();
  const provider = (id: string) => ({ id, name: id, lei: null, country: "IE", provider_type: "third_party", status: "active" });
  const arr = (providerId: string, n: number) => ({ id: `${providerId}${n}`, provider_id: providerId, ref: `A${providerId}${n}`, service_type: "x", function_supported: "x", criticality: "critical_or_important" as const, start_date: iso(-1), end_date: null, governing_law: "IE", service_country: "IE", data_country: null, data_sensitivity: "none", subcontractors: [], substitutability: "easy", exit_plan: true, exit_tested_at: null, audit_rights: true, incident_notification_hours: 24, status: "active" });
  const providers = [provider("a"), provider("b"), provider("c")];
  assert.equal(concentration(providers, [arr("a", 1), arr("a", 2)]).level, "low", "fewer than three critical arrangements is not a measure");
  const concentrated = concentration(providers, [arr("a", 1), arr("a", 2), arr("a", 3), arr("b", 1)]);
  assert.equal(concentrated.hhi, 6250);
  assert.equal(concentrated.level, "high");
  const spread = concentration(providers, [arr("a", 1), arr("b", 1), arr("c", 1)]);
  assert.equal(spread.hhi, 3333);
  assert.equal(spread.level, "high");
  const many = concentration([...providers, provider("d"), provider("e")], ["a", "b", "c", "d", "e"].map((id) => arr(id, 1)));
  assert.equal(many.hhi, 2000);
  assert.equal(many.level, "moderate");
});

test("terminating an arrangement is final, and a provider with active arrangements cannot exit", async () => {
  const { registerSnapshot, updateProvider, terminateArrangement, updateArrangement } = await tp();
  const snapshot = await registerSnapshot(admin.tenantId);
  const provider = snapshot.providers.find((item) => item.name === "Sentinel SOC")!;
  const arr = snapshot.arrangements.find((item) => item.provider_id === provider.id)!;
  await assert.rejects(updateProvider(admin, { id: provider.id, status: "exited" }), /Terminate the provider/);
  await terminateArrangement(admin, { id: arr.id, reason: "Contract not renewed" });
  await assert.rejects(terminateArrangement(admin, { id: arr.id, reason: "Again please" }), /already terminated/);
  await assert.rejects(updateArrangement(admin, { id: arr.id, changes: { description: "x" } }), /already terminated/);
  await updateProvider(admin, { id: provider.id, status: "exited" });
  const after = await registerSnapshot(admin.tenantId);
  assert.equal(after.issues.filter((issue) => issue.ref === arr.ref).length, 0, "terminated arrangements raise nothing");
});

test("the questionnaire library maps to real unified controls and scores with blocking findings", async () => {
  const { QUESTIONS, scoreAnswers, unknownMappings } = await library();
  assert.deepEqual(unknownMappings(), []);
  assert.equal(new Set(QUESTIONS.map((question) => question.id)).size, QUESTIONS.length);
  const all = (answer: "yes" | "partial" | "no" | "na") => Object.fromEntries(QUESTIONS.map((question) => [question.id, answer] as const));
  assert.deepEqual([scoreAnswers(all("yes")).score, scoreAnswers(all("yes")).level], [100, "low"]);
  assert.equal(scoreAnswers(all("partial")).score, 50);
  assert.equal(scoreAnswers(all("partial")).level, "medium");
  assert.equal(scoreAnswers(all("no")).level, "high");
  assert.equal(scoreAnswers(all("na")).score, 0, "nothing applicable gives no credit");
  // A near-perfect score does not offset a "no" on audit rights.
  const blocked = scoreAnswers({ ...all("yes"), "AUD-1": "no" });
  assert.ok(blocked.score >= 90);
  assert.equal(blocked.level, "high");
  assert.deepEqual(blocked.criticalFailures, ["AUD-1"]);
  // A missing answer counts against the vendor, including for blocking questions.
  const partial = scoreAnswers({ "GOV-1": "yes" });
  assert.ok(partial.unanswered.length > 10);
  assert.ok(partial.criticalFailures.includes("EXIT-1"));
});

test("a vendor answers once through a link whose token is stored only as a hash; the reviewer is not the sender", async () => {
  const { sendQuestionnaire, publicQuestionnaire, submitPublicQuestionnaire, reviewQuestionnaire, registerSnapshot, questionnaireDetail, revokeQuestionnaire, createProvider } = await tp();
  const { QUESTIONS } = await library();
  const provider = (await registerSnapshot(admin.tenantId)).providers.find((item) => item.name === "Nimbus Cloud")!;
  const sent = await sendQuestionnaire(admin, { providerId: provider.id, days: 14, respondentEmail: "security@nimbus.example" });
  await assert.rejects(sendQuestionnaire(admin, { providerId: provider.id, days: 14 }), /already open/);
  const token = sent.link.split("/").pop()!;

  const rows = await (await db()).system().all<{ token_hash: string }>("SELECT token_hash FROM vendor_questionnaires");
  assert.ok(rows.every((row) => row.token_hash !== token && row.token_hash.length === 64), "the raw token is never stored");

  const form = await publicQuestionnaire(token);
  assert.equal(form.provider, "Nimbus Cloud");
  assert.equal(form.questions.length, QUESTIONS.length);
  assert.ok(!JSON.stringify(form).includes("weight"), "the form does not reveal how answers are scored");
  await assert.rejects(publicQuestionnaire("x".repeat(43)), /invalid, expired or has been used/);
  await assert.rejects(publicQuestionnaire("short"), /invalid, expired or has been used/);

  const answers = Object.fromEntries(QUESTIONS.map((question) => [question.id, { answer: question.id === "AUD-1" || question.id === "EXIT-1" ? "no" as const : "yes" as const, comment: question.id === "AUD-1" ? "Audits only by our own team" : undefined }]));
  await assert.rejects(submitPublicQuestionnaire(token, { respondentName: "Sam Vendor", respondentEmail: "sam@nimbus.example", answers: { "GOV-1": { answer: "yes" } } }), /Answer every question/);
  await assert.rejects(submitPublicQuestionnaire(token, { respondentName: "Sam Vendor", respondentEmail: "sam@nimbus.example", answers: { ...answers, "ZZZ-9": { answer: "yes" } } }), /Unknown question/);
  await submitPublicQuestionnaire(token, { respondentName: "Sam Vendor", respondentEmail: "sam@nimbus.example", answers });
  await assert.rejects(submitPublicQuestionnaire(token, { respondentName: "Sam Vendor", respondentEmail: "sam@nimbus.example", answers }), /invalid, expired or has been used/);
  await assert.rejects(publicQuestionnaire(token), /invalid, expired or has been used/);

  const submitted = (await registerSnapshot(admin.tenantId)).questionnaires.find((item) => item.id === sent.id)!;
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.critical_failures, 2);
  assert.ok(!("answers_json" in submitted) && !("token_hash" in submitted));
  const detail = await questionnaireDetail(admin, sent.id);
  assert.equal(detail.scored.level, "high");
  assert.equal(detail.answers.find((item) => item.id === "AUD-1")?.comment, "Audits only by our own team");

  await assert.rejects(reviewQuestionnaire(admin, { id: sent.id, accept: true, note: "Looks reasonable overall." }), /Separation of duties/);
  const reviewed = await reviewQuestionnaire(riskOwner, { id: sent.id, accept: true, note: "Accepted with remediation of blocking findings." });
  assert.equal(reviewed.tasks, 2, "each blocking finding becomes a task");
  await assert.rejects(reviewQuestionnaire(riskOwner, { id: sent.id, accept: false, note: "Changing my mind later." }), /already accepted/);
  const { listTasks } = await import("../src/lib/core/tasks");
  const tasks = (await listTasks(admin.tenantId)).filter((task: { source_type: string }) => task.source_type === "vendor_questionnaire");
  assert.equal(tasks.length, 2);

  const other = await createProvider(admin, { name: "Revoked Co", country: "DE", providerType: "third_party" });
  const second = await sendQuestionnaire(admin, { providerId: other.id, days: 7 });
  await revokeQuestionnaire(admin, second.id);
  await assert.rejects(publicQuestionnaire(second.link.split("/").pop()!), /invalid, expired or has been used/);
  await assert.rejects(revokeQuestionnaire(admin, second.id), /already revoked/);
});

test("an expired link stops working, and the public endpoint is rate limited", async () => {
  const { sendQuestionnaire, publicQuestionnaire, createProvider } = await tp();
  const provider = await createProvider(admin, { name: "Slow Vendor", country: "ES", providerType: "third_party" });
  const sent = await sendQuestionnaire(admin, { providerId: provider.id, days: 1 });
  const token = sent.link.split("/").pop()!;
  await publicQuestionnaire(token);
  await (await db()).system().run("UPDATE vendor_questionnaires SET expires_at = ? WHERE id = ?", iso(-1), sent.id);
  await assert.rejects(publicQuestionnaire(token), /invalid, expired or has been used/);

  const { GET } = await import("../src/app/api/vendor-response/[token]/route");
  const { resetRateLimits } = await import("../src/lib/core/rate-limit");
  resetRateLimits();
  const call = () => GET(new Request("http://localhost/api/vendor-response/x", { headers: { "x-forwarded-for": "203.0.113.9" } }), { params: Promise.resolve({ token: token }) });
  const statuses: number[] = [];
  for (let i = 0; i < 32; i += 1) statuses.push((await call()).status);
  assert.equal(statuses[0], 404);
  assert.equal(statuses[31], 429);
});

test("the API requires the vendors:manage permission to write, and a viewer can read", async () => {
  const { GET, POST } = await import("../src/app/api/third-party/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const viewer = { ...admin, role: "viewer" as const };
  const headers = { authorization: `Bearer ${await issueSessionToken(viewer)}`, "content-type": "application/json" };
  assert.equal((await GET(new Request("http://localhost/api/third-party", { headers }))).status, 200);
  const denied = await POST(new Request("http://localhost/api/third-party", { method: "POST", headers, body: JSON.stringify({ action: "create_provider", name: "Nope Ltd", country: "IE", providerType: "third_party" }) }));
  assert.equal(denied.status, 403);
});
