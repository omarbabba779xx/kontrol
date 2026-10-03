import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();

const mod = () => import("../src/lib/core/admin");
const credentials = () => import("../src/lib/core/credentials");
const withKey = (token: string, url = "http://localhost/api/admin", init: RequestInit = {}) => new Request(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
const db = async () => (await import("../src/lib/db")).getDb();

test("users are created per tenant with unique emails, and roles are validated", async () => {
  const { inviteUser, adminSnapshot } = await mod();
  const created = await inviteUser(admin, { email: "  Priya.Nair@Acme.Example ", name: "Priya Nair", role: "control_owner" });
  assert.equal(created.email, "priya.nair@acme.example", "emails are normalised");
  await assert.rejects(inviteUser(admin, { email: "priya.nair@acme.example", name: "Again", role: "viewer" }), (error: Error & { status?: number }) => error.status === 409);
  const users = (await adminSnapshot(admin.tenantId)).users;
  assert.ok(users.some((user) => user.id === created.id && user.status === "active" && user.role === "control_owner"));
});

test("the last active administrator can be neither demoted nor disabled, and nobody can disable themselves", async () => {
  const { inviteUser, setUserRole, setUserStatus } = await mod();
  await assert.rejects(setUserRole(admin, { userId: admin.userId, role: "viewer" }), /last active administrator/);
  await assert.rejects(setUserStatus(admin, { userId: admin.userId, status: "disabled" }), /cannot disable your own account/);

  const second = await inviteUser(admin, { email: "second.admin@acme.example", name: "Second Admin", role: "admin" });
  await setUserRole(admin, { userId: second.id, role: "risk_owner" });
  await setUserRole(admin, { userId: second.id, role: "admin" });
  await assert.doesNotReject(setUserRole(admin, { userId: admin.userId, role: "risk_owner" }), "another administrator exists, so demotion is fine");
  await assert.rejects(setUserStatus({ ...admin, userId: second.id, role: "admin" }, { userId: second.id, status: "disabled" }), /own account/);
  await setUserRole({ ...admin, userId: second.id, role: "admin" }, { userId: admin.userId, role: "admin" });
  await assert.rejects(setUserRole(admin, { userId: "usr_missing", role: "viewer" }), (error: Error & { status?: number }) => error.status === 404);
});

test("API keys are shown once, stored only as a hash, scoped to a role below administrator, and honoured by authentication", async () => {
  const { createApiKey } = await mod();
  const { authenticate } = await import("../src/lib/core/auth");
  await assert.rejects(createApiKey(admin, { name: "Escalation attempt", role: "admin", expiresInDays: 30 }), /cannot be administrators/);

  const key = await createApiKey(admin, { name: "CI pipeline", role: "auditor", expiresInDays: 30 });
  assert.match(key.token, /^kon_[A-Za-z0-9_-]{43}$/);
  const rows = await (await db()).scope(admin.tenantId).all<Record<string, unknown>>("SELECT * FROM api_keys WHERE tenant_id = ?", admin.tenantId);
  assert.ok(!JSON.stringify(rows).includes(key.token), "the plaintext key is not stored anywhere in the row");
  assert.equal(rows[0].key_hash?.toString().length, 64);

  const actor = await authenticate(withKey(key.token));
  assert.equal(actor?.role, "auditor", "the key's role, not its owner's");
  assert.equal(actor?.userId, admin.userId);
  assert.equal(actor?.apiKeyId, key.id);
  assert.equal(await authenticate(withKey(key.token + "x")), null, "a wrong key");
  assert.equal(await authenticate(new Request("http://localhost/api/admin", { headers: { cookie: `kontrol_session=${key.token}` } })), null, "keys are accepted only as bearer credentials");
  const used = await (await db()).scope(admin.tenantId).get<{ last_used_at: string | null }>("SELECT last_used_at FROM api_keys WHERE id = ?", key.id);
  assert.ok(used?.last_used_at, "last use is recorded");
});

test("a key can reach only what its role allows, and the admin API needs the administrator permission", async () => {
  const { createApiKey } = await mod();
  const { GET, POST } = await import("../src/app/api/admin/route");
  const { GET: complianceGet, POST: compliancePost } = await import("../src/app/api/compliance/route");
  const viewer = await createApiKey(admin, { name: "Dashboard", role: "viewer", expiresInDays: 10 });

  assert.equal((await GET(withKey(viewer.token))).status, 403, "a viewer key cannot read the admin snapshot");
  assert.equal((await POST(withKey(viewer.token, "http://localhost/api/admin", { method: "POST", body: JSON.stringify({ action: "invite_user", email: "x@y.example", name: "Xavier", role: "admin" }) }))).status, 403);
  assert.equal((await complianceGet(withKey(viewer.token))).status, 200, "but it can read the compliance posture");
  assert.equal((await compliancePost(withKey(viewer.token, "http://localhost/api/compliance", { method: "POST", body: JSON.stringify({ action: "snapshot" }) }))).status, 403, "and cannot change anything");
  assert.equal((await GET(new Request("http://localhost/api/admin", { headers: { authorization: "Bearer kon_nope" } }))).status, 401);
});

test("revoked, expired and orphaned keys stop working at once", async () => {
  const { createApiKey, revokeApiKey, inviteUser, setUserStatus, setUserRole } = await mod();
  const { authenticate } = await import("../src/lib/core/auth");

  const revoked = await createApiKey(admin, { name: "To revoke", role: "viewer", expiresInDays: 5 });
  assert.ok(await authenticate(withKey(revoked.token)));
  await revokeApiKey(admin, revoked.id);
  assert.equal(await authenticate(withKey(revoked.token)), null);
  await assert.rejects(revokeApiKey(admin, revoked.id), (error: Error & { status?: number }) => error.status === 409);
  await assert.rejects(revokeApiKey(admin, "key_missing"), (error: Error & { status?: number }) => error.status === 404);

  const expiring = await createApiKey(admin, { name: "Expiring", role: "viewer", expiresInDays: 5 });
  await (await db()).system().run("UPDATE api_keys SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), expiring.id);
  assert.equal(await authenticate(withKey(expiring.token)), null);

  // A key belongs to its owner: it dies with the owner's access and cannot outrank a demoted owner.
  const owner = await inviteUser(admin, { email: "owner@acme.example", name: "Key Owner", role: "control_owner" });
  const ownerActor = { ...admin, userId: owner.id, email: "owner@acme.example", name: "Key Owner", role: "admin" as const };
  const ownerKey = await createApiKey(ownerActor, { name: "Owner key", role: "control_owner", expiresInDays: 5 });
  assert.equal((await authenticate(withKey(ownerKey.token)))?.role, "control_owner");
  await setUserRole(admin, { userId: owner.id, role: "viewer" });
  assert.equal(await authenticate(withKey(ownerKey.token)), null, "demoting the owner revokes elevated keys");
  const second = await createApiKey(ownerActor, { name: "Second", role: "viewer", expiresInDays: 5 });
  await setUserStatus(admin, { userId: owner.id, status: "disabled" });
  assert.equal(await authenticate(withKey(second.token)), null, "disabling the owner revokes every key");
});

test("a disabled user's session stops working immediately", async () => {
  const { inviteUser, setUserStatus } = await mod();
  const { authenticate, issueSessionToken } = await import("../src/lib/core/auth");
  const user = await inviteUser(admin, { email: "temp@acme.example", name: "Temp Worker", role: "viewer" });
  const actor = { userId: user.id, tenantId: admin.tenantId, email: "temp@acme.example", name: "Temp Worker", role: "viewer" as const };
  const token = await issueSessionToken(actor);
  const request = () => new Request("http://localhost/api/compliance", { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await authenticate(request()))?.userId, user.id);
  await setUserStatus(admin, { userId: user.id, status: "disabled" });
  assert.equal(await authenticate(request()), null, "the token is still valid but the account is not");
  await setUserStatus(admin, { userId: user.id, status: "active" });
  assert.equal((await authenticate(request()))?.userId, user.id);
});

test("connector credentials are encrypted, bound to their tenant and kind, and never returned", async () => {
  setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });
  const { saveCredentials, loadCredentials, credentialStatus, deleteCredentials } = await credentials();
  const { adminSnapshot } = await mod();
  const token = "github_pat_" + "A".repeat(30) + "WXYZ";
  assert.deepEqual(await saveCredentials(admin, "github", { token }), { kind: "github", hint: "WXYZ" });

  const row = await (await db()).scope(admin.tenantId).get<Record<string, string>>("SELECT * FROM connector_credentials WHERE tenant_id = ? AND kind = 'github'", admin.tenantId);
  assert.ok(!JSON.stringify(row).includes(token), "no plaintext in the table");
  assert.deepEqual(await loadCredentials(admin.tenantId, "github"), { token });
  assert.equal(await loadCredentials(admin.tenantId, "okta"), null);
  assert.ok(!JSON.stringify(await adminSnapshot(admin.tenantId)).includes(token), "the admin snapshot never carries a secret");
  assert.deepEqual((await credentialStatus(admin.tenantId)).find((item) => item.kind === "github")?.hint, "WXYZ");

  // A ciphertext moved to another kind or tenant must not decrypt.
  await (await db()).system().run("UPDATE connector_credentials SET kind = 'gitlab' WHERE tenant_id = ? AND kind = 'github'", admin.tenantId);
  await assert.rejects(loadCredentials(admin.tenantId, "gitlab"), /cannot be decrypted/);
  await (await db()).system().run("UPDATE connector_credentials SET kind = 'github' WHERE tenant_id = ? AND kind = 'gitlab'", admin.tenantId);

  setEnv({ KONTROL_SECRETS_KEY: "z".repeat(40) });
  await assert.rejects(loadCredentials(admin.tenantId, "github"), /KONTROL_SECRETS_KEY changed/);
  setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

  await deleteCredentials(admin, "github");
  assert.equal(await loadCredentials(admin.tenantId, "github"), null);
  await assert.rejects(deleteCredentials(admin, "github"), /nothing to delete/);
});

