import type { Migration } from "@/lib/db/migrations/runner";

/**
 * The organisation's risk method (criteria, appetite, scales) and the NIST SP 800-30 description of a risk: threat source, threat
 * event, vulnerability, predisposing conditions and the two parts of likelihood. A risk can also point at an asset of the inventory.
 */
export const riskMethod: Migration = {
  id: 17,
  name: "risk_method",
  tables: ["risk_methods"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS risk_methods (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
      method TEXT NOT NULL CHECK(method IN ('iso27005','nist_800_30')),
      threshold_medium INTEGER NOT NULL,
      threshold_high INTEGER NOT NULL,
      threshold_critical INTEGER NOT NULL,
      appetite TEXT NOT NULL CHECK(appetite IN ('low','medium','high')),
      max_acceptance_days INTEGER NOT NULL,
      scales_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL
    )`,
    "ALTER TABLE risk_items ADD COLUMN threat_source TEXT",
    "ALTER TABLE risk_items ADD COLUMN threat_event TEXT",
    "ALTER TABLE risk_items ADD COLUMN vulnerability TEXT",
    "ALTER TABLE risk_items ADD COLUMN predisposing_conditions TEXT",
    "ALTER TABLE risk_items ADD COLUMN likelihood_initiation INTEGER",
    "ALTER TABLE risk_items ADD COLUMN likelihood_impact INTEGER",
    "ALTER TABLE risk_items ADD COLUMN asset_id TEXT",
  ],
};
