import type { Migration } from "@/lib/db/migrations/runner";

/** Workflow execution: an atomic claim with a lease, an idempotency key at start, and a record of every step attempt. */
export const workflowExecution: Migration = {
  id: 10,
  name: "workflow_execution",
  tables: ["workflow_steps"],
  up: () => [
    "ALTER TABLE workflows ADD COLUMN claimed_at TEXT",
    "ALTER TABLE workflows ADD COLUMN idempotency_key TEXT",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_idempotency ON workflows(tenant_id, idempotency_key)",
    `CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      workflow_id TEXT NOT NULL REFERENCES workflows(id),
      step TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ok','blocked','failed')),
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      output_json TEXT NOT NULL DEFAULT '{}',
      output_sha256 TEXT NOT NULL,
      error TEXT,
      UNIQUE(workflow_id, step, attempt)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_workflow_steps ON workflow_steps(tenant_id, workflow_id)",
  ],
};