test("credential values are validated per connector, and base URLs must be public https", async () => {
  setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });
  const { saveCredentials } = await credentials();
  await assert.rejects(saveCredentials(admin, "github", { token: "short" }));
  await assert.rejects(saveCredentials(admin, "okta", { baseUrl: "http://acme.okta.com", token: "x".repeat(20) }), /https/);
  await assert.rejects(saveCredentials(admin, "okta", { baseUrl: "https://localhost", token: "x".repeat(20) }));
  await assert.rejects(saveCredentials(admin, "aws", { accessKeyId: "AKIAEXAMPLEEXAMPLE", secretAccessKey: "s".repeat(30), region: "mars" }));
  await assert.rejects(saveCredentials(admin, "google_workspace", { serviceAccountJson: "not json at all, long enough to pass the length check ....", adminEmail: "a@b.example" }), /service-account/);
  await assert.doesNotReject(saveCredentials(admin, "okta", { baseUrl: "https://acme.okta.com", token: "x".repeat(20) }));
  await assert.doesNotReject(saveCredentials(admin, "entra", { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", clientSecret: "s".repeat(20) }));
});

test("in production the secrets key is mandatory", async () => {
  const { secretsKey } = await import("../src/lib/core/config");
  const previous = process.env.NODE_ENV;
  setEnv({ NODE_ENV: "production", KONTROL_SECRETS_KEY: undefined });
  try { assert.throws(() => secretsKey(), /KONTROL_SECRETS_KEY must be set/); } finally { setEnv({ NODE_ENV: previous }); }
});

test("administration is chained in the audit log without leaking secrets", async () => {
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  assert.equal((await verifyAuditChain(admin.tenantId)).valid, true);
  const rows = await (await db()).scope(admin.tenantId).all<{ action: string; payload_json: string }>("SELECT action, payload_json FROM audit_log WHERE tenant_id = ? AND (action LIKE 'admin.%' OR action LIKE 'credentials.%')", admin.tenantId);
  const actions = new Set(rows.map((row) => row.action));
  for (const expected of ["admin.user_created", "admin.role_changed", "admin.api_key_created", "admin.api_key_revoked", "admin.user_disabled", "credentials.saved", "credentials.deleted"]) assert.ok(actions.has(expected), `missing ${expected}`);
  assert.ok(!rows.some((row) => row.payload_json.includes("kon_") || row.payload_json.includes("github_pat_")), "no key or token in the audit payloads");
});
