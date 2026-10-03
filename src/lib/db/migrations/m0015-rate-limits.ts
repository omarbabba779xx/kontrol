import { APP_ROLE } from "@/lib/db/schema";
import type { Migration } from "@/lib/db/migrations/runner";

/**
 * Counters for limits that must hold across instances. Not tenant data: the key says what is limited (a client address, a tenant's
 * ingest, an authentication failure), so the table has no tenant column and no row-level security.
 */
export const rateLimits: Migration = {
  id: 15,
  name: "rate_limits",
  tables: [],
  up: (dialect) => [
    `CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start ${dialect === "postgres" ? "BIGINT" : "INTEGER"} NOT NULL,
      count INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start)",
    ...(dialect === "postgres" ? [`GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO ${APP_ROLE}`] : []),
  ],
};
