import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40), KONTROL_METRICS_TOKEN: "m".repeat(32), KONTROL_ALLOW_SAMPLE_COLLECTION: undefined });

const db = async () => (await import("../src/lib/db")).getDb();
const DAY = 86_400_000;

test("log lines are one JSON object and never carry a credential, by field name or by value", async () => {
  const { line, redact } = await import("../src/lib/core/log");
  const token = "github_pat_" + "Q".repeat(30);
  const parsed = JSON.parse(line("warn", "collection.failed", { connector: "github", token, nested: { password: "hunter2", note: `failed with Bearer ${"a".repeat(30)}` }, error: `401 for ${token}` }));
  assert.equal(parsed.event, "collection.failed");
  assert.equal(parsed.level, "warn");
  assert.equal(parsed.token, "[redacted]");
  assert.equal(parsed.nested.password, "[redacted]");
  assert.ok(!JSON.stringify(parsed).includes("Q".repeat(30)) && !JSON.stringify(parsed).includes("a".repeat(30)));
  assert.match(parsed.time, /^\d{4}-\d\d-\d\dT/);
  assert.equal(typeof redact("x".repeat(2000)), "string");
  assert.equal((redact("x".repeat(2000)) as string).length, 500);
});

test("a failed collection is logged as an alertable event without the credential", async () => {
  const { saveCredentials } = await import("../src/lib/core/credentials");
  const { saveSchedule, runDueJobs } = await import("../src/lib/core/scheduler");
  const token = "github_pat_" + "Z".repeat(30);
  await saveCredentials(admin, "github", { token });
  await saveSchedule(admin, { kind: "github", params: { owner: "acme", repository: "gone" }, intervalMinutes: 60, enabled: true });
  const realFetch = globalThis.fetch;
  const lines: string[] = [];
  const realWarn = console.warn;
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: `Bad credentials ${token}` }), { status: 401 })) as typeof fetch;
  console.warn = (message: string) => { lines.push(String(message)); };
  try { await runDueJobs({ now: Date.now() + 2 * 60 * 60_000 }); }
  finally { globalThis.fetch = realFetch; console.warn = realWarn; }
  const event = lines.map((entry) => JSON.parse(entry)).find((entry) => entry.event === "collection.failed");
  assert.ok(event, "the failure was logged");
  assert.equal(event.connector, "github");
  assert.equal(event.consecutiveFailures, 1);
  assert.ok(!lines.join("").includes("Z".repeat(30)));
});

test("metrics expose failing collections, waiting workflows and undelivered alerts, behind a token", async () => {
  const sys = (await db()).system();
  await sys.run("INSERT INTO workflows (id,tenant_id,kind,state,current_step,payload_json,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", "wf_wait", admin.tenantId, "release", "awaiting_approval", "approve", "{}", 1, new Date(Date.now() - 5 * DAY).toISOString(), new Date(Date.now() - 5 * DAY).toISOString());
  await sys.run("UPDATE connector_schedules SET consecutive_failures = 4, last_status = 'failed' WHERE kind = 'github'");

  const { GET } = await import("../src/app/api/metrics/route");
  const call = (authorization?: string) => GET(new Request("http://localhost/api/metrics", { headers: authorization ? { authorization } : {} }));
  assert.equal((await call()).status, 401);
  assert.equal((await call("Bearer wrong")).status, 401);
  const ok = await call(`Bearer ${"m".repeat(32)}`);
  assert.equal(ok.status, 200);
  const body = await ok.text();
  assert.match(body, /^# TYPE kontrol_up gauge$/m);
  assert.match(body, /^kontrol_up 1$/m);
  assert.match(body, new RegExp(`^kontrol_collections_failing\\{tenant="${admin.tenantId}"\\} 1$`, "m"));
  const waiting = /^kontrol_workflows_waiting_oldest_seconds\{tenant="tenant_acme"\} (\d+)$/m.exec(body);
  assert.ok(waiting && Number(waiting[1]) >= 5 * 86_400 - 5, "the workflow has waited about five days");
  assert.match(body, /^kontrol_audit_entries\{tenant="tenant_acme"\} \d+$/m);
  assert.ok(!/github_pat_|hunter2/.test(body), "metrics are counts, never contents");

  delete process.env.KONTROL_METRICS_TOKEN;
  assert.equal((await call(`Bearer ${"m".repeat(32)}`)).status, 404, "without a token configured the endpoint does not exist");
  process.env.KONTROL_METRICS_TOKEN = "short";
  assert.equal((await call("Bearer short")).status, 404, "a weak token is not accepted as configuration");
});

test("a workflow waiting for approval for days raises one alert per week", async () => {
  const { createChannel } = await import("../src/lib/core/notifications");
  const { scanAndNotify } = await import("../src/lib/core/alerts");
  await createChannel(admin, { kind: "slack", name: "Ops", config: { webhookUrl: "https://hooks.slack.com/services/T/A/SK" }, events: ["*"], minSeverity: "low" });
  await scanAndNotify(admin.tenantId);
  await scanAndNotify(admin.tenantId);
  const rows = await (await db()).system().all<{ title: string }>("SELECT title FROM notifications WHERE event_type = 'workflow.stuck'");
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /release workflow has waited for approval/);
});
