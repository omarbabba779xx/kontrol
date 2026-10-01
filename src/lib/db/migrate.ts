import "server-only";

import Database from "better-sqlite3";
import postgres from "postgres";
import { verifyAuditChainRows } from "@/lib/core/integrity";
import { createPostgresDb } from "@/lib/db/postgres";
import { TABLES } from "@/lib/db/schema";

export type MigrationReport = {
  tables: Array<{ table: string; rows: number }>;
  tenants: Array<{ tenantId: string; auditEntries: number; chainValid: boolean }>;
};

type SqliteRow = Record<string, unknown>;

const CHUNK = 200;

function columnsOf(sqlite: Database.Database, table: string) {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
}

/**
 * Copies an embedded SQLite deployment into PostgreSQL, preserving audit sequence numbers so the hash chain
 * stays verifiable, then re-verifies every tenant's chain on the target and compares row counts.
 * Refuses to run against a non-empty target unless `force` is set.
 */
export async function migrateSqliteToPostgres(options: { sqlitePath: string; postgresUrl: string; force?: boolean }): Promise<MigrationReport> {
  const sqlite = new Database(options.sqlitePath, { readonly: true, fileMustExist: true });
  const db = await createPostgresDb(options.postgresUrl, { max: 2 });
  try {
    const system = db.system();
    const existing = await system.get<{ n: number }>("SELECT COUNT(*) AS n FROM tenants");
    if (Number(existing?.n) > 0 && !options.force) throw new Error("Target database is not empty; pass force to overwrite");

    const report: MigrationReport = { tables: [], tenants: [] };
    await system.transaction(async (tx) => {
      // Children first so foreign keys never block a forced re-run. The audit log is append-only by trigger,
      // so a forced run requires an empty ledger and is otherwise rejected by the database.
      if (options.force) for (const table of [...TABLES].reverse()) if (table !== "audit_log") await tx.run(`DELETE FROM ${table}`);

      for (const table of TABLES) {
        const columns = columnsOf(sqlite, table);
        const rows = sqlite.prepare(`SELECT * FROM ${table}${table === "audit_log" ? " ORDER BY sequence" : ""}`).all() as SqliteRow[];
        const insert = `INSERT INTO ${table} (${columns.join(",")}) ${table === "audit_log" ? "OVERRIDING SYSTEM VALUE " : ""}VALUES (${columns.map(() => "?").join(",")})`;
        for (let offset = 0; offset < rows.length; offset += CHUNK) {
          for (const row of rows.slice(offset, offset + CHUNK)) await tx.run(insert, ...columns.map((column) => row[column] ?? null));
        }
        report.tables.push({ table, rows: rows.length });
      }
    });

    // Advancing the identity sequence needs ownership, which the runtime application role deliberately lacks.
    const owner = postgres(options.postgresUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner.unsafe("SELECT setval(pg_get_serial_sequence('audit_log','sequence'), COALESCE((SELECT MAX(sequence) FROM audit_log), 1), (SELECT COUNT(*) FROM audit_log) > 0)");
    } finally {
      await owner.end();
    }

    for (const { table, rows } of report.tables) {
      const copied = await system.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      if (Number(copied?.n) !== rows) throw new Error(`Row count mismatch for ${table}: source ${rows}, target ${copied?.n}`);
    }
    const tenants = await system.all<{ id: string }>("SELECT id FROM tenants ORDER BY id");
    for (const tenant of tenants) {
      const entries = await db.scope(tenant.id).all<Record<string, unknown>>("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY sequence", tenant.id);
      const verdict = verifyAuditChainRows(entries);
      report.tenants.push({ tenantId: tenant.id, auditEntries: entries.length, chainValid: verdict.valid });
      if (!verdict.valid) throw new Error(`Audit chain for ${tenant.id} failed verification after migration`);
    }
    return report;
  } finally {
    sqlite.close();
    await db.close();
  }
}
