import type { Migration } from "@/lib/db/migrations/runner";

/** Whether an anchor has been written to the external sink, so a failed publication is retried instead of forgotten. */
export const anchorPublication: Migration = {
  id: 16,
  name: "anchor_publication",
  tables: [],
  up: () => ["ALTER TABLE audit_anchors ADD COLUMN published_at TEXT", "ALTER TABLE audit_anchors ADD COLUMN publish_error TEXT"],
};
