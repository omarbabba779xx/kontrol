import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const mod = () => import("../src/lib/core/notifications");
const db = async () => (await import("../src/lib/db")).getDb();
const MIN = 60_000;
let securityId = ""; // the wildcard channel created by the first test also receives every event

type Call = { url: string; headers: Record<string, string>; body: string; redirect: string };
function recorder(status = 200) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string; redirect: "error" }) => { calls.push({ url, headers: init.headers, body: init.body, redirect: init.redirect }); return { ok: status < 400, status }; };
  return { calls, fetchImpl, guard: async () => undefined };
}
const event = (key: string, overrides: Record<string, unknown> = {}) => ({ type: "finding.opened", severity: "high" as const, title: `Finding ${key}`, body: "Something failed", dedupeKey: key, ...overrides });

test("a channel's destination is encrypted, validated, never returned, and public https only", async () => {
  const { createChannel, listChannels } = await mod();
  await assert.rejects(createChannel(admin, { kind: "slack", name: "Bad", config: { webhookUrl: "http://hooks.slack.com/x" }, events: ["*"], minSeverity: "low" }), /https/);
  await assert.rejects(createChannel(admin, { kind: "webhook", name: "Bad", config: { url: "https://localhost/hook" }, events: ["*"], minSeverity: "low" }));
  await assert.rejects(createChannel(admin, { kind: "slack", name: "Bad", config: { webhookUrl: "https://hooks.slack.com/x" }, events: ["nope.event"], minSeverity: "low" }), /Unknown event/);
  await assert.rejects(createChannel(admin, { kind: "jira", name: "Bad", config: { baseUrl: "https://acme.atlassian.net", email: "a@b.example", apiToken: "tok-12345678", projectKey: "lower" }, events: ["*"], minSeverity: "low" }));

  const url = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";
  const slack = await createChannel(admin, { kind: "slack", name: "Security channel", config: { webhookUrl: url }, events: ["*"], minSeverity: "low" });
  assert.equal(slack.signingSecret, undefined);
  securityId = slack.id;
  const row = await (await db()).scope(admin.tenantId).get<Record<string, string>>("SELECT * FROM notification_channels WHERE id = ?", slack.id);
  assert.ok(!JSON.stringify(row).includes("SECRETSECRET"), "no plaintext destination at rest");
  const listed = JSON.stringify(await listChannels(admin.tenantId));
  assert.ok(!listed.includes("SECRETSECRET") && listed.includes("hooks.slack.com"), "only the host is shown");
});

test("events reach only the channels that subscribe, at or above their severity, and a repeated key is ignored", async () => {
  const { createChannel, notify, setChannelEnabled, listChannels } = await mod();
  const all = await createChannel(admin, { kind: "slack", name: "All", config: { webhookUrl: "https://hooks.slack.com/services/A/B/ALL" }, events: ["*"], minSeverity: "low" });
  const urgent = await createChannel(admin, { kind: "slack", name: "Urgent only", config: { webhookUrl: "https://hooks.slack.com/services/A/B/URGENT" }, events: ["finding.opened", "task.overdue"], minSeverity: "critical" });
  const tasksOnly = await createChannel(admin, { kind: "slack", name: "Tasks", config: { webhookUrl: "https://hooks.slack.com/services/A/B/TASKS" }, events: ["task.assigned"], minSeverity: "low" });

  const queuedFor = async (key: string) => (await (await db()).scope(admin.tenantId).all<{ channel_id: string }>("SELECT channel_id FROM notifications WHERE dedupe_key = ?", key)).map((r) => r.channel_id).sort();
  const base = (await queuedFor("k-high")).length;
  assert.equal(base, 0);
  await notify(admin.tenantId, event("k-high", { severity: "high" }));
  assert.deepEqual(await queuedFor("k-high"), [securityId, all.id].sort(), "the critical-only channel ignores a high event, the tasks channel another type");
  await notify(admin.tenantId, event("k-crit", { severity: "critical" }));
  assert.deepEqual(await queuedFor("k-crit"), [securityId, all.id, urgent.id].sort());
  assert.equal(await notify(admin.tenantId, event("k-crit", { severity: "critical" })), 0, "same key, nothing new");

  await setChannelEnabled(admin, { id: all.id, enabled: false });
  await notify(admin.tenantId, event("k-off"));
  assert.ok(!(await queuedFor("k-off")).includes(all.id), "a disabled channel receives nothing");
  await setChannelEnabled(admin, { id: all.id, enabled: true });
  assert.ok((await listChannels(admin.tenantId)).channels.some((c) => c.id === tasksOnly.id && c.events[0] === "task.assigned"));
});

