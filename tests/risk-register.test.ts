import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const rr = () => import("../src/lib/core/risk-register");
const rating = () => import("../src/lib/core/risk-rating");
const engine = () => import("../src/lib/core/compliance-engine");
const db = async () => (await import("../src/lib/db")).getDb();
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const base = { title: "Ransomware on the claims platform", category: "cyber" as const, likelihood: 4, impact: 5 };

test("ratings follow a 5x5 matrix and residual risk never claims more than 80% reduction", async () => {
  const { bandOf, residual, heatMap } = await rating();
  assert.deepEqual([1, 4, 5, 9, 10, 16, 17, 25].map(bandOf), ["low", "low", "medium", "medium", "high", "high", "critical", "critical"]);
  const none = residual({ likelihood: 4, impact: 5, controls: [] });
  assert.equal(none.likelihood, 4, "no linked control, no reduction");
  const full = residual({ likelihood: 5, impact: 5, controls: [{ code: "a", weight: 1, backed: true }] });
  assert.equal(full.reduction, 0.8);
  assert.equal(full.likelihood, 1);
  const unbacked = residual({ likelihood: 5, impact: 5, controls: [{ code: "a", weight: 1, backed: false }] });
  assert.ok(unbacked.reduction < full.reduction, "an attestation alone is worth less than backed evidence");
  assert.equal(unbacked.impact, 5, "controls do not reduce impact");
  const notApplicable = residual({ likelihood: 3, impact: 3, controls: [{ code: "a", weight: null, backed: true }] });
  assert.equal(notApplicable.controlsConsidered, 0);
  assert.equal(residual({ likelihood: 4, impact: 4, controls: [{ code: "a", weight: 0.15, backed: true }] }).likelihood, 4, "rounded up, never flattered");
  const grid = heatMap([{ likelihood: 1, impact: 1 }, { likelihood: 1, impact: 1 }, { likelihood: 5, impact: 4 }]);
  assert.equal(grid[0][0], 2);
  assert.equal(grid[4][3], 1);
});

test("a risk validates its rating, owner and controls", async () => {
  const { createRisk } = await rr();
  await assert.rejects(createRisk(admin, { ...base, likelihood: 6 }), /between 1 and 5/);
  await assert.rejects(createRisk(admin, { ...base, impact: 0 }), /between 1 and 5/);
  await assert.rejects(createRisk(admin, { ...base, ownerId: "usr_nobody" }), /Owner not found/);
  await assert.rejects(createRisk(admin, { ...base, controls: ["UC-NOPE-99"] }), /not found/);
  const made = await createRisk(admin, { ...base, ownerId: riskOwner.userId, controls: ["UC-OPS-02", "UC-DAT-05"] });
  assert.equal(made.ref, "RSK-001");
});

test("residual risk follows the live posture of the linked controls", async () => {
  const { riskSnapshot } = await rr();
  const { setImplementation } = await engine();
  const find = async () => (await riskSnapshot(admin.tenantId)).risks.find((risk) => risk.ref === "RSK-001")!;
  const before = await find();
  assert.equal(before.inherent.score, 20);
  assert.equal(before.residual.likelihood, 4, "controls not started: nothing is credited");

  await setImplementation(admin, { ucCode: "UC-OPS-02", status: "implemented", maturity: 4, notes: "Patching process in place" });
  await setImplementation(admin, { ucCode: "UC-DAT-05", status: "implemented", maturity: 4, notes: "Backups tested" });
  const after = await find();
  assert.ok(after.residual.reduction > 0 && after.residual.reduction < 0.8, "attested only: credited at a discount");
  assert.ok(after.residual.score < before.residual.score);

  await setImplementation(admin, { ucCode: "UC-OPS-02", status: "not_started", maturity: 0, notes: "Rolled back" });
  const worse = await find();
  assert.ok(worse.residual.reduction < after.residual.reduction, "a control that lapses raises the residual risk again");
});

let third = "";
const thirdUser = async () => third || (third = (await (await import("../src/lib/core/admin")).inviteUser(admin, { email: "nora@acme.example", name: "Nora Owner", role: "control_owner" })).id);
const byRef = async (ref: string) => (await (await rr()).riskSnapshot(admin.tenantId)).risks.find((risk) => risk.ref === ref)!;

