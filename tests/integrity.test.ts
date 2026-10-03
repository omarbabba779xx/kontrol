import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, ownerExec } from "./setup";

isolateDatabase();

test("the audit log is append-only for the application", async () => {
  const { appendAudit } = await import("../src/lib/core/integrity");
  const { getDb } = await import("../src/lib/db");
  await appendAudit({ tenantId: admin.tenantId, actorId: admin.userId, action: "test.immutable", objectType: "test", objectId: "imm_1", payload: {} });
  const scope = (await getDb()).scope(admin.tenantId);
  await assert.rejects(scope.run("UPDATE audit_log SET action = 'x' WHERE object_id = 'imm_1'"), /append-only|permission denied/);
  await assert.rejects(scope.run("DELETE FROM audit_log WHERE object_id = 'imm_1'"), /append-only|permission denied/);
});

test("concurrent appends never fork the chain", async () => {
  const { appendAudit, verifyAuditChain } = await import("../src/lib/core/integrity");
  await Promise.all(Array.from({ length: 12 }, (_, i) => appendAudit({ tenantId: admin.tenantId, actorId: admin.userId, action: "test.race", objectType: "test", objectId: `race_${i}`, payload: { i } })));
  const result = await verifyAuditChain(admin.tenantId);
  assert.equal(result.valid, true);
  assert.ok(result.checked >= 12);
});

test("audit chain verifies and detects tampering", async () => {
  const { appendAudit, verifyAuditChain } = await import("../src/lib/core/integrity");
  const { getDb } = await import("../src/lib/db");
  for (let i = 0; i < 4; i++) await appendAudit({ tenantId: admin.tenantId, actorId: admin.userId, action: "test.event", objectType: "test", objectId: `obj_${i}`, payload: { i } });
  const before = await verifyAuditChain(admin.tenantId);
  assert.equal(before.valid, true);
  assert.ok(before.checked >= 4);

  const victim = (await (await getDb()).system().get<{ id: string }>("SELECT id FROM audit_log WHERE object_id = 'obj_1'"))!;
  await ownerExec("UPDATE audit_log SET payload_json = ? WHERE id = ?", JSON.stringify({ i: 999 }), victim.id);
  const after = await verifyAuditChain(admin.tenantId);
  assert.equal(after.valid, false);
  assert.equal((after as { brokenAt?: unknown }).brokenAt, victim.id);
});

test("audit chain detects a removed entry", async () => {
  const { appendAudit, verifyAuditChain } = await import("../src/lib/core/integrity");
  const tenant = "tenant_acme";
  for (let i = 0; i < 3; i++) await appendAudit({ tenantId: tenant, actorId: admin.userId, action: "test.gap", objectType: "test", objectId: `gap_${i}`, payload: {} });
  await ownerExec("DELETE FROM audit_log WHERE object_id = 'gap_1'");
  assert.equal((await verifyAuditChain(tenant)).valid, false);
});

test("sha256 matches a known vector", async () => {
  const { sha256 } = await import("../src/lib/core/integrity");
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("canonical JSON drops undefined values instead of producing invalid JSON", async () => {
  const { canonicalJson } = await import("../src/lib/core/integrity");
  assert.equal(canonicalJson({ b: 1, a: undefined, c: [undefined, 2] }), '{"b":1,"c":[null,2]}');
  assert.doesNotThrow(() => JSON.parse(canonicalJson({ x: undefined, y: { z: undefined } })));
});
