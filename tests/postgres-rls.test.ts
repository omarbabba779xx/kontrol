import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateDatabase, usingPostgres } from "./setup";

isolateDatabase();

const skip = usingPostgres ? false : "run with KONTROL_TEST_DB=postgres";

async function addTenant(id: string) {
  const { getDb } = await import("../src/lib/db");
  const system = (await getDb()).system();
  await system.run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", id, `Tenant ${id}`, "EU", new Date().toISOString());
  await system.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", `usr_${id}`, id, `${id}@example.test`, id, "admin", new Date().toISOString());
}

test("a tenant scope only sees its own rows, even without a WHERE clause", { skip }, async () => {
  const { getDb } = await import("../src/lib/db");
  await addTenant("tenant_b");
  const db = await getDb();
  const own = await db.scope("tenant_acme").all<{ tenant_id: string }>("SELECT tenant_id FROM users");
  assert.ok(own.length > 0);
  assert.ok(own.every((row) => row.tenant_id === "tenant_acme"));
  const other = await db.scope("tenant_b").all<{ tenant_id: string }>("SELECT tenant_id FROM users");
  assert.deepEqual([...new Set(other.map((row) => row.tenant_id))], ["tenant_b"]);
  assert.equal((await db.scope("tenant_nobody").all("SELECT * FROM users")).length, 0);
});

test("a tenant scope cannot write rows for another tenant", { skip }, async () => {
  const { getDb } = await import("../src/lib/db");
  const db = await getDb();
  await assert.rejects(db.scope("tenant_acme").run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", "usr_x", "tenant_b", "x@example.test", "x", "viewer", new Date().toISOString()), /row-level security/);
  const updated = await db.scope("tenant_acme").run("UPDATE users SET name = 'hijacked' WHERE tenant_id = 'tenant_b'");
  assert.equal(updated.changes, 0);
  const deleted = await db.scope("tenant_acme").run("DELETE FROM users WHERE tenant_id = 'tenant_b'");
  assert.equal(deleted.changes, 0);
});

test("the audit chains of different tenants are independent and verify", { skip }, async () => {
  const { appendAudit, verifyAuditChain } = await import("../src/lib/core/integrity");
  await addTenant("tenant_c");
  await appendAudit({ tenantId: "tenant_c", actorId: "usr_tenant_c", action: "test", objectType: "t", objectId: "1", payload: {} });
  await appendAudit({ tenantId: "tenant_acme", actorId: "usr_leila", action: "test", objectType: "t", objectId: "2", payload: {} });
  assert.equal((await verifyAuditChain("tenant_c")).checked, 1);
  assert.equal((await verifyAuditChain("tenant_c")).valid, true);
  assert.equal((await verifyAuditChain("tenant_acme")).valid, true);
});

test("readiness reports row-level security forced on every tenant table", { skip }, async () => {
  const { runtimeReadiness } = await import("../src/lib/core/enterprise-engine");
  const { allTables } = await import("../src/lib/db/migrations");
  const check = (await runtimeReadiness()).find((entry) => entry.service === "PostgreSQL + RLS");
  assert.equal(check?.status, "active");
  assert.match(check!.detail, new RegExp(`forced on ${allTables().length} tables`));
});
