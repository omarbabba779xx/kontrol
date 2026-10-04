import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const isms = () => import("../src/lib/core/isms");
const engine = () => import("../src/lib/core/compliance-engine");
const db = async () => (await import("../src/lib/db")).getDb();
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const clause = async (id: string) => (await (await isms()).ismsSnapshot(admin.tenantId)).clauses.find((item) => item.clause === id)!;

test("an empty management system says what is missing, clause by clause, and what to do next", async () => {
  const { ismsSnapshot } = await isms();
  const snapshot = await ismsSnapshot(admin.tenantId);
  assert.deepEqual(snapshot.clauses.map((item) => item.clause), ["4.1", "4.2", "4.3", "5.2", "5.3", "6.1.2", "6.1.3", "6.2", "6.3", "7.1", "7.2", "7.3", "7.4", "7.5", "8.1", "8.2", "9.1", "9.2", "9.3", "10.2", "A5.24"]);
  for (const id of ["4.1", "4.2", "4.3", "6.2", "9.3", "10.2"]) assert.equal(snapshot.clauses.find((item) => item.clause === id)?.status, "missing", id);
  assert.ok(snapshot.clauses.every((item) => item.status === "met" || item.next), "every clause that is not met names the next step");
  assert.equal(snapshot.summary.total, 21);
  assert.equal(snapshot.clauses.find((item) => item.clause === "6.3")?.status, "met", "nothing has been changed yet, so there is no unplanned change");
  assert.ok(snapshot.summary.next.length > 0);
});

test("context and interested parties: issues of both kinds, and a requirement for every party", async () => {
  const { saveContextItem, removeContextItem } = await isms();
  await saveContextItem(riskOwner, { kind: "internal_issue", title: "Rapid growth of the engineering team" });
  assert.equal((await clause("4.1")).status, "partial", "only one kind of issue is recorded");
  const external = await saveContextItem(riskOwner, { kind: "external_issue", title: "DORA applies from January 2025", detail: "Financial entity customers flow the obligations down." });
  assert.equal((await clause("4.1")).status, "met");
  await assert.rejects(saveContextItem(riskOwner, { kind: "interested_party", title: "Customers" }), /what this interested party requires/);
  await saveContextItem(riskOwner, { kind: "interested_party", title: "Customers", requirement: "Contractual security clauses and incident notice within 72 hours" });
  assert.equal((await clause("4.2")).status, "met");
  await saveContextItem(riskOwner, { id: external.id, kind: "external_issue", title: "DORA and NIS2 apply", detail: "Updated" });
  await assert.rejects(saveContextItem(riskOwner, { id: "ctx_nope", kind: "external_issue", title: "Nothing" }), /not found/);

  const sys = (await db()).system();
  await sys.run("UPDATE isms_context SET updated_at = ? WHERE id = ?", iso(-400), external.id);
  assert.equal((await clause("4.1")).status, "partial", "an issue nobody has looked at for a year is not current");
  await removeContextItem(riskOwner, { id: external.id });
  await saveContextItem(riskOwner, { kind: "external_issue", title: "Regulatory change" });
  assert.equal((await clause("4.1")).status, "met");
});

test("the scope is a management decision, versioned, and goes stale after a year", async () => {
  const { approveScope, ismsSnapshot } = await isms();
  const statement = "The ISMS covers the design, development and operation of the lending platform, its staff and its suppliers.";
  await assert.rejects(approveScope(riskOwner, { statement }), /Only an administrator/);
  assert.deepEqual(await approveScope(admin, { statement, exclusions: "Physical security of the co-working space is the landlord's." }), { version: 1 });
  assert.deepEqual(await approveScope(admin, { statement: `${statement} Version two.` }), { version: 2 });
  assert.equal((await ismsSnapshot(admin.tenantId)).scope?.version, 2);
  assert.equal((await clause("4.3")).status, "met");
  await (await db()).system().run("UPDATE isms_scope SET approved_at = ? WHERE tenant_id = ?", iso(-400), admin.tenantId);
  assert.equal((await clause("4.3")).status, "partial");
  await approveScope(admin, { statement });
});

