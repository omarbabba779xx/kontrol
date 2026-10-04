import type { Migration } from "@/lib/db/migrations/runner";

/**
 * The records an information security management system keeps (ISO/IEC 27001 clauses 4 to 10): context and interested parties, the
 * approved scope, objectives, management reviews, and nonconformities with their corrective actions. Internal audits are engagements
 * of the audit workspace.
 */
export const isms: Migration = {
  id: 18,
  name: "isms",
  tables: ["isms_context", "isms_scope", "isms_objectives", "isms_reviews", "isms_nonconformities"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS isms_context (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      kind TEXT NOT NULL CHECK(kind IN ('internal_issue','external_issue','interested_party')),
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      requirement TEXT NOT NULL DEFAULT '',
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS isms_scope (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
      statement TEXT NOT NULL,
      boundaries TEXT NOT NULL DEFAULT '',
      exclusions TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS isms_objectives (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      title TEXT NOT NULL,
      measure TEXT NOT NULL,
      target TEXT NOT NULL,
      current_value TEXT NOT NULL DEFAULT '',
      owner_id TEXT REFERENCES users(id),
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('planned','on_track','at_risk','achieved','missed')),
      measured_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS isms_reviews (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      held_at TEXT NOT NULL,
      attendees TEXT NOT NULL,
      inputs_json TEXT NOT NULL,
      decisions TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('draft','approved')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS isms_nonconformities (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      ref TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('internal_audit','external_audit','incident','monitoring','management_review','other')),
      severity TEXT NOT NULL CHECK(severity IN ('major','minor','observation')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      requirement TEXT NOT NULL DEFAULT '',
      uc_code TEXT,
      root_cause TEXT NOT NULL DEFAULT '',
      correction TEXT NOT NULL DEFAULT '',
      corrective_action TEXT NOT NULL DEFAULT '',
      owner_id TEXT REFERENCES users(id),
      due_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('open','action_planned','implemented','closed')),
      effectiveness_note TEXT,
      verified_by TEXT,
      verified_at TEXT,
      raised_by TEXT NOT NULL,
      raised_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, ref)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_isms_context ON isms_context(tenant_id, kind)",
    "CREATE INDEX IF NOT EXISTS idx_isms_objectives ON isms_objectives(tenant_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_isms_reviews ON isms_reviews(tenant_id, held_at)",
    "CREATE INDEX IF NOT EXISTS idx_isms_nc ON isms_nonconformities(tenant_id, status)",
  ],
};
