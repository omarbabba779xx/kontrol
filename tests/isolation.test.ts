import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateDatabase, setEnv, usingPostgres } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

test("several organisations on SQLite are refused in production; one is fine, and PostgreSQL is never refused", { skip: usingPostgres ? "PostgreSQL isolates organisations with row-level security" : false }, async () => {
  const { getDb, assertIsolation } = await import("../src/lib/db");
  const db = await getDb();
  const production = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
  await assertIsolation(db, production);
  await db.system().run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", "tenant_second", "Second organisation", "EU", new Date().toISOString());
  await assertIsolation(db, { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv);
  await assert.rejects(assertIsolation(db, production), /Several organisations on SQLite in production: use PostgreSQL/);
  await assertIsolation({ ...db, dialect: "postgres" } as typeof db, production);
});
