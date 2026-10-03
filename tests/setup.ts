import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

/**
 * Every test file gets its own throwaway database. By default that is SQLite in a temp dir;
 * with `KONTROL_TEST_DB=postgres` it is an in-process PostgreSQL (PGlite) served over a socket,
 * so the real PostgreSQL driver and row-level security are exercised without any external service.
 */
async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Starts an in-process PostgreSQL (PGlite) behind a TCP socket. */
export async function startPglite() {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const db = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 4 });
  await server.start();
  return { url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, stop: async () => { await server.stop(); await db.close(); } };
}

export const usingPostgres = process.env.KONTROL_TEST_DB === "postgres";

export function isolateDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "kontrol-test-"));
  process.env.KONTROL_DATABASE_PATH = join(dir, "kontrol.db");
  let stop: (() => Promise<void>) | undefined;

  before(async () => {
    if (!usingPostgres) return;
    const pg = await startPglite();
    process.env.KONTROL_DB_DRIVER = "postgres";
    process.env.POSTGRES_URL = pg.url;
    process.env.KONTROL_DB_POOL = "2";
    // The embedded server only has a superuser. The runtime-privilege guard has its own test (db-roles.test.ts).
    process.env.KONTROL_ALLOW_PRIVILEGED_DB = "true";
    stop = pg.stop;
  });

  after(async () => {
    const { closeDb } = await import("../src/lib/db");
    await closeDb();
    await stop?.();
  });
  return dir;
}

export function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else (process.env as Record<string, string>)[key] = value;
  }
}

/**
 * Runs SQL as the database owner, bypassing application guards (append-only triggers, row-level security).
 * Used only to simulate an attacker or operator with raw storage access.
 */
export async function ownerExec(sql: string, ...params: unknown[]) {
  if (usingPostgres) {
    const postgres = (await import("postgres")).default;
    const client = postgres(process.env.POSTGRES_URL!, { max: 1, onnotice: () => undefined });
    try {
      await client.unsafe("ALTER TABLE audit_log DISABLE TRIGGER audit_immutable");
      let index = 0;
      await client.unsafe(sql.replace(/\?/g, () => `$${++index}`), params as never[]);
      await client.unsafe("ALTER TABLE audit_log ENABLE TRIGGER audit_immutable");
    } finally {
      await client.end();
    }
    return;
  }
  const { getDb } = await import("../src/lib/db");
  const db = (await getDb()).system();
  await db.run("DROP TRIGGER IF EXISTS audit_no_update");
  await db.run("DROP TRIGGER IF EXISTS audit_no_delete");
  await db.run(sql, ...params);
  const { renderSchema } = await import("../src/lib/db/schema");
  for (const statement of renderSchema("sqlite")) if (statement.startsWith("CREATE TRIGGER")) await db.run(statement);
}

export const admin = { userId: "usr_leila", tenantId: "tenant_acme", email: "leila@acme.example", name: "Leila Mansour", role: "admin" as const };
export const riskOwner = { userId: "usr_maya", tenantId: "tenant_acme", email: "maya@acme.example", name: "Maya Chen", role: "risk_owner" as const };
