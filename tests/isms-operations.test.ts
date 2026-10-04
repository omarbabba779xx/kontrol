import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const ops = () => import("../src/lib/core/isms-operations");
const isms = () => import("../src/lib/core/isms");
const engine = () => import("../src/lib/core/compliance-engine");
const db = async () => (await import("../src/lib/db")).getDb();
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const clause = async (id: string) => (await (await isms()).ismsSnapshot(admin.tenantId)).clauses.find((item) => item.clause === id)!;
const auditor = { userId: "usr_auditor_int", tenantId: admin.tenantId, email: "audit@acme.example", name: "Internal Auditor", role: "auditor" as const };

test("a planned change says why, what it could affect and who is responsible; a revision nobody planned is flagged", async () => {
  const { saveRecord } = await ops();
  const { approveScope } = await isms();
  await assert.rejects(saveRecord(riskOwner, { kind: "change", title: "Move to a second cloud region", detail: {} }), /purpose of the change/);
  await assert.rejects(saveRecord(riskOwner, { kind: "change", title: "Move to a second cloud region", detail: { purpose: "Resilience" } }), /what the change could affect/);
  await assert.rejects(saveRecord(riskOwner, { kind: "change", title: "Move to a second cloud region", detail: { purpose: "Resilience", consequences: "Scope and supplier list change" } }), /someone responsible/);
  await assert.rejects(saveRecord(riskOwner, { kind: "change", title: "Bad status", status: "met", ownerId: riskOwner.userId, detail: { purpose: "x", consequences: "y" } }), /planned, done, cancelled/);
  const scope = "The ISMS covers the design, development and operation of the lending platform.";
  await approveScope(admin, { statement: scope });
  assert.equal((await clause("6.3")).status, "met", "the first version is not a change");
  await approveScope(admin, { statement: `${scope} And its second region.` });
  assert.equal((await clause("6.3")).status, "partial", "the scope was revised and no change was planned");
  const change = await saveRecord(riskOwner, { kind: "change", title: "Add a second cloud region to the scope", ownerId: riskOwner.userId, dueAt: iso(30), detail: { purpose: "Resilience", consequences: "Scope, supplier list and continuity plan change", resources: "Platform team, two sprints" } });
  assert.equal((await clause("6.3")).status, "met");
  await (await db()).system().run("UPDATE isms_records SET due_at = ? WHERE id = ?", iso(-2), change.id);
  assert.equal((await clause("6.3")).status, "partial", "a planned change past its date");
  await saveRecord(riskOwner, { id: change.id, kind: "change", title: "Add a second cloud region to the scope", status: "done", ownerId: riskOwner.userId, detail: { purpose: "Resilience", consequences: "Scope, supplier list and continuity plan change" } });
  assert.equal((await clause("6.3")).status, "met");
});

