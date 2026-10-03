import { createHash } from "node:crypto";
import type { Dialect } from "@/lib/db/types";

/**
 * A migration is an ordered, immutable schema change. `up` returns the statements for a dialect; `tables` lists the
 * tenant tables the migration creates, so PostgreSQL row-level security can be applied to them automatically.
 * Statements use the portable tokens of schema.ts ({{REAL}}, {{BIGINT}}, {{SEQUENCE}}).
 */
export type Migration = {
  id: number;
  name: string;
  up: (dialect: Dialect) => string[];
  tables?: readonly string[];
};

export type AppliedMigration = { id: number; name: string; checksum: string };

export class MigrationError extends Error {
  constructor(message: string) { super(message); this.name = "MigrationError"; }
}

/** A migration that was already applied must never change: its checksum covers both dialects. */
export function checksum(migration: Migration) {
  return createHash("sha256").update(JSON.stringify({ id: migration.id, name: migration.name, sqlite: migration.up("sqlite"), postgres: migration.up("postgres"), tables: migration.tables ?? [] })).digest("hex");
}

export function validateMigrations(migrations: Migration[]) {
  migrations.forEach((migration, index) => {
    if (migration.id !== index + 1) throw new MigrationError(`Migrations must be numbered 1..n without gaps; found ${migration.id} at position ${index + 1}`);
    if (!/^[a-z0-9_]+$/.test(migration.name)) throw new MigrationError(`Migration ${migration.id} has an invalid name "${migration.name}"`);
  });
}

/** Returns the migrations still to apply, after proving that what was applied matches this build. */
export function planMigrations(applied: AppliedMigration[], migrations: Migration[]) {
  validateMigrations(migrations);
  const known = new Map(migrations.map((migration) => [migration.id, migration]));
  for (const row of applied) {
    const migration = known.get(Number(row.id));
    if (!migration) throw new MigrationError(`The database has migration ${row.id} (${row.name}), which this version does not know: it was migrated by a newer version. Upgrade the application instead of running it against this database.`);
    if (row.checksum !== checksum(migration)) throw new MigrationError(`Migration ${row.id} (${row.name}) was modified after it was applied. Migrations are immutable: add a new one instead.`);
  }
  const done = new Set(applied.map((row) => Number(row.id)));
  const missing = migrations.filter((migration) => !done.has(migration.id));
  const firstPending = missing[0]?.id;
  if (firstPending !== undefined && applied.some((row) => Number(row.id) > firstPending)) throw new MigrationError(`Migration ${firstPending} is pending but later ones are applied; the history has a gap`);
  return missing;
}

export const MIGRATIONS_TABLE_SQL = "CREATE TABLE IF NOT EXISTS schema_migrations ( id INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL )";
