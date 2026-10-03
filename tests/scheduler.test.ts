import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40), KONTROL_ALLOW_SAMPLE_COLLECTION: "true" });

const sched = () => import("../src/lib/core/scheduler");
const db = async () => (await import("../src/lib/db")).getDb();
const MIN = 60_000;

async function schedule(kind: string, params: Record<string, string> = {}, intervalMinutes = 60, enabled = true) {
  const { saveSchedule, listSchedules } = await sched();
  const { target } = await saveSchedule(admin, { kind, params, intervalMinutes, enabled });
  return (await listSchedules(admin.tenantId)).schedules.find((item) => item.kind === kind && item.target === target)!;
}

test("schedules validate the connector, the interval and the target", async () => {
  const { saveSchedule } = await sched();
  await assert.rejects(saveSchedule(admin, { kind: "ftp", intervalMinutes: 60, enabled: true }), /Unsupported connector/);
  await assert.rejects(saveSchedule(admin, { kind: "okta", intervalMinutes: 7, enabled: true }), /Interval must be one of/);
  await assert.rejects(saveSchedule(admin, { kind: "github", intervalMinutes: 60, enabled: true }), /owner and a repository/);
  await assert.rejects(saveSchedule(admin, { kind: "gitlab", intervalMinutes: 60, enabled: true }), /project path/);
  const saved = await schedule("github", { owner: "acme", repository: "lending" });
  assert.equal(saved.target, "acme/lending");
  const again = await schedule("github", { owner: "acme", repository: "lending" }, 360);
  assert.equal(again.id, saved.id, "saving the same target updates it instead of duplicating");
  assert.equal(again.intervalMinutes, 360);
});

test("a due schedule runs once, records the run and moves to its next slot", async () => {
  const { runDueJobs, listSchedules } = await sched();
  const okta = await schedule("okta", {}, 60);
  const now = Date.now() + MIN;
  const results = await runDueJobs({ now });
  const mine = results.find((item) => item.scheduleId === okta.id)!;
  assert.equal(mine.status, "ok");
  assert.deepEqual(Object.keys(mine.summary as object).sort(), ["failed", "mode", "passed", "skipped"]);

  const after = (await listSchedules(admin.tenantId)).schedules.find((item) => item.id === okta.id)!;
  assert.equal(after.lastStatus, "ok");
  assert.equal(after.consecutiveFailures, 0);
  assert.ok(Math.abs(Date.parse(after.nextRunAt) - (now + 60 * MIN)) < 1000, "next slot is one interval after this run");
  assert.deepEqual((await runDueJobs({ now: now + 10 * MIN })).filter((item) => item.scheduleId === okta.id), [], "not due again yet");

  const runs = (await listSchedules(admin.tenantId)).runs.filter((run) => run.kind === "okta");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger, "schedule");
});

test("two instances cannot run the same schedule", async () => {
  const { runDueJobs } = await sched();
  const gws = await schedule("google_workspace", {}, 60);
  const now = Date.now() + MIN;
  const [a, b] = await Promise.all([runDueJobs({ now }), runDueJobs({ now })]);
  const runs = [...a, ...b].filter((item) => item.scheduleId === gws.id);
  assert.equal(runs.length, 1, "exactly one instance claimed it");
});

test("an abandoned claim is released after its time-to-live, a live one is respected", async () => {
  const { runDueJobs } = await sched();
  const entra = await schedule("entra", {}, 60);
  const now = Date.now() + MIN;
  await (await db()).system().run("UPDATE connector_schedules SET claimed_at = ? WHERE id = ?", new Date(now - 2 * MIN).toISOString(), entra.id);
  assert.deepEqual((await runDueJobs({ now })).filter((item) => item.scheduleId === entra.id), [], "claimed two minutes ago: someone is running it");
  await (await db()).system().run("UPDATE connector_schedules SET claimed_at = ? WHERE id = ?", new Date(now - 20 * MIN).toISOString(), entra.id);
  assert.equal((await runDueJobs({ now })).filter((item) => item.scheduleId === entra.id).length, 1, "a crashed instance's claim expires");
});

test("disabled schedules do not run, and deleting removes them", async () => {
  const { runDueJobs, deleteSchedule, listSchedules } = await sched();
  const off = await schedule("gitlab", { project: "acme/off" }, 60, false);
  assert.deepEqual((await runDueJobs({ now: Date.now() + 5 * MIN })).filter((item) => item.scheduleId === off.id), []);
  await deleteSchedule(admin, off.id);
  assert.equal((await listSchedules(admin.tenantId)).schedules.some((item) => item.id === off.id), false);
  await assert.rejects(deleteSchedule(admin, off.id), (error: Error & { status?: number }) => error.status === 404);
});