test("objectives are measurable, owned and dated; a measurement moves them, and one past its date without a result is flagged", async () => {
  const { saveObjective, measureObjective, ismsSnapshot } = await isms();
  await assert.rejects(saveObjective(riskOwner, { title: "Patch quickly", measure: "Median days to patch critical vulnerabilities", target: "7 days", dueAt: "not-a-date" }), /invalid/);
  await assert.rejects(saveObjective(riskOwner, { title: "Patch quickly", measure: "Median days", target: "7", dueAt: iso(90), ownerId: "usr_nobody" }), /Owner not found/);
  const objective = await saveObjective(riskOwner, { title: "Patch critical vulnerabilities quickly", measure: "Median days to patch critical vulnerabilities", target: "7 days or fewer", dueAt: iso(90), ownerId: riskOwner.userId });
  assert.equal((await clause("6.2")).status, "met");
  assert.equal((await clause("9.1")).status !== "met", true, "nothing has been measured yet");
  const measured = await measureObjective(riskOwner, { id: objective.id, value: "11 days", status: "at_risk" });
  assert.ok(measured.measuredAt);
  const stored = (await ismsSnapshot(admin.tenantId)).objectives.find((item) => item.id === objective.id)!;
  assert.deepEqual([stored.current_value, stored.status, stored.overdue], ["11 days", "at_risk", false]);
  await (await db()).system().run("UPDATE isms_objectives SET due_at = ? WHERE id = ?", iso(-1), objective.id);
  assert.equal((await clause("6.2")).status, "partial");
  assert.equal((await ismsSnapshot(admin.tenantId)).objectives[0].overdue, true);
  await measureObjective(riskOwner, { id: objective.id, value: "6 days", status: "achieved" });
  assert.equal((await clause("6.2")).status, "met", "an objective with a recorded result is no longer overdue");
});

test("the risk clauses follow the register: approved criteria, assessed risks, a decision for everything above the appetite", async () => {
  const { setRiskMethod, createRisk, updateRisk } = await import("../src/lib/core/risk-register");
  const { adoptFramework } = await engine();
  assert.equal((await clause("6.1.2")).status, "missing", "default criteria nobody approved");
  await setRiskMethod(admin, { method: "iso27005", thresholds: { medium: 5, high: 10, critical: 17 }, appetite: "medium", maxAcceptanceDays: 365 });
  assert.equal((await clause("6.1.2")).status, "partial", "approved, but no risk assessed");
  const risk = await createRisk(riskOwner, { title: "Loss of the production database", category: "resilience", likelihood: 3, impact: 5, ownerId: riskOwner.userId, controls: ["UC-DAT-05"] });
  assert.equal((await clause("6.1.2")).status, "met");
  assert.equal((await clause("6.1.3")).status, "missing", "no framework adopted, so no statement of applicability");
  await adoptFramework(admin, { frameworkId: "iso27001", scope: "Lending platform" });
  assert.equal((await clause("6.1.3")).status, "partial", "a high risk with no treatment decision");
  await updateRisk(riskOwner, { id: risk.id, treatment: "mitigate", treatmentPlan: "Cross-region replicas and a quarterly restore test." });
  assert.equal((await clause("6.1.3")).status, "met");
});