test("accepting a risk needs another person, an owner, an expiry and a rating below critical", async () => {
  const { createRisk, acceptRisk, updateRisk } = await rr();
  const critical = await createRisk(admin, { title: "Unpatched edge appliance", category: "cyber", likelihood: 5, impact: 5, ownerId: riskOwner.userId });
  const criticalId = (await byRef(critical.ref)).id;
  await assert.rejects(acceptRisk(riskOwner, { id: criticalId, days: 30, note: "Owner accepting own risk" }), /Separation of duties: the owner/);
  await assert.rejects(acceptRisk(admin, { id: criticalId, days: 30, note: "Creator accepting own risk" }), /Separation of duties: the person who recorded/);
  await assert.rejects(updateRisk(admin, { id: criticalId, treatment: "accept" }), /acceptance decision/);

  const other = await createRisk(riskOwner, { title: "Legacy reporting tool unsupported", category: "operational", likelihood: 2, impact: 3, ownerId: await thirdUser() });
  const otherId = (await byRef(other.ref)).id;
  await assert.rejects(acceptRisk(admin, { id: otherId, days: 400, note: "Far too long" }), /between 1 and 365/);
  const unowned = await createRisk(riskOwner, { title: "Shared mailbox without owner", category: "operational", likelihood: 2, impact: 2 });
  await assert.rejects(acceptRisk(admin, { id: (await byRef(unowned.ref)).id, days: 30, note: "No owner assigned" }), /Assign an owner/);

  // A critical residual risk cannot be accepted by anyone: it must be treated or reduced first.
  const hot = await createRisk(riskOwner, { title: "Single point of failure in payments", category: "resilience", likelihood: 5, impact: 5, ownerId: await thirdUser() });
  await assert.rejects(acceptRisk(admin, { id: (await byRef(hot.ref)).id, days: 30, note: "Wishful thinking" }), /critical residual risk/);

  await acceptRisk(admin, { id: otherId, days: 30, note: "Fine until the replacement ships" });
  await assert.rejects(acceptRisk(admin, { id: otherId, days: 30, note: "Again please" }), /already accepted/);
  const accepted = await byRef(other.ref);
  assert.deepEqual([accepted.status, accepted.accepted_by], ["accepted", admin.userId]);

  // Changing the rating voids the acceptance: it was granted for a risk that no longer exists as described.
  assert.equal((await updateRisk(admin, { id: otherId, likelihood: 4 })).acceptanceVoided, true);
  const reopened = await byRef(other.ref);
  assert.deepEqual([reopened.status, reopened.treatment, reopened.accepted_by], ["identified", "undecided", null]);
});

test("a lapsed acceptance counts as untreated again and raises an alert", async () => {
  const { riskSnapshot, acceptRisk, updateRisk } = await rr();
  const { scanAndNotify } = await import("../src/lib/core/alerts");
  const { createChannel } = await import("../src/lib/core/notifications");
  await createChannel(admin, { kind: "slack", name: "Risk alerts", config: { webhookUrl: "https://hooks.slack.com/services/T/A/SK" }, events: ["*"], minSeverity: "low" });
  const target = await byRef("RSK-003"); // owned by a third person, recorded by the risk owner; reopened by the previous test
  await updateRisk(admin, { id: target.id, likelihood: 2 });
  await acceptRisk(admin, { id: target.id, days: 10, note: "Accepted for the migration window" });
  const sys = (await db()).system();
  await scanAndNotify(admin.tenantId);
  assert.equal((await sys.all("SELECT id FROM notifications WHERE event_type = 'risk.acceptance_expiring'")).length, 1);

  await sys.run("UPDATE risk_items SET accepted_until = ? WHERE id = ?", iso(-1), target.id);
  const lapsed = (await riskSnapshot(admin.tenantId)).risks.find((risk) => risk.id === target.id)!;
  assert.equal(lapsed.acceptanceExpired, true);
  assert.equal(lapsed.effectiveStatus, "identified");
  await scanAndNotify(admin.tenantId);
  const alerts = await sys.all<{ title: string }>("SELECT title FROM notifications WHERE event_type = 'risk.acceptance_expired'");
  assert.equal(alerts.length, 1);
  await scanAndNotify(admin.tenantId);
  assert.equal((await sys.all("SELECT id FROM notifications WHERE event_type = 'risk.acceptance_expired'")).length, 1, "one alert per lapse, not one per scan");
  // A lapsed acceptance can be renewed.
  await acceptRisk(admin, { id: target.id, days: 30, note: "Renewed after review of the migration" });
});

