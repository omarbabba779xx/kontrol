import type { Migration } from "@/lib/db/migrations/runner";

/** User lifecycle, API keys and encrypted connector credentials. */
export const identity: Migration = {
  id: 2,
  name: "identity_api_keys_credentials",
  tables: ["api_keys", "connector_credentials"],
  up: () => [
    "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE users ADD COLUMN last_login_at TEXT",
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('risk_owner','control_owner','auditor','viewer')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS connector_credentials (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      kind TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      hint TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      rotated_at TEXT NOT NULL,
      UNIQUE(tenant_id, kind)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(tenant_id, user_id)",
  ],
};