test("failures back off exponentially, raise one alert at the threshold, never leak the credential, and recovery is announced", async () => {
  const { runDueJobs, listSchedules, onScheduleFailing, onScheduleRecovered, FAILING_AFTER } = await sched();
  const { saveCredentials } = await import("../src/lib/core/credentials");
  const token = "github_pat_" + "Z".repeat(30) + "LEAK";
  await saveCredentials(admin, "github", { token });
  const gh = (await listSchedules(admin.tenantId)).schedules.find((item) => item.kind === "github")!;
  assert.ok(gh.enabled);

  const alerts: string[] = [];
  const recoveries: string[] = [];
  onScheduleFailing((event) => { alerts.push(`${event.kind}:${event.failures}`); });
  onScheduleRecovered((event) => { recoveries.push(event.kind); });

  const realFetch = globalThis.fetch;
  let healthy = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!healthy) return new Response(JSON.stringify({ message: `Server error with Bearer ${token}` }), { status: 500 });
    if (url.endsWith("/repos/acme/lending")) return new Response(JSON.stringify({ full_name: "acme/lending", default_branch: "main", visibility: "private", owner: { type: "User" } }), { status: 200 });
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;

  try {
    let now = Date.now() + 8 * 60 * MIN; // earlier tests already ran this schedule (6-hour interval) and pushed its next slot out
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const [result] = (await runDueJobs({ now })).filter((item) => item.scheduleId === gh.id);
      assert.equal(result.status, "failed");
      assert.ok(!JSON.stringify(result).includes(token) && !JSON.stringify(result).includes("LEAK"), "no credential in the stored error");
      const row = (await listSchedules(admin.tenantId)).schedules.find((item) => item.id === gh.id)!;
      assert.equal(row.consecutiveFailures, attempt);
      delays.push(Math.round((Date.parse(row.nextRunAt) - now) / MIN));
      now = Date.parse(row.nextRunAt) + 1000;
    }
    assert.deepEqual(delays, [5, 10, 20, 40], "5, 10, 20, 40 minutes");
    assert.deepEqual(alerts, [`github:${FAILING_AFTER}`], "one alert, at the threshold, not on every failure");
    assert.equal((await listSchedules(admin.tenantId)).schedules.find((item) => item.id === gh.id)!.failing, true);

    healthy = true;
    const [recovered] = (await runDueJobs({ now: now + 3_600_000 })).filter((item) => item.scheduleId === gh.id);
    assert.equal(recovered.status, "ok");
    assert.deepEqual(recoveries, ["github"]);
    const row = (await listSchedules(admin.tenantId)).schedules.find((item) => item.id === gh.id)!;
    assert.equal(row.consecutiveFailures, 0);
    assert.equal(row.failing, false);
  } finally { globalThis.fetch = realFetch; }
});

test("a manual run executes immediately and is marked as manual", async () => {
  const { runScheduleNow, listSchedules } = await sched();
  const okta = (await listSchedules(admin.tenantId)).schedules.find((item) => item.kind === "okta")!;
  assert.equal((await runScheduleNow(admin, okta.id)).status, "ok");
  assert.equal((await listSchedules(admin.tenantId)).runs[0].trigger, "manual");
  await assert.rejects(runScheduleNow(admin, "sched_missing"), (error: Error & { status?: number }) => error.status === 404);
});

test("scheduled runs are performed by a service account, not by a person, and stay in the audit chain", async () => {
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  const rows = await (await db()).scope(admin.tenantId).all<{ actor_id: string }>("SELECT DISTINCT actor_id FROM audit_log WHERE tenant_id = ? AND action = 'connector.synced'", admin.tenantId);
  assert.ok(rows.some((row) => row.actor_id === "usr_svc_scheduler"));
  assert.equal((await verifyAuditChain(admin.tenantId)).valid, true);
});

test("a scheduled collection without stored credentials fails instead of recording sample data under a real name", async () => {
  const { runDueJobs, listSchedules } = await sched();
  const previous = process.env.KONTROL_ALLOW_SAMPLE_COLLECTION;
  delete process.env.KONTROL_ALLOW_SAMPLE_COLLECTION;
  try {
    const gl = await schedule("gitlab", { project: "acme/nocreds" }, 60);
    const [result] = (await runDueJobs({ now: Date.now() + 10 * 60 * MIN })).filter((item) => item.scheduleId === gl.id);
    assert.equal(result.status, "failed");
    const row = (await listSchedules(admin.tenantId)).schedules.find((item) => item.id === gl.id)!;
    assert.match(row.lastError ?? "", /No gitlab credentials are stored/);
    const sources = await (await db()).system().all<{ source: string }>("SELECT DISTINCT source FROM evidence WHERE source LIKE 'gitlab:%'");
    assert.ok(!sources.some((item) => item.source === "gitlab:demo"), "no sample evidence was recorded");
  } finally { if (previous !== undefined) process.env.KONTROL_ALLOW_SAMPLE_COLLECTION = previous; }
});
