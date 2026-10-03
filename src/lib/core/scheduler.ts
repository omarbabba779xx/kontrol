import "server-only";

import { randomUUID } from "node:crypto";
import { assertLiveCredentials, POLLED_CONNECTORS, syncConnector, type ConnectorSyncResult, type PolledConnector, type SyncParams } from "@/lib/connectors";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { serviceActor } from "@/lib/core/service-actors";
import { getDb } from "@/lib/db";

/**
 * Scheduled connector runs. A schedule is claimed atomically before it runs (a second instance cannot take the same one),
 * a failure backs off instead of hammering a broken integration, and every run is recorded. Run it from a cron hitting
 * /api/jobs/run, or in-process with KONTROL_SCHEDULER=true (see src/instrumentation.ts).
 */
export const INTERVALS_MINUTES = [60, 360, 1440, 10_080] as const;
const CLAIM_TTL_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;
export const FAILING_AFTER = 3;

type Hook = (event: { tenantId: string; kind: string; target: string; failures: number; error: string }) => Promise<void> | void;
let failureHook: Hook | undefined;
let recoveryHook: Hook | undefined;
/** Lets the notification system observe scheduler outcomes without this module depending on it. */
export function onScheduleFailing(hook: Hook) { failureHook = hook; }
export function onScheduleRecovered(hook: Hook) { recoveryHook = hook; }

type ScheduleRow = { id: string; tenant_id: string; kind: PolledConnector; target: string; params_json: string; interval_minutes: number; enabled: number; next_run_at: string; claimed_at: string | null; last_run_at: string | null; last_status: string | null; last_error: string | null; consecutive_failures: number };

export const targetOf = (kind: string, params: SyncParams) => (kind === "github" ? `${params.owner ?? ""}/${params.repository ?? ""}` : kind === "gitlab" ? params.project ?? "" : "");

export async function saveSchedule(actor: Actor, input: { kind: string; params?: SyncParams; intervalMinutes: number; enabled: boolean }) {
  if (!(POLLED_CONNECTORS as readonly string[]).includes(input.kind)) throw userError(`Unsupported connector ${input.kind}`);
  if (!(INTERVALS_MINUTES as readonly number[]).includes(input.intervalMinutes)) throw userError(`Interval must be one of ${INTERVALS_MINUTES.join(", ")} minutes`);
  const params = input.params ?? {};
  if (input.kind === "github" && (!params.owner || !params.repository)) throw userError("GitHub needs an owner and a repository");
  if (input.kind === "gitlab" && !params.project) throw userError("GitLab needs a project path");
  const target = targetOf(input.kind, params);
  const now = new Date().toISOString();
  const id = `sched_${randomUUID()}`;
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run(`INSERT INTO connector_schedules (id,tenant_id,kind,target,params_json,interval_minutes,enabled,next_run_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, kind, target) DO UPDATE SET interval_minutes = excluded.interval_minutes, enabled = excluded.enabled, params_json = excluded.params_json,
        next_run_at = CASE WHEN excluded.enabled = 1 THEN excluded.next_run_at ELSE connector_schedules.next_run_at END, consecutive_failures = 0`,
      id, actor.tenantId, input.kind, target, JSON.stringify(params), input.intervalMinutes, input.enabled ? 1 : 0, now, actor.userId, now);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "schedule.saved", objectType: "connector", objectId: `${input.kind}:${target}`, payload: { intervalMinutes: input.intervalMinutes, enabled: input.enabled } }, tx);
  });
  return { kind: input.kind, target };
}

export async function deleteSchedule(actor: Actor, scheduleId: string) {
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    const result = await tx.run("DELETE FROM connector_schedules WHERE tenant_id = ? AND id = ?", actor.tenantId, scheduleId);
    if (result.changes !== 1) throw userError("Schedule not found");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "schedule.deleted", objectType: "schedule", objectId: scheduleId, payload: {} }, tx);
  });
  return { id: scheduleId };
}

export async function listSchedules(tenantId: string) {
  const db = (await getDb()).scope(tenantId);
  const schedules = await db.all<ScheduleRow>("SELECT * FROM connector_schedules WHERE tenant_id = ? ORDER BY kind, target", tenantId);
  const runs = await db.all<{ id: string; kind: string; target: string; trigger: string; started_at: string; finished_at: string; status: string; summary_json: string; error: string | null }>(
    "SELECT id, kind, target, trigger, started_at, finished_at, status, summary_json, error FROM job_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 30", tenantId);
  return {
    schedules: schedules.map((row) => ({ id: row.id, kind: row.kind, target: row.target, intervalMinutes: row.interval_minutes, enabled: row.enabled === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, lastStatus: row.last_status, lastError: row.last_error, consecutiveFailures: row.consecutive_failures, failing: row.consecutive_failures >= FAILING_AFTER })),
    runs: runs.map((run) => ({ ...run, summary: JSON.parse(run.summary_json) as unknown })),
  };
}

