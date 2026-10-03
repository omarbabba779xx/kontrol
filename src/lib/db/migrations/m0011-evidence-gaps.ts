import type { Migration } from "@/lib/db/migrations/runner";

/** What a collection could not do: controls skipped for lack of access, controls with no object for the target. Replaced on the next collection. */
export const evidenceGaps: Migration = {
  id: 11,
  name: "evidence_gaps",
  tables: ["evidence_gaps"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS evidence_gaps (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      connector TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      control_code TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('skipped','not_applicable')),
      detail_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE(tenant_id, asset_id, control_code)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_evidence_gaps ON evidence_gaps(tenant_id, control_code)",
  ],
};
