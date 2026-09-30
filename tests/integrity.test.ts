import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase } from "./setup";

isolateDatabase();

test("audit chain verifies and detects tampering", async () => {
  const { appendAudit, verifyAuditChain } = await import("../src/lib/core/integrity");
  const { getDb } = await import("../src/lib/core/database");
  for (let i = 0; i < 4; i++) appendAudit({ tenantId: admin.tenantId, actorId: admin.userId, action: "test.event", objectType: "test", objectId: `obj_${i}`, payload: { i } });
  const before = verifyAuditChain(admin.tenantId);
  assert.equal(before.valid, true);
  assert.ok(before.checked >= 4);

  const victim = getDb().prepare("SELECT id FROM audit_log WHERE object_id = 'obj_1'").get() as { id: string };
  getDb().prepare("UPDATE audit_log SET payload_json = ? WHERE id = ?").run(JSON.stringify({ i: 999 }), victim.id);
  const after = verifyAuditChain(admin.tenantId);
  assert.equal(after.valid, false);
  assert.equal((after as { brokenAt?: unknown }).brokenAt, victim.id);
});

test("audit chain detects a removed entry", async () => {
  const { appendAudit, verifyAuditChain } = await import("../src/lib/core/integrity");
  const { getDb } = await import("../src/lib/core/database");
  const tenant = "tenant_acme";
  for (let i = 0; i < 3; i++) appendAudit({ tenantId: tenant, actorId: admin.userId, action: "test.gap", objectType: "test", objectId: `gap_${i}`, payload: {} });
  getDb().prepare("DELETE FROM audit_log WHERE object_id = 'gap_1'").run();
  assert.equal(verifyAuditChain(tenant).valid, false);
});

test("sha256 matches a known vector", async () => {
  const { sha256 } = await import("../src/lib/core/integrity");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
