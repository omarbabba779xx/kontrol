import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admin, startPglite } from "./setup";

test("SQLite data migrates to PostgreSQL with row counts and audit chain intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kontrol-migrate-"));
  const sqlitePath = join(dir, "source.db");
  process.env.KONTROL_DB_DRIVER = "sqlite";
  process.env.KONTROL_DATABASE_PATH = sqlitePath;

  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  const { recordDecision } = await import("../src/lib/core/decisions");
  const { closeDb, getDb } = await import("../src/lib/db");
  const evaluation = await evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts: { production: true, branchProtection: { enabled: false, requiredReviews: 0 } }, source: "test" });
  await recordDecision(admin, { subjectType: "control", subjectId: "control_branch_protection", outcome: "conditional", conditions: ["enable branch protection"], rationale: "Finding open until protection is enabled.", evidenceIds: [evaluation.evidenceId] });
  const source = await (await getDb()).system().get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log");
  await closeDb();

  const pg = await startPglite();
  try {
    const { migrateSqliteToPostgres } = await import("../src/lib/db/migrate");
    const report = await migrateSqliteToPostgres({ sqlitePath, postgresUrl: pg.url });
    assert.ok(report.tables.find((entry) => entry.table === "evidence")!.rows >= 1);
    assert.equal(report.tenants[0].chainValid, true);
    assert.equal(report.tenants[0].auditEntries, Number(source!.n));
    await assert.rejects(migrateSqliteToPostgres({ sqlitePath, postgresUrl: pg.url }), /not empty/);

    // The application runs on the migrated data and keeps extending the same chain.
    process.env.KONTROL_DB_DRIVER = "postgres";
    process.env.POSTGRES_URL = pg.url;
    process.env.KONTROL_DB_POOL = "2";
    const { verifyAuditChain } = await import("../src/lib/core/integrity");
    await evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts: { production: true, branchProtection: { enabled: true, requiredReviews: 2 } }, source: "test" });
    const chain = await verifyAuditChain(admin.tenantId);
    assert.equal(chain.valid, true);
    assert.equal(chain.checked, Number(source!.n) + 1);
  } finally {
    await (await import("../src/lib/db")).closeDb();
    await pg.stop();
  }
});
