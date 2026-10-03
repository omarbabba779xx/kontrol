import type { Migration } from "@/lib/db/migrations/runner";

/** AI governance: register of AI use cases with their EU AI Act classification, versioned model cards, and fundamental rights impact assessments. */
export const aiGovernance: Migration = {
  id: 8,
  name: "ai_governance",
  tables: ["ai_use_cases", "ai_model_cards", "ai_fria"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS ai_use_cases (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      ref TEXT NOT NULL,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL CHECK(role IN ('provider','deployer','both')),
      owner_id TEXT REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('draft','classified','approved','blocked','retired')),
      answers_json TEXT NOT NULL DEFAULT '{}',
      tier TEXT CHECK(tier IN ('prohibited','high','limited','minimal')),
      classification_json TEXT NOT NULL DEFAULT '{}',
      classified_by TEXT,
      classified_at TEXT,
      approved_by TEXT,
      approved_at TEXT,
      approval_note TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retired_at TEXT,
      UNIQUE(tenant_id, ref)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_model_cards (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      use_case_id TEXT NOT NULL REFERENCES ai_use_cases(id),
      version INTEGER NOT NULL,
      content_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(use_case_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_fria (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      use_case_id TEXT NOT NULL REFERENCES ai_use_cases(id),
      content_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','completed')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT,
      UNIQUE(use_case_id)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_ai_use_cases ON ai_use_cases(tenant_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_ai_model_cards ON ai_model_cards(tenant_id, use_case_id)",
  ],
};
