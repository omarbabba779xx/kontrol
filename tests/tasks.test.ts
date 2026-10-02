import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40), KONTROL_PUBLIC_URL: "https://kontrol.acme.example/" });

const tasks = () => import("../src/lib/core/tasks");
const notifications = () => import("../src/lib/core/notifications");
const alerts = () => import("../src/lib/core/alerts");
const db = async () => (await import("../src/lib/db")).getDb();
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const sent: Array<{ url: string; body: string }> = [];
const deps = { fetchImpl: async (url: string, init: { body: string }) => { sent.push({ url, body: init.body }); return { ok: true, status: 200 }; }, guard: async () => undefined, sendMail: async () => undefined };
const queued = async (type: string) => (await (await db()).scope(admin.tenantId).all<{ title: string; dedupe_key: string; severity: string }>("SELECT title, dedupe_key, severity FROM notifications WHERE event_type = ? ORDER BY created_at", type));

test("tasks are created, assigned to an active user and announced through the channels", async () => {
  const { createChannel } = await notifications();
  const { createTask, listTasks } = await tasks();
  await createChannel(admin, { kind: "slack", name: "Ops", config: { webhookUrl: "https://hooks.slack.com/services/T/A/SK" }, events: ["*"], minSeverity: "low" });
  await (await db()).system().run("INSERT INTO users (id,tenant_id,email,name,role,created_at,status) VALUES (?,?,?,?,?,?,?)", "usr_gone", admin.tenantId, "gone@acme.example", "Gone Away", "control_owner", new Date().toISOString(), "disabled");

  await assert.rejects(createTask(admin, { title: "Patch the gateway", priority: "high", assigneeId: "usr_nobody" }), (error: Error & { status?: number }) => error.status === 404);
  await assert.rejects(createTask(admin, { title: "Patch the gateway", priority: "high", assigneeId: "usr_gone" }), /disabled/);
  await assert.rejects(createTask(admin, { title: "Patch the gateway", priority: "high", dueAt: "not a date" }), /Due date/);

  const { id } = await createTask(admin, { title: "Patch the gateway", description: "CVE-2026-0001", priority: "high", dueAt: iso(7), assigneeId: riskOwner.userId, ucCode: "UC-OPS-02" });
  const [task] = await listTasks(admin.tenantId, { assigneeId: riskOwner.userId });
  assert.equal(task.id, id);
  assert.equal(task.assignee_name, "Maya Chen");
  assert.equal(task.overdue, false);

  const [assigned] = await queued("task.assigned");
  assert.match(assigned.title, /assigned to Maya Chen/);
  assert.equal(assigned.severity, "high", "a high task is announced as high");
});

test("status changes close and reopen a task, reassignment announces once, and comments are kept", async () => {
  const { updateTask, addComment, listTasks, createTask } = await tasks();
  const { id } = await createTask(admin, { title: "Review firewall rules", priority: "medium" });
  assert.equal((await queued("task.assigned")).length, 1, "unassigned tasks announce nothing");

  await updateTask(admin, { id, assigneeId: riskOwner.userId });
  await updateTask(admin, { id, assigneeId: riskOwner.userId, priority: "high" });
  assert.equal((await queued("task.assigned")).length, 2, "reassigning to the same person does not announce again");

  await updateTask(admin, { id, status: "in_progress" });
  await addComment(riskOwner, { taskId: id, body: "Started on the DMZ rules." });
  await updateTask(admin, { id, status: "done" });
  let [task] = await listTasks(admin.tenantId, { status: "done" });
  assert.equal(task.id, id);
  assert.ok(task.closed_at);
  assert.equal(task.comments.length, 1);
  assert.equal(task.comments[0].author_id, riskOwner.userId);

  await updateTask(admin, { id, status: "open" });
  [task] = (await listTasks(admin.tenantId, { open: true })).filter((item) => item.id === id);
  assert.equal(task.closed_at, null, "reopening clears the close date");
  await assert.rejects(updateTask(admin, { id: "task_missing", status: "done" }), (error: Error & { status?: number }) => error.status === 404);
  await assert.rejects(addComment(admin, { taskId: "task_missing", body: "hello there" }), (error: Error & { status?: number }) => error.status === 404);
});

test("the roadmap becomes tasks once, and a failed control becomes a remediation task once", async () => {
  const { createTasksFromRoadmap, createTaskFromFinding, listTasks } = await tasks();
  const { loadDemoPosture } = await import("../src/lib/core/compliance-engine");
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  await loadDemoPosture(admin);

  const first = await createTasksFromRoadmap(admin, { limit: 5 });
  assert.equal(first.created, 5);
  const second = await createTasksFromRoadmap(admin, { limit: 5 });
  assert.equal(second.created, 5, "the next five gaps, not the same five again");
  const roadmap = (await listTasks(admin.tenantId)).filter((task) => task.source_type === "roadmap");
  assert.equal(new Set(roadmap.map((task) => task.uc_code)).size, 10);
  assert.equal(roadmap.filter((task) => task.priority === "high").length, 3, "only the top three are high priority");
  assert.ok(roadmap.every((task) => task.due_at && task.description.includes("requirement")));

  await evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts: { production: true, branchProtection: { enabled: false, requiredReviews: 0 } }, source: "test" });
  const finding = await (await db()).scope(admin.tenantId).get<{ id: string; severity: string }>("SELECT id, severity FROM findings WHERE tenant_id = ? AND status = 'open' LIMIT 1", admin.tenantId);
  const created = await createTaskFromFinding(admin, finding!.id);
  const task = (await listTasks(admin.tenantId)).find((item) => item.id === created.id)!;
  assert.equal(task.source_type, "finding");
  assert.equal(task.priority, finding!.severity);
  await assert.rejects(createTaskFromFinding(admin, finding!.id), (error: Error & { status?: number }) => error.status === 409);
  await assert.rejects(createTaskFromFinding(admin, "finding_missing"), (error: Error & { status?: number }) => error.status === 404);
});