test("competence needs evidence when met and an action when there is a gap; communication answers to whom, when, by whom and how", async () => {
  const { saveRecord, operationsSnapshot } = await ops();
  assert.equal((await clause("7.2")).status, "missing");
  await assert.rejects(saveRecord(riskOwner, { kind: "competence", title: "Security lead", status: "met", detail: { competence: "ISO 27001 lead implementer" } }), /evidence of competence/);
  await assert.rejects(saveRecord(riskOwner, { kind: "competence", title: "On-call engineer", status: "gap", detail: { competence: "Incident response" } }), /action that closes the gap/);
  await saveRecord(riskOwner, { kind: "competence", title: "Security lead", status: "met", detail: { competence: "ISO 27001 lead implementer", evidence: "Certificate 2025, five years in role" } });
  const gap = await saveRecord(riskOwner, { kind: "competence", title: "On-call engineer", status: "gap", detail: { competence: "Incident response", action: "Tabletop exercise and runbook training this quarter" } });
  assert.equal((await clause("7.2")).status, "met", "a gap with an action is a managed gap");
  await (await db()).system().run("UPDATE isms_records SET updated_at = ? WHERE id = ?", iso(-400), gap.id);
  assert.equal((await clause("7.2")).status, "partial");

  assert.equal((await clause("7.4")).status, "missing");
  await assert.rejects(saveRecord(riskOwner, { kind: "communication", title: "Security bulletin", detail: { audience: "All staff", timing: "Monthly", channel: "Email" } }), /internal or external/);
  await assert.rejects(saveRecord(riskOwner, { kind: "communication", title: "Security bulletin", detail: { scope: "internal", audience: "All staff", timing: "Monthly" } }), /how this is communicated/);
  await assert.rejects(saveRecord(riskOwner, { kind: "communication", title: "Security bulletin", detail: { scope: "internal", audience: "All staff", timing: "Monthly", channel: "Email" } }), /who communicates/);
  await saveRecord(riskOwner, { kind: "communication", title: "Security bulletin", ownerId: riskOwner.userId, detail: { scope: "internal", audience: "All staff", timing: "Monthly", channel: "Email" } });
  assert.equal((await clause("7.4")).status, "partial", "nothing is planned towards the outside");
  await saveRecord(riskOwner, { kind: "communication", title: "Incident notice to customers", ownerId: riskOwner.userId, detail: { scope: "external", audience: "Affected customers", timing: "Within 72 hours of confirmation", channel: "Status page and email" } });
  assert.equal((await clause("7.4")).status, "met");
  assert.equal((await operationsSnapshot(admin.tenantId)).records.filter((record) => record.kind === "communication").length, 2);
});

test("an incident moves forward only, a personal-data incident carries the 72-hour deadline, and closing is a review", async () => {
  const { reportIncident, updateIncident, closeIncident, operationsSnapshot } = await ops();
  assert.equal((await clause("A5.24")).status, "missing", "no incident was ever recorded");
  await assert.rejects(reportIncident(riskOwner, { title: "Laptop lost", severity: "medium", detectedAt: iso(2) }), /in the future/);
  await assert.rejects(reportIncident(riskOwner, { title: "Laptop lost", severity: "medium", detectedAt: iso(-1), assetId: "asset_nope" }), /Asset not found/);
  const minor = await reportIncident(riskOwner, { title: "Laptop lost on a train", severity: "medium", detectedAt: iso(-1), ownerId: riskOwner.userId });
  assert.deepEqual([minor.ref, minor.notificationDue], ["INC-001", null]);
  assert.equal((await clause("A5.24")).status, "met");

  const detected = iso(-4);
  const breach = await reportIncident(riskOwner, { title: "Customer export sent to the wrong recipient", severity: "high", detectedAt: detected, personalData: true, assetId: "asset_repo_lending" });
  assert.equal(breach.notificationDue, new Date(Date.parse(detected) + 72 * 3_600_000).toISOString());
  assert.equal((await clause("A5.24")).status, "partial", "the 72 hours have passed and no notification decision is recorded");
  assert.equal((await operationsSnapshot(admin.tenantId)).incidents.find((item) => item.id === breach.id)?.notificationOverdue, true);

  await updateIncident(riskOwner, { id: breach.id, status: "contained" });
  await assert.rejects(updateIncident(riskOwner, { id: breach.id, status: "reported" }), /does not go back/);
  await assert.rejects(updateIncident(riskOwner, { id: minor.id, notified: { at: iso(0), note: "Authority informed" } }), /Only an incident involving personal data/);
  await assert.rejects(closeIncident(riskOwner, { id: breach.id, rootCause: "Autocomplete picked the wrong address.", lessons: "Exports need a second check." }), /Resolve the incident/);
  await updateIncident(riskOwner, { id: breach.id, status: "resolved" });
  await assert.rejects(closeIncident(riskOwner, { id: breach.id, rootCause: "Autocomplete picked the wrong address.", lessons: "Exports need a second check." }), /whether and when the authority was notified/);
  await updateIncident(riskOwner, { id: breach.id, notified: { at: iso(-2), note: "Supervisory authority notified, reference 2026-118" } });
  assert.equal((await clause("A5.24")).status, "met");
  await assert.rejects(closeIncident(riskOwner, { id: breach.id, rootCause: "Autocomplete picked the wrong address.", lessons: "Exports need a second check." }), /needs a nonconformity with a corrective action, or the reason/);

  const closed = await closeIncident(riskOwner, { id: breach.id, rootCause: "Autocomplete picked the wrong address.", lessons: "Exports of personal data need a second person.", nonconformity: { severity: "major", title: "Personal data exports are sent without a second check", ownerId: riskOwner.userId } });
  assert.match(closed.nonconformity?.ref ?? "", /^NC-\d{3}$/);
  const nc = await (await db()).system().get<{ source: string; incident_id: string }>("SELECT source, incident_id FROM isms_nonconformities WHERE id = ?", closed.nonconformity!.id);
  assert.deepEqual(nc, { source: "incident", incident_id: breach.id }, "the corrective action is tied to the incident that caused it");
  await assert.rejects(updateIncident(riskOwner, { id: breach.id, lessons: "Changed afterwards" }), /closed/);

  await updateIncident(riskOwner, { id: minor.id, status: "resolved" });
  const plain = await closeIncident(riskOwner, { id: minor.id, rootCause: "Device left unattended.", lessons: "Reminder sent; disk was encrypted." });
  assert.equal(plain.nonconformity, null, "a minor incident can close without a nonconformity");
});

