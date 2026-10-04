import type { Migration } from "@/lib/db/migrations/runner";

/**
 * Asset-based risk identification: what each asset is worth in confidentiality, integrity and availability, and for each risk the
 * threat it comes from and the impact on each of those properties.
 */
export const assetValuation: Migration = {
  id: 19,
  name: "asset_valuation",
  tables: ["asset_valuations"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS asset_valuations (
      asset_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      confidentiality INTEGER NOT NULL CHECK(confidentiality BETWEEN 1 AND 5),
      integrity INTEGER NOT NULL CHECK(integrity BETWEEN 1 AND 5),
      availability INTEGER NOT NULL CHECK(availability BETWEEN 1 AND 5),
      rationale TEXT NOT NULL DEFAULT '',
      valued_by TEXT NOT NULL,
      valued_at TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_asset_valuations ON asset_valuations(tenant_id)",
    "ALTER TABLE risk_items ADD COLUMN threat_id TEXT",
    "ALTER TABLE risk_items ADD COLUMN impact_c INTEGER",
    "ALTER TABLE risk_items ADD COLUMN impact_i INTEGER",
    "ALTER TABLE risk_items ADD COLUMN impact_a INTEGER",
  ],
};
