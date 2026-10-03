import { extensions } from "@/lib/db/migrations/extensions";
import { type Migration, validateMigrations } from "@/lib/db/migrations/runner";
import { baselineStatements, TABLES } from "@/lib/db/schema";

export type { AppliedMigration, Migration } from "@/lib/db/migrations/runner";

/**
 * The ordered schema history. Migration 1 is the schema as it stood when migrations were introduced; it is idempotent
 * (`CREATE ... IF NOT EXISTS`), so databases created before the migration system adopt it without losing data.
 * Every later change is a new migration with the next number: never edit one that has shipped (its checksum is recorded).
 */
const baseline: Migration = { id: 1, name: "baseline", up: baselineStatements, tables: TABLES };

export const MIGRATIONS: Migration[] = [baseline, ...extensions];
validateMigrations(MIGRATIONS);

/** Every tenant table, in creation order, across all migrations. */
export function allTables(migrations: Migration[] = MIGRATIONS): string[] {
  return [...new Set(migrations.flatMap((migration) => [...(migration.tables ?? [])]))];
}