test("an internal audit has a plan, an independent auditor, findings that become nonconformities, and a conclusion", async () => {
  const { planInternalAudit, raiseAuditFinding, concludeInternalAudit, operationsSnapshot } = await ops();
  const { setImplementation } = await engine();
  const sys = (await db()).system();
  await sys.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", auditor.userId, admin.tenantId, auditor.email, auditor.name, "auditor", iso(0));
  await setImplementation(admin, { ucCode: "UC-IAM-01", status: "implemented", maturity: 3, notes: "Attested", ownerId: riskOwner.userId });
  const plan = { name: "Internal audit: access management", objectives: "Confirm that joiners, movers and leavers are handled as the policy says.", criteria: "ISO/IEC 27001 A5.15 to A5.18; access control policy v3", periodStart: iso(-10), periodEnd: iso(-1), ucCodes: ["UC-IAM-01"] };
  await assert.rejects(planInternalAudit(admin, { ...plan, auditorId: riskOwner.userId }), /the auditor owns UC-IAM-01 and cannot audit their own work/);
  await assert.rejects(planInternalAudit(admin, { ...plan, auditorId: "usr_nobody" }), /Auditor not found/);
  await assert.rejects(planInternalAudit(admin, { ...plan, auditorId: auditor.userId, periodEnd: iso(-20) }), /period is invalid/);
  const audit = await planInternalAudit(admin, { ...plan, auditorId: auditor.userId });
  assert.equal((await clause("9.2")).status, "partial", "planned, not completed");

  await assert.rejects(raiseAuditFinding(admin, { auditId: audit.id, severity: "minor", title: "Not the auditor" }), /Only the auditor/);
  const finding = await raiseAuditFinding(auditor, { auditId: audit.id, severity: "major", title: "Three leavers still had active accounts", requirement: "iso27001:A5.18", ucCode: "UC-IAM-01" });
  const row = await sys.get<{ source: string; audit_id: string }>("SELECT source, audit_id FROM isms_nonconformities WHERE id = ?", finding.id);
  assert.deepEqual(row, { source: "internal_audit", audit_id: audit.id });
  await assert.rejects(concludeInternalAudit(admin, { auditId: audit.id, conclusion: "The process is not effective for leavers." }), /Only the auditor/);
  assert.deepEqual(await concludeInternalAudit(auditor, { auditId: audit.id, conclusion: "The joiner and mover process works; the leaver process is not effective. One major nonconformity raised." }), { id: audit.id, findings: 1 });
  await assert.rejects(raiseAuditFinding(auditor, { auditId: audit.id, severity: "minor", title: "After the fact" }), /concluded/);
  assert.equal((await clause("9.2")).status, "partial", "completed, but nothing is planned next");
  await planInternalAudit(admin, { ...plan, name: "Internal audit: supplier management", auditorId: auditor.userId, periodStart: iso(60), periodEnd: iso(75), ucCodes: ["UC-TPM-01"] });
  assert.equal((await clause("9.2")).status, "met");
  const view = (await operationsSnapshot(admin.tenantId)).internalAudits.find((item) => item.id === audit.id)!;
  assert.deepEqual([view.findings, view.controls, view.status], [1, ["UC-IAM-01"], "closed"]);
  assert.match(view.conclusion ?? "", /leaver process is not effective/);
});

