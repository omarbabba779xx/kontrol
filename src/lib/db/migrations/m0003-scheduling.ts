import type { Migration } from "@/lib/db/migrations/runner";

/** Scheduled connector runs and their history. */
export const scheduling: Migration = {
  id: 3,
  name: "connector_schedules_job_runs",
  tables: ["connector_schedules", "job_runs"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS connector_schedules (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      kind TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      params_json TEXT NOT NULL DEFAULT '{}',
      interval_minutes INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT NOT NULL,
      claimed_at TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, kind, target)
    )`,
    `CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      schedule_id TEXT,
      kind TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      trigger TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ok','failed')),
      summary_json TEXT NOT NULL DEFAULT '{}',
      error TEXT
    )`,
    "CREATE INDEX IF NOT EXISTS idx_schedules_due ON connector_schedules(enabled, next_run_at)",
    "CREATE INDEX IF NOT EXISTS idx_job_runs_tenant ON job_runs(tenant_id, started_at)",
  ],
};