test("a management review freezes its inputs, is approved by management, and its decisions become tracked actions", async () => {
  const { prepareReview, approveReview, ismsSnapshot } = await isms();
  await assert.rejects(prepareReview(riskOwner, { heldAt: "soon", attendees: "CEO, CISO" }), /invalid/);
  const prepared = await prepareReview(riskOwner, { heldAt: iso(-1), attendees: "CEO, CISO, Head of Engineering" });
  assert.equal(prepared.inputs.previousReview, null);
  assert.equal(prepared.inputs.risk.open, 1);
  assert.equal(prepared.inputs.risk.appetite, "medium");
  assert.ok(prepared.inputs.objectives.length === 1 && prepared.inputs.monitoring.length === 1 && prepared.inputs.clauses.length === 21);
  assert.deepEqual(prepared.inputs.incidents, { sinceLastReview: 0, open: 0, seriousOpen: 0 });
  assert.ok(prepared.inputs.contextChanges.length >= 2, "with no earlier review, every context item is a change to consider");
  assert.equal((await clause("9.3")).status, "partial", "drafted, not approved");

  await assert.rejects(approveReview(riskOwner, { id: prepared.id, decisions: "Approve the patching objective and fund the restore tests." }), /Only an administrator/);
  const approved = await approveReview(admin, { id: prepared.id, decisions: "Approve the patching objective and fund the restore tests.", actions: [{ title: "Fund quarterly restore tests", assigneeId: riskOwner.userId, dueAt: iso(60) }] });
  assert.equal(approved.tasks.length, 1);
  await assert.rejects(approveReview(admin, { id: prepared.id, decisions: "Approve the patching objective a second time." }), /already approved/);
  assert.equal((await clause("9.3")).status, "met");

  // The posture changes afterwards; the record of what management saw does not.
  const { createRisk } = await import("../src/lib/core/risk-register");
  await createRisk(riskOwner, { title: "A later risk", category: "cyber", likelihood: 2, impact: 2 });
  const stored = (await ismsSnapshot(admin.tenantId)).reviews.find((item) => item.id === prepared.id)!;
  assert.equal((stored.inputs as { risk: { open: number } }).risk.open, 1);
  const next = await prepareReview(riskOwner, { heldAt: iso(0), attendees: "CEO, CISO" });
  assert.deepEqual(next.inputs.previousReview && { actions: next.inputs.previousReview.actions, actionsDone: next.inputs.previousReview.actionsDone }, { actions: 1, actionsDone: 0 }, "the next review reports on the actions of the previous one");
  assert.equal(next.inputs.risk.open, 2);
});

test("a nonconformity needs a cause and an action, and a second person decides whether the action worked", async () => {
  const { raiseNonconformity, planCorrectiveAction, markImplemented, verifyAndClose, ismsSnapshot } = await isms();
  assert.equal((await clause("10.2")).status, "missing", "the process has never been exercised");
  await assert.rejects(raiseNonconformity(riskOwner, { source: "internal_audit", severity: "major", title: "x y z", ucCode: "UC-NOPE-01" }), /not found/);
  const nc = await raiseNonconformity(riskOwner, { source: "internal_audit", severity: "major", title: "Leavers kept access for 30 days", requirement: "iso27001:A5.18", ucCode: "UC-IAM-01", correction: "Accounts disabled on the day of the finding" });
  assert.equal(nc.ref, "NC-001");
  assert.equal((await clause("10.2")).status, "partial", "open, with no corrective action");
  await assert.rejects(markImplemented(riskOwner, { id: nc.id, note: "Done already, trust me." }), /Plan the corrective action/);
  await planCorrectiveAction(riskOwner, { id: nc.id, rootCause: "Offboarding relies on a manual ticket that HR does not always raise.", correctiveAction: "Drive deprovisioning from the HR system's termination event.", ownerId: riskOwner.userId, dueAt: iso(30) });
  assert.equal((await clause("10.2")).status, "met", "planned and on time");
  await assert.rejects(verifyAndClose(admin, { id: nc.id, effective: true, note: "Looks fine to me." }), /must be implemented/);
  await markImplemented(riskOwner, { id: nc.id, note: "Automation live since the first of the month." });
  await assert.rejects(verifyAndClose(riskOwner, { id: nc.id, effective: true, note: "I checked my own work." }), /owner of a corrective action cannot verify it/);

  assert.deepEqual(await verifyAndClose(admin, { id: nc.id, effective: false, note: "Two of five sampled leavers still had VPN access." }), { id: nc.id, status: "open" });
  assert.equal((await ismsSnapshot(admin.tenantId)).nonconformities[0].status, "open", "an ineffective action reopens the nonconformity");
  await planCorrectiveAction(riskOwner, { id: nc.id, rootCause: "VPN accounts are not in the identity provider.", correctiveAction: "Federate the VPN with the identity provider.", ownerId: riskOwner.userId, dueAt: iso(20) });
  await markImplemented(riskOwner, { id: nc.id, note: "VPN federated; local accounts removed." });
  assert.deepEqual(await verifyAndClose(admin, { id: nc.id, effective: true, note: "Sampled eight leavers: all access removed within the day." }), { id: nc.id, status: "closed" });
  await assert.rejects(planCorrectiveAction(riskOwner, { id: nc.id, rootCause: "Reopening a closed item", correctiveAction: "Should not be possible", ownerId: riskOwner.userId, dueAt: iso(5) }), /closed/);

  const late = await raiseNonconformity(riskOwner, { source: "incident", severity: "minor", title: "Backup job failed silently" });
  await planCorrectiveAction(riskOwner, { id: late.id, rootCause: "No alert on backup failure.", correctiveAction: "Alert on any failed backup job.", ownerId: riskOwner.userId, dueAt: iso(10) });
  await (await db()).system().run("UPDATE isms_nonconformities SET due_at = ? WHERE id = ?", iso(-3), late.id);
  assert.equal((await clause("10.2")).status, "partial");
  assert.equal((await ismsSnapshot(admin.tenantId)).nonconformities.find((item) => item.id === late.id)?.overdue, true);
});

