// Third step of the Hydria example dossier: the management system in operation. Signed reports from the learning and HR systems,
// measurements of the objectives, one incident handled to its lessons, two nonconformities (one closed by a second person, one
// open and on time), the internal audit programme, and the first management review.
//
//   KONTROL_INGEST_SECRET=<the value in .env.local> node examples/hydria/load-operation.mjs     (after load-risk.mjs)
//
// Hydria is fictional, and so is the calendar: a real management system takes months to produce these records.

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE = process.env.KONTROL_URL ?? "http://localhost:3000";
const TENANT = process.env.KONTROL_TENANT ?? "tenant_acme";
const iso = (date) => new Date(`${date}T09:00:00Z`).toISOString();
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const inDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString();

async function call(path, body, token, extraHeaders) {
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders };
  const raw = typeof body === "string" ? body : body ? JSON.stringify(body) : undefined;
  const response = await fetch(`${BASE}${path}`, raw ? { method: "POST", headers, body: raw } : { headers });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} ${body?.action ?? ""} -> ${response.status} ${JSON.stringify(data)}`);
  return data;
}

const before = await call("/api/isms");
if (before.incidents.length || before.reviews.length) {
  console.log("The operation records are already loaded. Nothing done.");
  process.exit(0);
}

const { users } = await call("/api/users");
const id = (label) => users.find((user) => user.name.includes(label))?.id ?? (() => { throw new Error(`Run the earlier steps first: nobody matches "${label}"`); })();
const people = { ciso: id("CISO"), soc: id("SOC manager"), dpo: id("Data protection"), itops: id("IT operations"), audit: id("Internal auditor") };
const token = {};
for (const key of ["ciso", "soc", "itops"]) token[key] = (await call("/api/session/demo", { userId: people[key] })).token;
const as = (who) => (body) => call("/api/isms", body, token[who]);
const admin = (body) => call("/api/isms", body);

// ---------------------------------------------------------------- 7.3 and 9.1: signed reports from the learning and HR systems
const master = process.env.KONTROL_INGEST_SECRET ?? readFileSync(".env.local", "utf8").match(/^KONTROL_INGEST_SECRET=(.+)$/m)?.[1]?.trim();
if (!master) throw new Error("Set KONTROL_INGEST_SECRET (the same value as the server) to sign the HR and learning reports");
const secret = createHmac("sha256", master).update(`ingest:${TENANT}`).digest("hex");
async function report(path, payload) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  return call(path, body, null, { "X-Kontrol-Tenant": TENANT, "X-Kontrol-Timestamp": timestamp, "X-Kontrol-Signature": signature });
}
await call("/api/compliance", { action: "install_pack" });
await report("/api/ingest/lms", { asOf: daysAgo(2), training: { enrolled: 618, completed: 596 } });
// Two leavers still had an account after their departure: the HR report says so, and the control fails.
await report("/api/ingest/hris", { asOf: daysAgo(2), hr: { overdueDeprovisioning: 2, unscreenedActiveStarters: 0 } });
await call("/api/compliance", { action: "link_evidence" });

// ---------------------------------------------------------------- 9.1: first measurement of each objective, by its owner's side
const objective = (text) => before.objectives.find((item) => item.title.includes(text))?.id ?? (() => { throw new Error(`Objective not found: ${text}`); })();
for (const [title, value, status, who] of [
  ["Contain serious incidents", "3 h 10 min (one serious incident this quarter)", "on_track", "soc"],
  ["person in charge of AI", "100% on a sample of 40 high-severity alerts", "on_track", "soc"],
  ["phishing", "7% in the September simulation", "at_risk", "ciso"],
  ["critical suppliers", "0 of 3 assessed", "at_risk", "itops"],
  ["personal-data incidents", "1 of 1 assessed within 72 hours", "on_track", "ciso"],
]) await as(who)({ action: "measure_objective", id: objective(title), value, status });

// ---------------------------------------------------------------- A.5.24 to A.5.27: one incident, handled to its lessons
const incident = await as("soc")({
  action: "report_incident",
  title: "Mailbox of a billing clerk accessed after a phishing email",
  description: "A clerk entered their password on a fake supplier-invoice page. The SIEM raised a sign-in from an unusual country 12 minutes later. The mailbox held 14 emails from customers.",
  severity: "high",
  detectedAt: daysAgo(18),
  personalData: true,
  ownerId: people.soc,
});
const incidentId = incident.id ?? incident.incident?.id;
await as("soc")({ action: "update_incident", id: incidentId, status: "contained", notified: { at: daysAgo(16), note: "Assessed with the data protection officer within 48 hours; the notification decision was taken as Legal advised and is on file." } });
await as("soc")({ action: "update_incident", id: incidentId, status: "resolved" });
await as("soc")({
  action: "close_incident",
  id: incidentId,
  rootCause: "The account had no second factor: MFA covered administrators and remote access only. The password alone was enough to open the mailbox.",
  lessons: "Detection worked: the unusual sign-in was alerted in 12 minutes and the session revoked in 3 hours 10 minutes. Prevention did not: one stolen password should not open a mailbox.",
  nonconformity: { severity: "minor", title: "MFA is not enforced on every staff account", ownerId: people.itops },
});

// ---------------------------------------------------------------- 10.2: the corrective action of that nonconformity, open and on time
const fromIncident = (await call("/api/isms")).nonconformities.find((item) => item.title.includes("MFA"));
await as("ciso")({
  action: "plan_corrective_action",
  id: fromIncident.id,
  rootCause: "MFA was rolled out by population, starting with the most privileged, and the roll-out stopped before reaching ordinary accounts. Nobody owned the remaining scope.",
  correction: "The clerk's password was reset and the mailbox rules checked the same day.",
  correctiveAction: "Enforce MFA on every account in the directory and block legacy authentication, with the IT operations manager accountable for the full scope.",
  ownerId: people.itops,
  dueAt: iso("2026-12-31"),
});

// ---------------------------------------------------------------- 10.2: a second nonconformity, closed by someone other than its owner
const restore = await as("ciso")({
  action: "raise_nonconformity",
  source: "monitoring",
  severity: "minor",
  title: "Restoration of the customer database not tested for over a year",
  description: "The backup procedure asks for a restoration test twice a year. The last one on record is fourteen months old.",
  requirement: "ISO/IEC 27001 A.8.13",
  ucCode: "UC-DAT-05",
  ownerId: people.itops,
  dueAt: inDays(20),
});
const restoreId = restore.id ?? restore.nonconformity?.id;
await as("ciso")({
  action: "plan_corrective_action",
  id: restoreId,
  rootCause: "The test was a line in a procedure with no date and no owner, so nothing prompted it.",
  correctiveAction: "Schedule the restoration test twice a year as a task assigned to IT operations, and report its result in the management review.",
  ownerId: people.itops,
  dueAt: inDays(20),
});
await as("itops")({ action: "mark_implemented", id: restoreId, note: "Restoration tested last week: the customer database was restored to a clean server in 3 hours 40 minutes. The next test is scheduled." });
await as("ciso")({ action: "verify_and_close", id: restoreId, effective: true, note: "Restoration report reviewed, and the recurring task exists with an owner and a date." });

// ---------------------------------------------------------------- 9.2: the audit programme. The first audit waits for the auditor's training.
await as("ciso")({
  action: "plan_internal_audit",
  name: "Internal audit 2027-1: access management and incident handling",
  objectives: "Check that access to the customer information system is granted, reviewed and removed as the policy requires, and that incidents are handled as the procedure describes.",
  criteria: "ISO/IEC 27001:2022 clauses 6 to 10 and Annex A 5.15 to 5.18, 5.24 to 5.27; Hydria's information security policy and incident procedure.",
  scope: "Customer information system and SOC service, records of the last six months.",
  auditorId: people.audit,
  periodStart: iso("2027-02-08"),
  periodEnd: iso("2027-02-19"),
  ucCodes: ["UC-IAM-01", "UC-IAM-04", "UC-INC-01"],
});

// ---------------------------------------------------------------- 9.3: the first management review, approved by the administrator
const review = await as("ciso")({ action: "prepare_review", heldAt: new Date().toISOString(), attendees: "Executive committee; CISO; SOC manager; data protection officer; IT operations manager" });
const reviewId = review.id ?? review.review?.id;
await admin({
  action: "approve_review",
  id: reviewId,
  decisions:
    "The committee notes eleven risks above the appetite, all with a treatment plan, and one accepted for six months. It confirms the appetite at medium. It asks for MFA on every account before the end of the year, a security assessment of the billing vendor in the first quarter, and a second node for the detection platform in the 2027 budget. The first internal audit is confirmed for February, once the auditor is trained.",
  actions: [
    { title: "Report MFA coverage of all accounts to the committee", assigneeId: people.itops, dueAt: iso("2027-01-15") },
    { title: "Complete the security assessment of the billing vendor", assigneeId: people.itops, dueAt: iso("2027-03-31") },
    { title: "Budget a second node for the detection platform", assigneeId: people.soc, dueAt: iso("2026-12-15") },
  ],
});

// ---------------------------------------------------------------- the claims follow what was done
for (const [ucCode, status, maturity, owner, notes] of [
  ["UC-GOV-05", "implemented", 2, "ciso", "Objectives measured for the first time and a management review held and approved; one cycle only so far."],
  ["UC-GOV-07", "implemented", 2, "ciso", "Two nonconformities handled: one closed after verification by a second person, one open with a corrective action on time."],
]) await call("/api/compliance", { action: "set_implementation", ucCode, status, maturity, ownerId: people[owner], notes });

const after = await call("/api/isms");
console.log(`Clause checklist: ${JSON.stringify(after.summary)}`.slice(0, 160));
for (const clause of after.clauses) console.log(`  ${clause.status.padEnd(8)} ${clause.clause.padEnd(8)} ${clause.title}${clause.status === "met" ? "" : ` -> ${clause.detail}`}`);
