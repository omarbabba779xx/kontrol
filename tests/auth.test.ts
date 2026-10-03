import assert from "node:assert/strict";
import { test } from "node:test";
import { SignJWT } from "jose";
import { admin, setEnv, isolateDatabase } from "./setup";

isolateDatabase();
setEnv({ NODE_ENV: "test", KONTROL_AUTH_SECRET: "a".repeat(40) });

const req = (headers: Record<string, string> = {}, method = "GET") => new Request("http://localhost:3000/api/x", { method, headers });
const sign = (claims: Record<string, unknown>, opts: { key?: string; issuer?: string; exp?: number | string; subject?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject(opts.subject ?? "usr_leila").setIssuer(opts.issuer ?? "kontrol").setAudience("kontrol-api").setExpirationTime(opts.exp ?? "1h").sign(new TextEncoder().encode(opts.key ?? "a".repeat(40)));

test("tokens round-trip and carry role and tenant", async () => {
  const { issueSessionToken, requireActor } = await import("../src/lib/core/auth");
  const token = await issueSessionToken({ ...admin, role: "auditor" });
  const actor = await requireActor(req({ authorization: `Bearer ${token}` }), "oscal:export");
  assert.equal(actor.role, "auditor");
  assert.equal(actor.tenantId, admin.tenantId);
});

test("RBAC denies permissions outside the role", async () => {
  const { issueSessionToken, requireActor } = await import("../src/lib/core/auth");
  const headers = { authorization: `Bearer ${await issueSessionToken({ ...admin, role: "viewer" })}` };
  await assert.rejects(requireActor(req(headers), "decisions:approve"), { status: 403 });
  await assert.rejects(requireActor(req(headers), "evidence:write"), { status: 403 });
  await requireActor(req(headers), "graph:read");
});

test("forged, foreign-issuer, unknown-role and expired tokens are rejected", async () => {
  const { authenticate } = await import("../src/lib/core/auth");
  const claims = { tenantId: "tenant_acme", role: "admin" };
  const bearer = (token: string) => req({ authorization: `Bearer ${token}` });
  assert.equal(await authenticate(bearer(await sign(claims, { key: "b".repeat(40) }))), null);
  assert.equal(await authenticate(bearer(await sign(claims, { issuer: "evil" }))), null);
  assert.equal(await authenticate(bearer(await sign({ ...claims, role: "superuser" }))), null);
  assert.equal(await authenticate(bearer(await sign(claims, { exp: Math.floor(Date.now() / 1000) - 60 }))), null);
  assert.ok(await authenticate(bearer(await sign(claims))));
  assert.equal(await authenticate(bearer(await sign(claims, { subject: "usr_does_not_exist" }))), null, "a valid token for a user that does not exist");
});

test("cookie sessions reject cross-origin mutations", async () => {
  const { issueSessionToken, authenticate } = await import("../src/lib/core/auth");
  const cookie = `kontrol_session=${await issueSessionToken(admin)}`;
  assert.ok(await authenticate(req({ cookie, host: "localhost:3000", origin: "http://localhost:3000" }, "POST")));
  assert.equal(await authenticate(req({ cookie, host: "localhost:3000", origin: "https://evil.example" }, "POST")), null);
  assert.ok(await authenticate(req({ cookie, host: "localhost:3000", origin: "https://evil.example" }, "GET")), "safe methods are unaffected");
});

test("production refuses weak or missing secrets and ignores demo auth", async () => {
  const { authSecret, signingSecret, demoAuthAllowed } = await import("../src/lib/core/config");
  setEnv({ NODE_ENV: "production", KONTROL_AUTH_SECRET: undefined, KONTROL_SIGNING_SECRET: undefined, KONTROL_AUTH_MODE: "demo", KONTROL_ALLOW_DEMO_IN_PRODUCTION: undefined });
  assert.throws(() => authSecret(), /KONTROL_AUTH_SECRET/);
  setEnv({ KONTROL_AUTH_SECRET: "replace-with-at-least-32-random-bytes", KONTROL_SIGNING_SECRET: "x".repeat(40) });
  assert.throws(() => authSecret(), /KONTROL_AUTH_SECRET/);
  setEnv({ KONTROL_AUTH_SECRET: "a".repeat(40), KONTROL_SIGNING_SECRET: "a".repeat(40) });
  assert.throws(() => signingSecret(), /must differ/);
  setEnv({ KONTROL_SIGNING_SECRET: "s".repeat(40) });
  assert.equal(signingSecret(), "s".repeat(40));
  assert.equal(demoAuthAllowed(), false);
  const { authenticate } = await import("../src/lib/core/auth");
  assert.equal(await authenticate(req()), null, "no anonymous access in production");
  setEnv({ NODE_ENV: "test" });
});

test("a demotion applies to sessions already issued, a session can be narrowed but never widened, and sessions can be revoked", async () => {
  const { issueSessionToken, requireActor, effectiveRole } = await import("../src/lib/core/auth");
  const { getDb } = await import("../src/lib/db");
  const { revokeSessions } = await import("../src/lib/core/admin");
  const sys = (await getDb()).system();
  await sys.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", "usr_rev", admin.tenantId, "rev@acme.example", "Rev Oke", "admin", new Date().toISOString());
  const subject = { ...admin, userId: "usr_rev", email: "rev@acme.example", name: "Rev Oke" };
  const token = await issueSessionToken({ ...subject, role: "admin" });
  const call = (permission: Parameters<typeof requireActor>[1]) => requireActor(req({ authorization: `Bearer ${token}` }), permission);
  assert.equal((await call("users:manage")).role, "admin");

  // Demoted in the database: the token still says admin, the account no longer is.
  await sys.run("UPDATE users SET role = 'viewer' WHERE id = ?", "usr_rev");
  await assert.rejects(call("users:manage"), { status: 403 });
  assert.equal((await call("graph:read")).role, "viewer");

  // Narrowing is allowed, widening is not.
  assert.equal(effectiveRole("viewer", "admin"), "viewer");
  assert.equal(effectiveRole("admin", "viewer"), "viewer");
  assert.equal(effectiveRole("control_owner", "auditor"), "auditor", "a token cannot claim permissions the account does not hold");

  // Revocation: sessions issued up to now stop working at once; a new login works.
  await sys.run("UPDATE users SET role = 'admin' WHERE id = ?", "usr_rev");
  assert.equal((await call("users:manage")).role, "admin");
  await revokeSessions(admin, { userId: "usr_rev" });
  await assert.rejects(call("graph:read"), { status: 401 });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const fresh = await issueSessionToken({ ...subject, role: "admin" });
  assert.equal((await requireActor(req({ authorization: `Bearer ${fresh}` }), "users:manage")).role, "admin");
  await assert.rejects(revokeSessions(admin, { userId: "usr_nobody" }), /not found/);
});