test("a risk is quantified with the FAIR simulation, deterministically, and shown as a range", async () => {
  const { quantifyRisk, riskSnapshot } = await rr();
  const snapshot = await riskSnapshot(admin.tenantId);
  const id = snapshot.risks[0].id;
  const scenario = { name: "Ransomware scenario", materialDecision: true, sensitiveData: true, humanReview: false, thirdPartyModel: false, crossBorder: false, annualEvents: 80_000, iterations: 2_000 };
  const first = await quantifyRisk(admin, { id, scenario });
  const second = await quantifyRisk(admin, { id, scenario });
  assert.deepEqual(first.annualizedLoss, second.annualizedLoss);
  const after = (await riskSnapshot(admin.tenantId)).risks.find((risk) => risk.id === id)!;
  assert.ok(after.fair && after.fair.p90 >= (after.fair.mean ?? 0) * 0.5);
  assert.equal(after.fair?.currency, "EUR");
  const summary = (await riskSnapshot(admin.tenantId)).summary;
  assert.equal(summary.quantified, 1);
  assert.ok(summary.annualLossP90Indicative > 0);
});

test("the register can be seeded from control gaps without duplicates, and a treatment becomes a task", async () => {
  const { createFromGaps, updateRisk, createTreatmentTask, riskSnapshot, closeRisk } = await rr();
  const { adoptFramework } = await engine();
  await adoptFramework(admin, { frameworkId: "nis2", scope: "Whole organisation" });
  const first = await createFromGaps(admin, { limit: 5 });
  assert.equal(first.created, 5);
  const second = await createFromGaps(admin, { limit: 5 });
  assert.equal(second.created, 5, "the next five gaps, not the same ones again");
  const snapshot = await riskSnapshot(admin.tenantId);
  const gaps = snapshot.risks.filter((risk) => risk.source_type === "gap");
  assert.equal(new Set(gaps.map((risk) => risk.source_id)).size, gaps.length);
  assert.ok(gaps.every((risk) => risk.controls.length === 1 && risk.title.startsWith("Gap: ")));

  const gap = gaps[0];
  await assert.rejects(createTreatmentTask(admin, { id: gap.id }), /Choose the mitigate/);
  await updateRisk(admin, { id: gap.id, treatment: "mitigate", treatmentPlan: "Roll out the control", ownerId: riskOwner.userId, targetDate: iso(45) });
  const task = await createTreatmentTask(admin, { id: gap.id });
  assert.ok(task.id);
  await assert.rejects(createTreatmentTask(admin, { id: gap.id }), /already exists/);
  const treating = (await riskSnapshot(admin.tenantId)).risks.find((risk) => risk.id === gap.id)!;
  assert.equal(treating.status, "treating");

  await closeRisk(admin, { id: gap.id, note: "Control implemented and verified" });
  await assert.rejects(closeRisk(admin, { id: gap.id, note: "Closing it again" }), /already final/);
  await assert.rejects(updateRisk(admin, { id: gap.id, title: "Renamed after closing" }), /closed/);
  const summary = (await riskSnapshot(admin.tenantId)).summary;
  assert.ok(summary.open > 0);
});

test("the API requires the right permission, and acceptance needs the approval permission", async () => {
  const { GET, POST } = await import("../src/app/api/risk-register/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const call = async (role: "viewer" | "control_owner", body: unknown) => POST(new Request("http://localhost/api/risk-register", { method: "POST", headers: { authorization: `Bearer ${await issueSessionToken({ ...admin, role })}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  assert.equal((await call("viewer", { action: "create", ...base })).status, 403);
  assert.equal((await call("control_owner", { action: "create", ...base })).status, 201);
  assert.equal((await call("control_owner", { action: "accept", id: "rsk_x", days: 10, note: "Not allowed to accept" })).status, 403);
  const read = await GET(new Request("http://localhost/api/risk-register", { headers: { authorization: `Bearer ${await issueSessionToken({ ...admin, role: "viewer" })}` } }));
  assert.equal(read.status, 200);
});
