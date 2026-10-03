import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const oidc = () => import("../src/lib/core/oidc");
const db = async () => (await import("../src/lib/db")).getDb();
const ISSUER = "https://idp.example.com";
const claims = (extra: Record<string, unknown> = {}) => ({ sub: "sub-1", email: "maya@acme.test", email_verified: true, name: "Maya", nonce: "n-1", ...extra });
const context = { issuer: ISSUER, expectedNonce: "n-1" };
const env = (extra: Record<string, string> = {}) => ({ OIDC_DEFAULT_TENANT_ID: admin.tenantId, ...extra }) as unknown as NodeJS.ProcessEnv;

test("an email the identity provider has not verified is refused, including when the claim is missing", async () => {
  const { signInWithClaims } = await oidc();
  assert.deepEqual(await signInWithClaims(claims({ email_verified: false }), context, env({ OIDC_ALLOWED_DOMAINS: "acme.test" })), { ok: false, status: 403, error: "Verified email required" });
  const missing: Record<string, unknown> = claims();
  delete missing.email_verified;
  assert.equal((await signInWithClaims(missing, context, env({ OIDC_ALLOWED_DOMAINS: "acme.test" }))).ok, false);
  assert.equal((await signInWithClaims(claims({ email_verified: "true" }), context, env({ OIDC_ALLOWED_DOMAINS: "acme.test" }))).ok, false, "a string is not a verification");
});

test("the nonce must match the one sent at login", async () => {
  const { signInWithClaims } = await oidc();
  const settings = env({ OIDC_ALLOWED_DOMAINS: "acme.test" });
  assert.equal((await signInWithClaims(claims({ nonce: "other" }), context, settings)).ok, false);
  assert.equal((await signInWithClaims({ ...claims(), nonce: undefined }, context, settings)).ok, false);
  assert.equal((await signInWithClaims(claims(), { issuer: ISSUER, expectedNonce: "" }, settings)).ok, false);
});

test("sign-in is by invitation unless the domain is allowed; a stranger at a shared identity provider cannot get in", async () => {
  const { signInWithClaims } = await oidc();
  const stranger = claims({ sub: "sub-x", email: "someone@gmail.com" });
  const refused = await signInWithClaims(stranger, context, env());
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /by invitation/);
  const wrongDomain = await signInWithClaims(stranger, context, env({ OIDC_ALLOWED_DOMAINS: "acme.test" }));
  assert.equal(wrongDomain.ok, false);
  const sys = (await db()).system();
  assert.equal((await sys.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM users WHERE email = 'someone@gmail.com'"))?.n.toString(), "0", "no account was created");
});

test("an allowed domain creates a viewer, in the mapped organisation, and the role claim is ignored unless trusted", async () => {
  const { signInWithClaims } = await oidc();
  const created = await signInWithClaims(claims({ kontrol_role: "admin" }), context, env({ OIDC_ALLOWED_DOMAINS: "acme.test" }));
  assert.ok(created.ok && created.created);
  assert.equal(created.ok && created.user.role, "viewer");
  assert.equal(created.ok && created.user.tenantId, admin.tenantId);

  const sys = (await db()).system();
  const mapped = { OIDC_DOMAIN_TENANTS: "partner.test=tenant_partner", OIDC_TRUST_ROLE_CLAIM: "true" };
  const missing = await signInWithClaims(claims({ sub: "sub-2", email: "lea@partner.test" }), context, env(mapped));
  assert.deepEqual(missing, { ok: false, status: 403, error: "Sign-in is not configured for this organisation" }, "a mapping to an organisation that does not exist is a refusal, not a crash");
  await sys.run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", "tenant_partner", "Partner", "EU", new Date().toISOString());
  const other = await signInWithClaims(claims({ sub: "sub-2", email: "lea@partner.test", kontrol_role: "auditor" }), context, env(mapped));
  assert.ok(other.ok && other.user.tenantId === "tenant_partner" && other.user.role === "auditor", "a mapped domain lands in its own organisation, and a trusted role claim is honoured");
});

test("the first sign-in binds the account to the provider's subject; the same email with another subject is refused", async () => {
  const { signInWithClaims } = await oidc();
  const settings = env({ OIDC_ALLOWED_DOMAINS: "acme.test" });
  const again = await signInWithClaims(claims(), context, settings);
  assert.ok(again.ok && !again.created, "the account created earlier is found, not duplicated");
  const hijack = await signInWithClaims(claims({ sub: "someone-else" }), context, settings);
  assert.deepEqual(hijack, { ok: false, status: 403, error: "This account is bound to a different identity" });
  const otherIssuer = await signInWithClaims(claims(), { issuer: "https://other-idp.example.com", expectedNonce: "n-1" }, settings);
  assert.equal(otherIssuer.ok, false, "the same subject at another issuer is not the same person");
});

test("an existing account signs in once, is bound on that first sign-in, and a disabled account is refused; email case does not matter", async () => {
  const { signInWithClaims } = await oidc();
  const sys = (await db()).system();
  const row = await sys.get<{ id: string; email: string }>("SELECT id, email FROM users WHERE tenant_id = ? AND role = 'admin' LIMIT 1", admin.tenantId);
  assert.ok(row);
  const first = await signInWithClaims(claims({ sub: "admin-sub", email: row!.email.toUpperCase() }), context, env());
  assert.ok(first.ok && first.user.id === row!.id, "an invited user needs no allowed domain");
  const bound = await sys.get<{ oidc_subject: string; oidc_issuer: string }>("SELECT oidc_subject, oidc_issuer FROM users WHERE id = ?", row!.id);
  assert.deepEqual(bound, { oidc_subject: "admin-sub", oidc_issuer: ISSUER });
  await sys.run("UPDATE users SET status = 'disabled' WHERE id = ?", row!.id);
  assert.equal((await signInWithClaims(claims({ sub: "admin-sub", email: row!.email }), context, env())).ok, false);
});

test("the callback answers every outcome by clearing the one-time cookie", async () => {
  const { GET } = await import("../src/app/api/session/oidc/callback/route");
  const response = await GET(new Request("http://localhost/api/session/oidc/callback?code=x&state=a", { headers: { cookie: "kontrol_oidc=b.n.v" } }));
  assert.equal(response.status, 400);
  assert.match(response.headers.get("set-cookie") ?? "", /kontrol_oidc=;.*Max-Age=0/);
});
