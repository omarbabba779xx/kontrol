import { join } from "node:path";
import { migrateSqliteToPostgres } from "../src/lib/db/migrate";

const sqlitePath = process.env.KONTROL_DATABASE_PATH ?? join(process.cwd(), ".data", "kontrol.db");
const postgresUrl = process.env.POSTGRES_URL;
if (!postgresUrl) {
  console.error("POSTGRES_URL is required");
  process.exit(1);
}

migrateSqliteToPostgres({ sqlitePath, postgresUrl, force: process.argv.includes("--force") })
  .then((report) => {
    for (const { table, rows } of report.tables) console.log(`${table.padEnd(24)} ${rows}`);
    for (const tenant of report.tenants) console.log(`audit chain ${tenant.tenantId}: ${tenant.auditEntries} entries, ${tenant.chainValid ? "valid" : "BROKEN"}`);
    console.log("Migration complete. Set KONTROL_DB_DRIVER=postgres to use it.");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
