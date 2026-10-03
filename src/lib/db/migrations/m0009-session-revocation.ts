import type { Migration } from "@/lib/db/migrations/runner";

/** Per-user session revocation: sessions issued at or before this instant stop working. */
export const sessionRevocation: Migration = {
  id: 9,
  name: "session_revocation",
  tables: [],
  up: () => ["ALTER TABLE users ADD COLUMN sessions_valid_after TEXT"],
};
