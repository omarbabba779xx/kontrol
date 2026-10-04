import "server-only";

import { join } from "node:path";
import { bootstrapTenant, shouldSeed } from "@/lib/db/bootstrap";
import { createPostgresDb } from "@/lib/db/postgres";
import { seedDatabase } from "@/lib/db/seed";
import { createSqliteDb } from "@/lib/db/sqlite";
import type { Db } from "@/lib/db/types";

export type { Db, Dialect, Executor, Row, Scope, Tx } from "@/lib/db/types";

type Holder = typeof globalThis & { __kontrolDb?: Promise<Db> };

/**
 * Storage driver selection:
 *  - `KONTROL_DB_DRIVER=postgres` (with `POSTGRES_URL`) runs on PostgreSQL with forced row-level security.
 *  - otherwise the embedded SQLite profile is used (`KONTROL_DATABASE_PATH`).
 */
export function databaseDriver(): "sqlite" | "postgres" {
  return process.env.KONTROL_DB_DRIVER === "postgres" ? "postgres" : "sqlite";
}

/**
 * SQLite separates organisations by a filter in each query; PostgreSQL enforces it in the database with row-level security. One
 * organisation on SQLite has nothing to be separated from, so that is allowed in production. Several are not: a single query that
 * forgot its filter would cross organisations with nothing underneath to stop it.
 */
export async function assertIsolation(db: Db, env: NodeJS.ProcessEnv = process.env) {
  if (db.dialect !== "sqlite" || env.NODE_ENV !== "production") return;
  const row = await db.system().get<{ n: number | string }>("SELECT COUNT(*) AS n FROM tenants");
  if (Number(row?.n ?? 0) > 1) throw new Error("Several organisations on SQLite in production: use PostgreSQL (KONTROL_DB_DRIVER=postgres), which isolates them with row-level security");
}

async function open(): Promise<Db> {
  let db: Db;
  if (databaseDriver() === "postgres") {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("POSTGRES_URL is required when KONTROL_DB_DRIVER=postgres");
    db = await createPostgresDb(url, { max: Number(process.env.KONTROL_DB_POOL ?? 10), migrationUrl: process.env.POSTGRES_MIGRATION_URL, production: process.env.NODE_ENV === "production" });
  } else {
    db = createSqliteDb(process.env.KONTROL_DATABASE_PATH ?? join(process.cwd(), ".data", "kontrol.db"));
  }
  if (shouldSeed()) await seedDatabase(db);
  else await bootstrapTenant(db, process.env, DEFAULT_TENANT_ID);
  await assertIsolation(db);
  return db;
}

/** Shared database handle (one per process). Resolves once the schema is migrated and seeded. */
export function getDb(): Promise<Db> {
  const holder = globalThis as Holder;
  holder.__kontrolDb ??= open().catch((error) => { holder.__kontrolDb = undefined; throw error; });
  return holder.__kontrolDb;
}

export async function closeDb() {
  const holder = globalThis as Holder;
  const pending = holder.__kontrolDb;
  holder.__kontrolDb = undefined;
  if (pending) await (await pending).close();
}

export const DEFAULT_TENANT_ID = "tenant_acme";
export const DEFAULT_USER_ID = "usr_leila";
