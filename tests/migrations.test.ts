import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import postgres from "postgres";
import { applyPostgres, applySqlite, migrationStatus } from "../src/lib/db/migrations/apply";
import { allTables, MIGRATIONS } from "../src/lib/db/migrations";
import { checksum, MigrationError, planMigrations, validateMigrations, type Migration } from "../src/lib/db/migrations/runner";
import { baselineStatements } from "../src/lib/db/schema";
import { startPglite, usingPostgres } from "./setup";

const baseline = MIGRATIONS[0];
const widgets: Migration = {
  id: 2, name: "widgets",
  up: () => ["CREATE TABLE IF NOT EXISTS widgets ( id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), label TEXT NOT NULL )"],
  tables: ["widgets"],
};
const addColor: Migration = { id: 3, name: "widget_color", up: () => ["ALTER TABLE widgets ADD COLUMN color TEXT NOT NULL DEFAULT 'grey'"] };

test("the migration history is numbered without gaps and lists every baseline table", () => {
  validateMigrations(MIGRATIONS);
  assert.equal(MIGRATIONS[0].id, 1);
  assert.ok(allTables().includes("audit_log") && allTables().includes("tenants"));
  assert.throws(() => validateMigrations([baseline, { ...widgets, id: 3 }]), /without gaps/);
  assert.throws(() => validateMigrations([{ ...baseline, name: "Bad Name" }]), /invalid name/);
});

test("planning refuses a modified, unknown or out-of-order history", () => {
  const applied = [{ id: 1, name: "baseline", checksum: checksum(baseline) }];
  assert.deepEqual(planMigrations(applied, [baseline, widgets]).map((m) => m.id), [2]);
  assert.throws(() => planMigrations([{ ...applied[0], checksum: "tampered" }], [baseline]), /modified after it was applied/);
  assert.throws(() => planMigrations([...applied, { id: 9, name: "future", checksum: "x" }], [baseline]), /newer version/);
  assert.throws(() => planMigrations([{ id: 2, name: "widgets", checksum: checksum(widgets) }], [baseline, widgets]), /gap/);
  assert.notEqual(checksum(widgets), checksum({ ...widgets, up: () => ["CREATE TABLE other (id TEXT)"] }), "the checksum covers the statements");
});

test("SQLite: a fresh database gets the whole history once, and reopening changes nothing", () => {
  const db = new Database(":memory:");
  assert.deepEqual(applySqlite(db, { migrations: [baseline, widgets] }), [1, 2]);
  assert.deepEqual(applySqlite(db, { migrations: [baseline, widgets] }), []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n, 2);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'widgets'").get());
  assert.deepEqual(migrationStatus(db.prepare("SELECT id, name, checksum FROM schema_migrations").all() as never, [baseline, widgets, addColor]).map((s) => s.applied), [true, true, false]);
});

test("SQLite: upgrading keeps existing data and applies only what is new", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applySqlite(db, { migrations: [baseline, widgets] });
  db.prepare("INSERT INTO tenants (id,name,region,created_at) VALUES ('t1','Acme','EU','now')").run();
  db.prepare("INSERT INTO widgets (id,tenant_id,label) VALUES ('w1','t1','first')").run();

  assert.deepEqual(applySqlite(db, { migrations: [baseline, widgets, addColor] }), [3]);
  assert.deepEqual(db.prepare("SELECT label, color FROM widgets").all(), [{ label: "first", color: "grey" }], "the row survives and gets the default");
});

test("SQLite: a failing migration is rolled back completely and can be retried once fixed", () => {
  const db = new Database(":memory:");
  applySqlite(db, { migrations: [baseline] });
  const broken: Migration = { id: 2, name: "broken", up: () => ["CREATE TABLE half_done (id TEXT)", "CREATE TABLE this is not sql"] };
  assert.throws(() => applySqlite(db, { migrations: [baseline, broken] }), (error: Error) => error instanceof MigrationError && /rolled back/.test(error.message));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get(), undefined, "no partial schema");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n, 1);
  assert.deepEqual(applySqlite(db, { migrations: [baseline, { ...broken, up: () => ["CREATE TABLE half_done (id TEXT)"] }] }), [2]);
});

