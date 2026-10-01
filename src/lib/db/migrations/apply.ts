import "server-only";

import type Database from "better-sqlite3";
import type { Sql } from "postgres";
import { rlsStatements } from "@/lib/db/schema";
import { MIGRATIONS } from "@/lib/db/migrations";
import { checksum, MIGRATIONS_TABLE_SQL, MigrationError, planMigrations, type AppliedMigration, type Migration } from "@/lib/db/migrations/runner";

export { MigrationError };

/** Arbitrary constant so concurrent instances serialise on one advisory lock while migrating. */
const LOCK_KEY = 727_274;

const pendingMessage = (pending: Migration[]) => `${pending.length} pending migration(s) (${pending.map((migration) => `${migration.id} ${migration.name}`).join(", ")}). Run \`npm run db:upgrade\`, or unset KONTROL_AUTO_MIGRATE.`;

export type MigrationOptions = { migrations?: Migration[]; /** Fail instead of applying when migrations are pending. */ check?: boolean };

/** Applies pending migrations to SQLite, each in its own transaction, re-checking under the write lock so two processes cannot both apply one. */
export function applySqlite(db: Database.Database, options: MigrationOptions = {}) {
  const migrations = options.migrations ?? MIGRATIONS;
  db.exec(MIGRATIONS_TABLE_SQL);
  const applied = db.prepare("SELECT id, name, checksum FROM schema_migrations ORDER BY id").all() as AppliedMigration[];
  const pending = planMigrations(applied, migrations);
  if (options.check && pending.length) throw new MigrationError(pendingMessage(pending));

  const done: number[] = [];
  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(migration.id)) { db.exec("COMMIT"); continue; }
      for (const statement of migration.up("sqlite")) db.exec(statement);
      db.prepare("INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(migration.id, migration.name, checksum(migration), new Date().toISOString());
      db.exec("COMMIT");
      done.push(migration.id);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new MigrationError(`Migration ${migration.id} (${migration.name}) failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return done;
}

/** Applies pending migrations to PostgreSQL in one transaction under an advisory lock, adding row-level security for the tables each creates. */
export async function applyPostgres(sql: Pick<Sql, "begin">, options: MigrationOptions = {}) {
  const migrations = options.migrations ?? MIGRATIONS;
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    await tx.unsafe(MIGRATIONS_TABLE_SQL);
    const applied = [...(await tx.unsafe("SELECT id, name, checksum FROM schema_migrations ORDER BY id"))] as unknown as AppliedMigration[];
    const pending = planMigrations(applied, migrations);
    if (options.check && pending.length) throw new MigrationError(pendingMessage(pending));
    const done: number[] = [];
    for (const migration of pending) {
      try {
        for (const statement of migration.up("postgres")) await tx.unsafe(statement);
        if (migration.tables?.length) for (const statement of rlsStatements(migration.tables)) await tx.unsafe(statement);
        await tx.unsafe("INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES ($1, $2, $3, $4)", [migration.id, migration.name, checksum(migration), new Date().toISOString()]);
        done.push(migration.id);
      } catch (error) {
        throw new MigrationError(`Migration ${migration.id} (${migration.name}) failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return done;
  })) as number[];
}

export function migrationStatus(applied: AppliedMigration[], migrations: Migration[] = MIGRATIONS) {
  const known = new Set(applied.map((row) => Number(row.id)));
  return migrations.map((migration) => ({ id: migration.id, name: migration.name, applied: known.has(migration.id) }));
}
