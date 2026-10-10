import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SEED: "empty" });

test("the empty seed is an evaluation convenience: never in production, and distinct from no seed", async () => {
  const { seedMode } = await import("../src/lib/db/bootstrap");
  assert.equal(seedMode({ NODE_ENV: "development", KONTROL_SEED: "empty" }), "empty");
  assert.equal(seedMode({ NODE_ENV: "production", KONTROL_SEED: "empty" }), "none");
  assert.equal(seedMode({ NODE_ENV: "development" }), "sample");
  assert.equal(seedMode({ NODE_ENV: "development", KONTROL_SEED: "false" }), "none");
  assert.equal(seedMode({ NODE_ENV: "production", KONTROL_SEED: "true" }), "sample");
});

test("an empty seed creates the organisation and its administrator, and not one sample record", async () => {
  const { getDb } = await import("../src/lib/db");
  const system = (await getDb()).system();
  assert.deepEqual(await system.all("SELECT id, name FROM tenants"), [{ id: "tenant_acme", name: "Organisation" }]);
  assert.deepEqual(await system.all("SELECT id, name, role FROM users"), [{ id: "usr_leila", name: "Administrator", role: "admin" }]);
  for (const table of ["assets", "obligations", "controls", "graph_edges", "evidence", "risks", "vendors", "ai_models", "model_evaluations", "connectors"]) {
    assert.equal(Number((await system.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n), 0, `${table} is empty`);
  }
});

test("demo sign-in works on the empty organisation", async () => {
  const { authenticate } = await import("../src/lib/core/auth");
  const actor = await authenticate(new Request("http://localhost/api/me"));
  assert.deepEqual({ userId: actor?.userId, name: actor?.name, role: actor?.role }, { userId: "usr_leila", name: "Administrator", role: "admin" });
});