test("records that exist, are approved and are current back the governance controls they stand for, and stop when they lapse", async () => {
  const { setImplementation, complianceSnapshot } = await engine();
  for (const code of ["UC-GOV-03", "UC-GOV-04", "UC-GOV-06"]) await setImplementation(admin, { ucCode: code, status: "implemented", maturity: 3, notes: "Attested" });
  const verification = async (code: string) => (await complianceSnapshot(admin.tenantId)).controls.find((control) => control.code === code)!.verification;
  assert.equal(await verification("UC-GOV-03"), "documented", "context, parties and scope are all on record");
  assert.equal(await verification("UC-GOV-04"), "documented", "approved criteria, assessed risks and treatment decisions");
  assert.equal(await verification("UC-GOV-06"), "unverified", "no internal audit was completed: the claim stays a claim");

  const sys = (await db()).system();
  await sys.run("INSERT INTO audit_engagements (id,tenant_id,name,framework_id,kind,scope,period_start,period_end,auditor_org,status,created_by,created_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", "eng_internal", admin.tenantId, "Internal audit 2026", "iso27001", "internal", "ISMS", iso(-60), iso(-30), "Internal", "closed", admin.userId, iso(-60), iso(-20));
  assert.equal((await clause("9.2")).status, "partial", "one audit is not a programme: nothing is planned next");
  await sys.run("INSERT INTO audit_engagements (id,tenant_id,name,framework_id,kind,scope,period_start,period_end,auditor_org,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", "eng_next", admin.tenantId, "Internal audit 2027", "iso27001", "internal", "ISMS", iso(200), iso(230), "Internal", "planning", admin.userId, iso(0));
  assert.equal((await clause("9.2")).status, "met");
  assert.equal(await verification("UC-GOV-06"), "documented");

  await sys.run("UPDATE isms_scope SET approved_at = ? WHERE tenant_id = ?", iso(-400), admin.tenantId);
  assert.equal(await verification("UC-GOV-03"), "unverified", "a scope nobody has approved for a year no longer backs the control");
});

test("the API reads for everyone signed in and writes for those who manage audits; management decisions stay with the administrator", async () => {
  const { GET, POST } = await import("../src/app/api/isms/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const call = async (actor: { role: string }, body?: unknown) => {
    const token = await issueSessionToken({ ...admin, ...actor } as typeof admin);
    return body === undefined ? GET(new Request("http://localhost/api/isms", { headers: { authorization: `Bearer ${token}` } })) : POST(new Request("http://localhost/api/isms", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  };
  assert.equal((await call({ role: "viewer" })).status, 200);
  assert.equal((await call({ role: "viewer" }, { action: "save_context", kind: "internal_issue", title: "Not allowed" })).status, 403);
  assert.equal((await call({ role: "risk_owner" }, { action: "save_context", kind: "internal_issue", title: "Key person dependency" })).status, 201);
  assert.equal((await call({ role: "risk_owner" }, { action: "approve_scope", statement: "A scope statement that is long enough to be accepted." })).status, 403);
  assert.equal((await call({ role: "admin" }, { action: "approve_scope", statement: "A scope statement that is long enough to be accepted." })).status, 200);
  assert.equal((await call({ role: "admin" }, { action: "approve_scope", statement: "short" })).status, 400);
});
