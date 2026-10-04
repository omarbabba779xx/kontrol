import type { Migration } from "@/lib/db/migrations/runner";

/** The capability level an organisation aims for on each requirement or objective, so the current level can be read as a gap. */
export const capabilityTargets: Migration = {
  id: 21,
  name: "capability_targets",
  tables: ["capability_targets"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS capability_targets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      framework_id TEXT NOT NULL,
      requirement_id TEXT NOT NULL,
      target INTEGER NOT NULL CHECK(target BETWEEN 0 AND 5),
      rationale TEXT NOT NULL DEFAULT '',
      set_by TEXT NOT NULL,
      set_at TEXT NOT NULL,
      UNIQUE(tenant_id, framework_id, requirement_id)
    )`,
  ],
};
