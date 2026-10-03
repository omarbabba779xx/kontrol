import type { Migration } from "@/lib/db/migrations/runner";

/** Audit engagements, expiring auditor access, auditor requests and their conversation; plus external (engagement-scoped) users. */
export const auditWorkspace: Migration = {
  id: 5,
  name: "audit_workspace",
  tables: ["audit_engagements", "audit_access", "audit_requests", "audit_events"],
  up: () => [
    "ALTER TABLE users ADD COLUMN external INTEGER NOT NULL DEFAULT 0",
    `CREATE TABLE IF NOT EXISTS audit_engagements (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      framework_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('soc2_type1','soc2_type2','iso27001_certification','internal','other')),
      scope TEXT NOT NULL DEFAULT '',
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      auditor_org TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('planning','fieldwork','review','closed')),
      lead_id TEXT REFERENCES users(id),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS audit_access (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      engagement_id TEXT NOT NULL REFERENCES audit_engagements(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      revoked_at TEXT,
      UNIQUE(engagement_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS audit_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      engagement_id TEXT NOT NULL REFERENCES audit_engagements(id),
      ref TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      uc_code TEXT,
      assignee_id TEXT REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('open','provided','accepted','needs_more')),
      due_at TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(engagement_id, ref)
    )`,
    `CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      engagement_id TEXT NOT NULL,
      request_id TEXT REFERENCES audit_requests(id),
      kind TEXT NOT NULL CHECK(kind IN ('response','comment','status','download')),
      author_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      reference_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_audit_engagements ON audit_engagements(tenant_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_audit_access_user ON audit_access(tenant_id, user_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_requests ON audit_requests(tenant_id, engagement_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_audit_events ON audit_events(tenant_id, engagement_id, request_id)",
  ],
};
