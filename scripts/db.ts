// Schema migrations.
//   npm run db:status     shows applied and pending migrations (changes nothing)
//   npm run db:upgrade    applies pending migrations
// Uses KONTROL_DB_DRIVER / KONTROL_DATABASE_PATH / POSTGRES_URL like the application.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { applyPostgres, applySqlite, migrationStatus } from "../src/lib/db/migrations/apply";
import { MIGRATIONS } from "../src/lib/db/migrations";
import { planMigrations, type AppliedMigration } from "../src/lib/db/migrations/runner";

const command = process.argv[2];
if (command !== "status" && command !== "upgrade") { console.error("Usage: npm run db:status | npm run db:upgrade"); process.exit(1); }

async function main() {
  if (process.env.KONTROL_DB_DRIVER === "postgres") {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("POSTGRES_URL is required when KONTROL_DB_DRIVER=postgres");
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      if (command === "upgrade") console.log(`Applied: ${(await applyPostgres(sql)).join(", ") || "nothing to do"}`);
      const exists = (await sql`SELECT to_regclass('schema_migrations') AS name`)[0].name;
      const applied = exists ? ([...(await sql`SELECT id, name, checksum FROM schema_migrations ORDER BY id`)] as unknown as AppliedMigration[]) : [];
      report(applied);
    } finally { await sql.end({ timeout: 2 }); }
    return;
  }
  const path = process.env.KONTROL_DATABASE_PATH ?? join(process.cwd(), ".data", "kontrol.db");
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    if (command === "upgrade") console.log(`Applied: ${applySqlite(db).join(", ") || "nothing to do"}`);
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get();
    report(hasTable ? (db.prepare("SELECT id, name, checksum FROM schema_migrations ORDER BY id").all() as AppliedMigration[]) : []);
  } finally { db.close(); }
}

function report(applied: AppliedMigration[]) {
  const pending = planMigrations(applied, MIGRATIONS);
  for (const item of migrationStatus(applied)) console.log(`${item.applied ? "applied " : "pending "} ${String(item.id).padStart(4, "0")}  ${item.name}`);
  console.log(pending.length ? `${pending.length} pending` : "Schema is up to date.");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