test("SQLite: check mode refuses to start with pending migrations instead of applying them", () => {
  const db = new Database(":memory:");
  applySqlite(db, { migrations: [baseline] });
  assert.throws(() => applySqlite(db, { migrations: [baseline, widgets], check: true }), /pending migration\(s\) \(2 widgets\)/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'widgets'").get(), undefined);
});

test("SQLite: a database created before migrations existed adopts the baseline with its data intact", () => {
  const db = new Database(":memory:");
  for (const statement of baselineStatements("sqlite")) db.exec(statement); // the old way: no schema_migrations table
  db.prepare("INSERT INTO tenants (id,name,region,created_at) VALUES ('legacy','Legacy Co','EU','then')").run();
  assert.deepEqual(applySqlite(db, { migrations: [baseline, widgets] }), [1, 2]);
  assert.equal((db.prepare("SELECT name FROM tenants WHERE id = 'legacy'").get() as { name: string }).name, "Legacy Co");
});

test("SQLite: tampering with the recorded history, or running an older build, stops the start", () => {
  const db = new Database(":memory:");
  applySqlite(db, { migrations: [baseline, widgets] });
  db.prepare("UPDATE schema_migrations SET checksum = 'x' WHERE id = 2").run();
  assert.throws(() => applySqlite(db, { migrations: [baseline, widgets] }), /modified after it was applied/);
  db.prepare("UPDATE schema_migrations SET checksum = ? WHERE id = 2").run(checksum(widgets));
  assert.throws(() => applySqlite(db, { migrations: [baseline] }), /newer version/);
});

test("PostgreSQL: migrations apply under an advisory lock and new tables get forced row-level security", { skip: usingPostgres ? false : "run with KONTROL_TEST_DB=postgres" }, async () => {
  const pg = await startPglite();
  const first = postgres(pg.url, { max: 1, onnotice: () => undefined });
  const second = postgres(pg.url, { max: 1, onnotice: () => undefined });
  try {
    assert.deepEqual(await applyPostgres(first, { migrations: [baseline] }), [1]);
    const [a, b] = await Promise.all([applyPostgres(first, { migrations: [baseline, widgets] }), applyPostgres(second, { migrations: [baseline, widgets] })]);
    assert.equal(a.length + b.length, 1, "exactly one of two concurrent instances applied the migration");

    const rls = await first`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'widgets'`;
    assert.deepEqual([rls[0].relrowsecurity, rls[0].relforcerowsecurity], [true, true]);
    assert.equal((await first`SELECT COUNT(*)::int AS n FROM pg_policies WHERE tablename = 'widgets'`)[0].n, 1);

    await first`INSERT INTO tenants (id,name,region,created_at) VALUES ('t1','A','EU','now'), ('t2','B','EU','now')`;
    await first.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE kontrol_app");
      await tx.unsafe("SELECT set_config('app.tenant_id', 't1', true)");
      await tx.unsafe("INSERT INTO widgets (id,tenant_id,label) VALUES ('w1','t1','mine')");
      await assert.rejects(tx.unsafe("INSERT INTO widgets (id,tenant_id,label) VALUES ('w2','t2','theirs')"), /row-level security/);
    }).catch((error) => { if (!/row-level security/.test(String(error))) throw error; });

    assert.deepEqual(await applyPostgres(first, { migrations: [baseline, widgets, addColor] }), [3]);
    await assert.rejects(applyPostgres(first, { migrations: [baseline, { ...widgets, up: () => ["CREATE TABLE changed (id TEXT)"] }, addColor] }), /modified after it was applied/);
    await assert.rejects(applyPostgres(first, { migrations: [baseline, widgets, addColor, { id: 4, name: "later", up: () => [] }], check: true }), /pending migration/);
  } finally {
    await first.end({ timeout: 2 });
    await second.end({ timeout: 2 });
    await pg.stop();
  }
});