test("clause 7.1, 7.5 and 8 follow the work: owners on everything open, documents in date, treatments planned and on time", async () => {
  const { createRisk, updateRisk } = await import("../src/lib/core/risk-register");
  const { upsertPolicy } = await engine();
  assert.equal((await clause("7.5")).status, "missing");
  await upsertPolicy(admin, { title: "Information security policy", version: "3.0", status: "approved", ucCodes: ["UC-GOV-01"], nextReview: iso(200) });
  assert.equal((await clause("7.5")).status, "met");
  assert.equal((await clause("5.2")).status, "met");

  const risk = await createRisk(riskOwner, { title: "Unpatched VPN appliance", category: "cyber", likelihood: 4, impact: 4 });
  assert.equal((await clause("7.1")).status, "partial", "an open risk with nobody assigned");
  await updateRisk(riskOwner, { id: risk.id, ownerId: riskOwner.userId, treatment: "mitigate" });
  assert.equal((await clause("8.1")).status, "partial", "a mitigation with no plan and no date");
  await updateRisk(riskOwner, { id: risk.id, treatmentPlan: "Replace the appliance.", targetDate: iso(45) });
  assert.equal((await clause("8.1")).status, "met");
  assert.equal((await clause("8.2")).status, "met");
  const sys = (await db()).system();
  await sys.run("UPDATE risk_items SET target_date = ? WHERE id = ?", iso(-5), risk.id);
  assert.equal((await clause("8.1")).status, "partial", "a treatment past its date");
  await sys.run("UPDATE risk_items SET updated_at = ? WHERE tenant_id = ?", iso(-400), admin.tenantId);
  assert.equal((await clause("8.2")).status, "partial", "the register has not been touched for a year");
});

test("the API takes the operating records and returns them with the system on one page", async () => {
  const { GET, POST } = await import("../src/app/api/isms/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const call = async (role: string, body?: unknown) => {
    const headers = { authorization: `Bearer ${await issueSessionToken({ ...admin, role } as typeof admin)}`, "content-type": "application/json" };
    return body === undefined ? GET(new Request("http://localhost/api/isms", { headers })) : POST(new Request("http://localhost/api/isms", { method: "POST", headers, body: JSON.stringify(body) }));
  };
  assert.equal((await call("viewer", { action: "report_incident", title: "Not allowed", severity: "low", detectedAt: iso(-1) })).status, 403);
  assert.equal((await call("risk_owner", { action: "report_incident", title: "Phishing email reported by staff", severity: "low", detectedAt: iso(-1) })).status, 201);
  assert.equal((await call("risk_owner", { action: "save_record", kind: "competence", title: "DPO", status: "met", detail: { competence: "GDPR", evidence: "CIPP/E" } })).status, 201);
  const page = (await (await call("viewer")).json()) as { clauses: unknown[]; incidents: unknown[]; records: unknown[]; internalAudits: Array<{ id: string }> };
  assert.equal(page.clauses.length, 21);
  assert.ok(page.incidents.length >= 3 && page.records.length >= 5);
  assert.equal(new Set(page.internalAudits.map((item) => item.id)).size, page.internalAudits.length, "an audit appears once");
});
