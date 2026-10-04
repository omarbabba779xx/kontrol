import type { Migration } from "@/lib/db/migrations/runner";

/**
 * The operating records of the management system: planned changes (6.3), competence (7.2), the communication plan (7.4), security
 * incidents, and the plan and conclusion of each internal audit (9.2). Audit findings and incidents link to nonconformities.
 */
export const ismsOperations: Migration = {
  id: 20,
  name: "isms_operations",
  tables: ["isms_records", "isms_incidents", "internal_audit_plans"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS isms_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      kind TEXT NOT NULL CHECK(kind IN ('change','competence','communication')),
      title TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      owner_id TEXT REFERENCES users(id),
      due_at TEXT,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS isms_incidents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      ref TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
      status TEXT NOT NULL CHECK(status IN ('reported','contained','resolved','closed')),
      detected_at TEXT NOT NULL,
      asset_id TEXT,
      personal_data INTEGER NOT NULL DEFAULT 0,
      notification_due TEXT,
      notified_at TEXT,
      notification_note TEXT,
      owner_id TEXT REFERENCES users(id),
      root_cause TEXT NOT NULL DEFAULT '',
      lessons TEXT NOT NULL DEFAULT '',
      nonconformity_id TEXT,
      no_nonconformity_reason TEXT,
      reported_by TEXT NOT NULL,
      reported_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE(tenant_id, ref)
    )`,
    `CREATE TABLE IF NOT EXISTS internal_audit_plans (
      engagement_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      objectives TEXT NOT NULL,
      criteria TEXT NOT NULL,
      auditor_id TEXT NOT NULL REFERENCES users(id),
      uc_codes_json TEXT NOT NULL DEFAULT '[]',
      conclusion TEXT,
      concluded_at TEXT,
      planned_by TEXT NOT NULL,
      planned_at TEXT NOT NULL
    )`,
    "ALTER TABLE isms_nonconformities ADD COLUMN audit_id TEXT",
    "ALTER TABLE isms_nonconformities ADD COLUMN incident_id TEXT",
    "CREATE INDEX IF NOT EXISTS idx_isms_records ON isms_records(tenant_id, kind)",
    "CREATE INDEX IF NOT EXISTS idx_isms_incidents ON isms_incidents(tenant_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_internal_audit_plans ON internal_audit_plans(tenant_id)",
  ],
};
