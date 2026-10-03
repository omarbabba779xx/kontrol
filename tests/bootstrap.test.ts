import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SEED: "false", KONTROL_BOOTSTRAP_ADMIN_EMAIL: "Owner@Example.org", KONTROL_BOOTSTRAP_TENANT_NAME: "Example Org", OIDC_DEFAULT_TENANT_ID: "tenant_example" });

test("seeding the demonstration tenant is opt-in in production and opt-out elsewhere", async () => {
  const { shouldSeed } = await import("../src/lib/db/bootstrap");
  assert.equal(shouldSeed({ NODE_ENV: "production" }), false, "a production start never loads demo data by default");
  assert.equal(shouldSeed({ NODE_ENV: "production", KONTROL_SEED: "false" }), false);
  assert.equal(shouldSeed({ NODE_ENV: "production", KONTROL_SEED: "true" }), true);
  assert.equal(shouldSeed({ NODE_ENV: "development" }), true);
  assert.equal(shouldSeed({ NODE_ENV: "development", KONTROL_SEED: "false" }), false);
});

test("an empty database gets its first organisation and administrator, with no demonstration data", async () => {
  const { getDb } = await import("../src/lib/db");
  const system = (await getDb()).system();
  const tenants = await system.all<{ id: string; name: string }>("SELECT id, name FROM tenants");
  assert.deepEqual(tenants, [{ id: "tenant_example", name: "Example Org" }]);
  const users = await system.all<{ email: string; role: string }>("SELECT email, role FROM users");
  assert.deepEqual(users, [{ email: "owner@example.org", role: "admin" }]);
  for (const table of ["assets", "controls", "evidence", "risks", "vendors", "ai_models"]) {
    assert.equal(Number((await system.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n), 0, `${table} is empty`);
  }
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  const chain = await verifyAuditChain("tenant_example");
  assert.equal(chain.valid, true);
  assert.equal(chain.checked, 1);
});

test("the bootstrap is idempotent and the administrator can act", async () => {
  const { getDb } = await import("../src/lib/db");
  const { bootstrapTenant } = await import("../src/lib/db/bootstrap");
  const db = await getDb();
  assert.deepEqual(await bootstrapTenant(db, process.env), { created: false });
  assert.equal(Number((await db.system().get<{ n: number }>("SELECT COUNT(*) AS n FROM tenants"))?.n), 1);
  await assert.rejects(bootstrapTenant({ ...db, system: () => ({ get: async () => ({ count: 0 }) }) } as never, { KONTROL_BOOTSTRAP_ADMIN_EMAIL: "not-an-email" }), /not a valid email/);

  const user = await db.system().get<{ id: string }>("SELECT id FROM users");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const token = await issueSessionToken({ userId: user!.id, tenantId: "tenant_example", email: "owner@example.org", name: "owner", role: "admin" });
  const { GET } = await import("../src/app/api/me/route");
  const me = await GET(new Request("http://localhost/api/me", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { role: string }).role, "admin");
});
