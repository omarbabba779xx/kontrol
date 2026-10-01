import type { Migration } from "@/lib/db/migrations/runner";

/**
 * Migrations after the baseline, in order. Add new ones at the end with the next id; never edit or reorder one that has shipped.
 */
export const extensions: Migration[] = [];
