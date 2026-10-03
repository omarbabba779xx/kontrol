import type { Migration } from "@/lib/db/migrations/runner";

/** Score history that keeps its reasons: the audit readiness level at the time, and what changed since the previous point. */
export const scoreHistory: Migration = {
  id: 12,
  name: "score_history",
  tables: [],
  up: () => [
    "ALTER TABLE compliance_snapshots ADD COLUMN readiness TEXT",
    "ALTER TABLE compliance_snapshots ADD COLUMN states_json TEXT",
    "ALTER TABLE compliance_snapshots ADD COLUMN changes_json TEXT",
  ],
};
