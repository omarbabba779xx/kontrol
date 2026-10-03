import type { Migration } from "@/lib/db/migrations/runner";

/** Signed checkpoints of the audit chain head, meant to be copied outside the database so truncating the chain can be detected. */
export const auditAnchors: Migration = {
  id: 13,
  name: "audit_anchors",
  tables: ["audit_anchors"],
  up: () => [
    `CREATE TABLE IF NOT EXISTS audit_anchors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      entries INTEGER NOT NULL,
      head_hash TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(tenant_id, entries)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_audit_anchors ON audit_anchors(tenant_id, entries)",
  ],
};