test("Slack and signed-webhook deliveries are well formed, refuse redirects and consult the network guard", async () => {
  const { createChannel, notify, deliverPending } = await mod();
  const webhook = await createChannel(admin, { kind: "webhook", name: "SIEM", config: { url: "https://siem.acme.example/kontrol" }, events: ["audit.request_due"], minSeverity: "low" });
  assert.match(webhook.signingSecret ?? "", /^[0-9a-f]{64}$/, "the signing secret is shown once");
  await notify(admin.tenantId, { type: "audit.request_due", severity: "medium", title: "Request due", body: "Provide the access review", dedupeKey: "ard-1", link: "https://kontrol.example/audit", payload: { requestId: "r1" } });

  const net = recorder();
  const guarded: string[] = [];
  const results = await deliverPending({ fetchImpl: net.fetchImpl, guard: async (url) => { guarded.push(url); } });
  assert.ok(results.every((r) => r.status === "sent"));
  assert.ok(guarded.includes("https://siem.acme.example/kontrol"), "the destination was checked before the request");
  assert.ok(net.calls.every((call) => call.redirect === "error"), "redirects are never followed");

  const call = net.calls.find((c) => c.url === "https://siem.acme.example/kontrol")!;
  const expected = `sha256=${createHmac("sha256", webhook.signingSecret!).update(`${call.headers["X-Kontrol-Timestamp"]}.${call.body}`).digest("hex")}`;
  assert.equal(call.headers["X-Kontrol-Signature"], expected, "the receiver can verify the body with the secret");
  assert.equal(JSON.parse(call.body).event, "audit.request_due");
  assert.equal(JSON.parse(call.body).payload.requestId, "r1");

  const slack = net.calls.find((c) => c.url.includes("hooks.slack.com") && c.body.includes("Request due"));
  assert.match(JSON.parse(slack!.body).text, /Request due/);
  assert.match(JSON.parse(slack!.body).text, /Open in Kontrol/);
});

test("email goes to the configured recipients and, when enabled, to the assignee", async () => {
  const { createChannel, notify, deliverPending } = await mod();
  await createChannel(admin, { kind: "email", name: "Mail", config: { host: "smtp.acme.example", port: 587, secure: false, user: "kontrol", pass: "smtp-pass-1", from: "kontrol@acme.example", to: ["secops@acme.example"], includeAssignee: true }, events: ["task.assigned"], minSeverity: "low" });
  await notify(admin.tenantId, { type: "task.assigned", severity: "high", title: "Task for Priya", body: "Please patch", dedupeKey: "mail-1", payload: { assigneeEmail: "priya@acme.example" } });
  const sent: Array<{ smtp: Record<string, unknown>; mail: { to: string[]; subject: string; from: string } }> = [];
  await deliverPending({ fetchImpl: recorder().fetchImpl, guard: async () => undefined, sendMail: async (smtp, mail) => { sent.push({ smtp, mail }); } });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].mail.to.sort(), ["priya@acme.example", "secops@acme.example"]);
  assert.equal(sent[0].mail.subject, "[Kontrol high] Task for Priya");
  assert.equal(sent[0].smtp.host, "smtp.acme.example");
});

test("Jira receives an authenticated issue with the event as its description", async () => {
  const { createChannel, notify, deliverPending } = await mod();
  await createChannel(admin, { kind: "jira", name: "Jira", config: { baseUrl: "https://acme.atlassian.net", email: "bot@acme.example", apiToken: "jira-token-123", projectKey: "SEC", issueType: "Bug" }, events: ["connector.failing"], minSeverity: "high" });
  await notify(admin.tenantId, { type: "connector.failing", severity: "high", title: "okta collection is failing", body: "3 failures in a row", dedupeKey: "jira-1" });
  const net = recorder();
  await deliverPending({ fetchImpl: net.fetchImpl, guard: async () => undefined, sendMail: async () => undefined });
  const call = net.calls.find((c) => c.url === "https://acme.atlassian.net/rest/api/3/issue")!;
  assert.equal(call.headers.Authorization, `Basic ${Buffer.from("bot@acme.example:jira-token-123").toString("base64")}`);
  const fields = JSON.parse(call.body).fields;
  assert.deepEqual([fields.project.key, fields.issuetype.name, fields.summary], ["SEC", "Bug", "okta collection is failing"]);
  assert.match(JSON.stringify(fields.description), /3 failures in a row/);
});