test("the scan raises each condition once, escalates overdue work, and weekly reminders are a new key", async () => {
  const { scanAndNotify } = await alerts();
  const { createTask } = await tasks();
  const { setImplementation, requestException } = await import("../src/lib/core/compliance-engine");

  await createTask(admin, { title: "Late and unassigned", priority: "medium", dueAt: iso(-3) });
  await setImplementation(admin, { ucCode: "UC-GOV-01", status: "implemented", maturity: 3, notes: "Policy approved", reviewDue: iso(-5) });
  await setImplementation(admin, { ucCode: "UC-GOV-02", status: "partial", maturity: 2, notes: "Roles drafted", reviewDue: iso(7) });
  const { id: exceptionId } = await requestException(admin, { ucCode: "UC-OPS-02", title: "Defer kernel patch", justification: "Vendor has not certified the patch yet.", compensatingControls: "Isolated VLAN with IDS.", riskLevel: "medium", expiresAt: iso(60) });
  await (await db()).scope(admin.tenantId).run("UPDATE compliance_exceptions SET created_at = ? WHERE id = ?", iso(-4), exceptionId);

  const now = Date.now();
  const first = await scanAndNotify(admin.tenantId, now);
  assert.ok(first.queued > 0);
  const overdue = await queued("task.overdue");
  assert.ok(overdue.some((item) => item.title === "Overdue: Late and unassigned" && item.severity === "high"), "a medium task that is overdue is raised to high");
  assert.ok((await queued("attestation.expired")).some((item) => item.title.startsWith("UC-GOV-01")));
  assert.ok((await queued("attestation.expiring")).some((item) => item.title.startsWith("UC-GOV-02")));
  assert.ok((await queued("exception.pending")).some((item) => item.title.includes("Defer kernel patch")));

  const again = await scanAndNotify(admin.tenantId, now);
  assert.equal(again.queued, 0, "a second scan changes nothing");
  const nextWeek = await scanAndNotify(admin.tenantId, now + 8 * DAY);
  assert.ok(nextWeek.queued > 0, "overdue and pending items are repeated weekly");
  assert.equal((await queued("attestation.expired")).filter((item) => item.title.startsWith("UC-GOV-01")).length, 1, "but an expired attestation is announced once");
  assert.ok((await queued("attestation.expired")).some((item) => item.title.startsWith("UC-GOV-02")), "and UC-GOV-02, due in a week, expired by the later scan");
});

test("maintenance delivers what the scan queued, with absolute links, and counts failures", async () => {
  const { runMaintenance } = await alerts();
  sent.length = 0;
  const result = await runMaintenance(deps);
  assert.ok(result.delivered > 0);
  assert.equal(result.failed, 0);
  const slack = sent.find((call) => call.body.includes("Overdue: Late and unassigned"));
  assert.ok(slack);
  assert.match(JSON.parse(slack!.body).text, /https:\/\/kontrol\.acme\.example\/tasks/, "links use KONTROL_PUBLIC_URL without a double slash");
  assert.equal((await runMaintenance(deps)).delivered, 0, "nothing is sent twice");
});

test("a connector that keeps failing raises one alert, and its recovery is announced", async () => {
  const { saveCredentials } = await import("../src/lib/core/credentials");
  const { saveSchedule, runDueJobs } = await import("../src/lib/core/scheduler");
  await alerts();
  await saveCredentials(admin, "github", { token: "github_pat_" + "Q".repeat(30) });
  await saveSchedule(admin, { kind: "github", params: { owner: "acme", repository: "lending" }, intervalMinutes: 60, enabled: true });

  const realFetch = globalThis.fetch;
  let healthy = false;
  globalThis.fetch = (async (input: string | URL | Request) => healthy && String(input).endsWith("/repos/acme/lending")
    ? new Response(JSON.stringify({ full_name: "acme/lending", default_branch: "main", visibility: "private", owner: { type: "User" } }), { status: 200 })
    : new Response("{}", { status: healthy ? 404 : 500 })) as typeof fetch;
  try {
    let now = Date.now() + 120 * 60_000;
    for (let i = 0; i < 4; i++) { await runDueJobs({ now }); now += 60 * 60_000; }
    assert.equal((await queued("connector.failing")).length, 1, "alerted at the third failure, not on every one");
    healthy = true;
    await runDueJobs({ now: now + 6 * 60 * 60_000 });
    assert.equal((await queued("connector.recovered")).length, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("task activity is chained in the audit log", async () => {
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  assert.equal((await verifyAuditChain(admin.tenantId)).valid, true);
  const actions = new Set((await (await db()).scope(admin.tenantId).all<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE tenant_id = ? AND action LIKE 'task.%'", admin.tenantId)).map((row) => row.action));
  assert.ok(actions.has("task.created") && actions.has("task.updated"));
});
