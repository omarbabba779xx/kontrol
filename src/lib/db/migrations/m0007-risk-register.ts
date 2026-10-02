import type { Migration } from "@/lib/db/migrations/runner";

/** ISO 27005-style risk register: inherent rating, linked controls, treatment, time-boxed acceptance and an optional quantified (FAIR) estimate. */
export const riskRegister: Migration = {
  id: 7,
  name: "risk_register",
  tables: ["risk_items", "risk_item_controls"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS risk_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      ref TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL CHECK(category IN ('cyber','privacy','third_party','ai','resilience','compliance','operational')),
      asset TEXT NOT NULL DEFAULT '',
      owner_id TEXT REFERENCES users(id),
      likelihood INTEGER NOT NULL CHECK(likelihood BETWEEN 1 AND 5),
      impact INTEGER NOT NULL CHECK(impact BETWEEN 1 AND 5),
      treatment TEXT NOT NULL CHECK(treatment IN ('undecided','mitigate','accept','transfer','avoid')),
      treatment_plan TEXT NOT NULL DEFAULT '',
      target_date TEXT,
      status TEXT NOT NULL CHECK(status IN ('identified','treating','accepted','closed')),
      accepted_by TEXT,
      accepted_at TEXT,
      accepted_until TEXT,
      acceptance_note TEXT,
      fair_mean INTEGER,
      fair_p90 INTEGER,
      fair_scenario_json TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      close_note TEXT,
      UNIQUE(tenant_id, ref)
    )`,
    `CREATE TABLE IF NOT EXISTS risk_item_controls (
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      risk_id TEXT NOT NULL REFERENCES risk_items(id),
      uc_code TEXT NOT NULL,
      PRIMARY KEY (risk_id, uc_code)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_risk_items ON risk_items(tenant_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_risk_item_controls ON risk_item_controls(tenant_id, uc_code)",
  ],
};