test("failed deliveries retry with back-off, are scrubbed of URLs and secrets, and die after five attempts", async () => {
  const { createChannel, notify, deliverPending, retryNotification } = await mod();
  const channel = await createChannel(admin, { kind: "slack", name: "Flaky", config: { webhookUrl: "https://hooks.slack.com/services/F/L/TOPSECRETTOKEN" }, events: ["policy.review_overdue"], minSeverity: "low" });
  await notify(admin.tenantId, { type: "policy.review_overdue", severity: "medium", title: "Policy late", body: "x", dedupeKey: "flaky-1" });
  const id = (await (await db()).scope(admin.tenantId).get<{ id: string }>("SELECT id FROM notifications WHERE dedupe_key = 'flaky-1' AND channel_id = ?", channel.id))!.id;
  const failing = { fetchImpl: async () => { throw new Error("connect ECONNREFUSED https://hooks.slack.com/services/F/L/TOPSECRETTOKEN token=abc123"); }, guard: async () => undefined, sendMail: async () => undefined };

  let now = Date.now() + 10 * MIN;
  const delays: number[] = [];
  const state = async () => (await (await db()).scope(admin.tenantId).get<{ status: string; attempts: number; next_attempt_at: string; last_error: string }>("SELECT status, attempts, next_attempt_at, last_error FROM notifications WHERE id = ?", id))!;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await deliverPending({ ...failing, now });
    const row = await state();
    assert.equal(row.attempts, attempt);
    assert.ok(!row.last_error.includes("TOPSECRETTOKEN") && !row.last_error.includes("hooks.slack.com") && !row.last_error.includes("abc123"), "no URL or secret in the stored error");
    if (attempt < 5) { delays.push(Math.round((Date.parse(row.next_attempt_at) - now) / MIN)); now = Date.parse(row.next_attempt_at) + 1000; }
  }
  assert.deepEqual(delays, [1, 5, 30, 120]);
  assert.equal((await state()).status, "dead");
  assert.deepEqual(await deliverPending({ ...failing, now: now + 1e9 }), [], "a dead notification is not retried automatically");

  await retryNotification(admin, id);
  const ok = recorder();
  assert.ok((await deliverPending({ fetchImpl: ok.fetchImpl, guard: async () => undefined, sendMail: async () => undefined, now: now + 2 * MIN })).some((r) => r.id === id && r.status === "sent"));
  await assert.rejects(retryNotification(admin, id), (error: Error & { status?: number }) => error.status === 404);
});

test("two instances cannot deliver the same notification, and a channel test reports plainly", async () => {
  const { createChannel, notify, deliverPending, testChannel } = await mod();
  const channel = await createChannel(admin, { kind: "slack", name: "Race", config: { webhookUrl: "https://hooks.slack.com/services/R/A/CE" }, events: ["evidence.pending_review"], minSeverity: "low" });
  await notify(admin.tenantId, { type: "evidence.pending_review", severity: "low", title: "Review me", body: "x", dedupeKey: "race-1" });
  const net = recorder();
  const deps = { fetchImpl: net.fetchImpl, guard: async () => undefined, sendMail: async () => undefined };
  await Promise.all([deliverPending(deps), deliverPending(deps)]);
  assert.equal(net.calls.filter((call) => call.url === "https://hooks.slack.com/services/R/A/CE" && call.body.includes("Review me")).length, 1, "leased before sending");

  assert.deepEqual(await testChannel(admin, channel.id, deps), { ok: true, detail: "Delivered." });
  const broken = recorder(500);
  const failed = await testChannel(admin, channel.id, { fetchImpl: broken.fetchImpl, guard: async () => undefined });
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /answered 500/);
  await assert.rejects(testChannel(admin, "chan_missing"), (error: Error & { status?: number }) => error.status === 404);
});

test("deleting a channel removes its outbox, and channels are per tenant", async () => {
  const { createChannel, notify, deleteChannel, listChannels } = await mod();
  const channel = await createChannel(admin, { kind: "slack", name: "Short lived", config: { webhookUrl: "https://hooks.slack.com/services/S/L/IVED" }, events: ["*"], minSeverity: "low" });
  await notify(admin.tenantId, event("short-1"));
  await deleteChannel(admin, channel.id);
  assert.equal((await (await db()).scope(admin.tenantId).all("SELECT id FROM notifications WHERE channel_id = ?", channel.id)).length, 0);
  await assert.rejects(deleteChannel(admin, channel.id), (error: Error & { status?: number }) => error.status === 404);

  await (await db()).system().run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", "tenant_other", "Other", "EU", new Date().toISOString());
  assert.deepEqual((await listChannels("tenant_other")).channels, []);
  assert.equal(await notify("tenant_other", event("other-1")), 0);
});

test("the notification system is chained in the audit log without secrets", async () => {
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  assert.equal((await verifyAuditChain(admin.tenantId)).valid, true);
  const rows = await (await db()).scope(admin.tenantId).all<{ action: string; payload_json: string }>("SELECT action, payload_json FROM audit_log WHERE tenant_id = ? AND action LIKE 'notifications.%'", admin.tenantId);
  assert.ok(rows.some((row) => row.action === "notifications.channel_created") && rows.some((row) => row.action === "notifications.channel_deleted"));
  assert.ok(!rows.some((row) => /SECRET|jira-token|smtp-pass/.test(row.payload_json)));
});