function summarise(result: ConnectorSyncResult) {
  return { mode: result.mode, passed: result.evaluations.filter((item) => item.passed).length, failed: result.evaluations.filter((item) => !item.passed).length, skipped: result.skipped.length };
}

/** Never store more of an error than a person needs to act on, and never anything that looks like a credential. */
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(token|secret|password|authorization|key)[=:]\s*\S+/gi, "$1=[redacted]").slice(0, 300);
}

async function execute(row: ScheduleRow, trigger: "schedule" | "manual", now: number) {
  const db = (await getDb()).system();
  const actor = await serviceActor(row.tenant_id, "scheduler");
  const started = new Date().toISOString();
  let summary: unknown = {};
  let error: string | null = null;
  try {
    const params = JSON.parse(row.params_json) as SyncParams;
    await assertLiveCredentials(actor, row.kind, params);
    summary = summarise(await syncConnector(actor, row.kind, params));
  }
  catch (caught) { error = safeError(caught); }
  const finished = new Date().toISOString();
  const failures = error ? row.consecutive_failures + 1 : 0;
  const delay = error ? Math.min(MAX_BACKOFF_MS, Math.min(row.interval_minutes * 60_000, 5 * 60_000 * 2 ** (failures - 1))) : row.interval_minutes * 60_000;
  await db.run("INSERT INTO job_runs (id,tenant_id,schedule_id,kind,target,trigger,started_at,finished_at,status,summary_json,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    `run_${randomUUID()}`, row.tenant_id, row.id, row.kind, row.target, trigger, started, finished, error ? "failed" : "ok", JSON.stringify(summary), error);
  await db.run("UPDATE connector_schedules SET claimed_at = NULL, last_run_at = ?, last_status = ?, last_error = ?, consecutive_failures = ?, next_run_at = ? WHERE id = ?",
    finished, error ? "failed" : "ok", error, failures, new Date(now + delay).toISOString(), row.id);
  const event = { tenantId: row.tenant_id, kind: row.kind, target: row.target, failures, error: error ?? "" };
  if (error && failures === FAILING_AFTER) await failureHook?.(event);
  if (!error && row.consecutive_failures >= FAILING_AFTER) await recoveryHook?.(event);
  return { scheduleId: row.id, status: error ? "failed" : "ok", error, summary };
}

/** Claims a schedule so no other instance runs it; returns null if someone else holds it. */
async function claim(id: string, now: number) {
  const db = (await getDb()).system();
  const result = await db.run("UPDATE connector_schedules SET claimed_at = ? WHERE id = ? AND (claimed_at IS NULL OR claimed_at < ?)", new Date(now).toISOString(), id, new Date(now - CLAIM_TTL_MS).toISOString());
  return result.changes === 1 ? db.get<ScheduleRow>("SELECT * FROM connector_schedules WHERE id = ?", id) : undefined;
}

/** Runs every schedule that is due, across tenants, oldest first. Safe to call from several instances at once. */
export async function runDueJobs(options: { now?: number; limit?: number } = {}) {
  const now = options.now ?? Date.now();
  const due = await (await getDb()).system().all<ScheduleRow>("SELECT * FROM connector_schedules WHERE enabled = 1 AND next_run_at <= ? AND (claimed_at IS NULL OR claimed_at < ?) ORDER BY next_run_at LIMIT ?",
    new Date(now).toISOString(), new Date(now - CLAIM_TTL_MS).toISOString(), options.limit ?? 20);
  const results: Array<Awaited<ReturnType<typeof execute>>> = [];
  for (const candidate of due) {
    const row = await claim(candidate.id, now);
    if (row) results.push(await execute(row, "schedule", now));
  }
  return results;
}

/** Runs one schedule immediately, whether or not it is due. */
export async function runScheduleNow(actor: Actor, scheduleId: string) {
  const row = await (await getDb()).scope(actor.tenantId).get<ScheduleRow>("SELECT * FROM connector_schedules WHERE tenant_id = ? AND id = ?", actor.tenantId, scheduleId);
  if (!row) throw userError("Schedule not found");
  const claimed = await claim(row.id, Date.now());
  if (!claimed) throw userError("This schedule is already running");
  return execute(claimed, "manual", Date.now());
}

/** Starts the in-process loop once per process. */
export function startSchedulerLoop(everyMs = 60_000, maintenance?: () => Promise<unknown>) {
  const holder = globalThis as typeof globalThis & { __kontrolScheduler?: ReturnType<typeof setInterval> };
  if (holder.__kontrolScheduler) return;
  let ticks = 0;
  const report = (error: unknown) => console.error("scheduler:", error instanceof Error ? error.message : error);
  holder.__kontrolScheduler = setInterval(() => {
    runDueJobs().catch(report);
    // Alert scans and notification delivery run every fifth tick.
    if (maintenance && ++ticks % 5 === 0) maintenance().catch(report);
  }, everyMs);
  holder.__kontrolScheduler.unref?.();
}
