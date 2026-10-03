import "server-only";

import { randomUUID, timingSafeEqual } from "node:crypto";
import { DEFAULT_TENANT_ID, getDb } from "@/lib/db";
import type { Role } from "@/lib/core/auth";

/**
 * Who may sign in through the identity provider, and as whom.
 *
 * A verified email at the IdP is not by itself a reason to let someone into an organisation: a multi-tenant IdP (Google, Entra "common")
 * vouches for anybody's address. So:
 *   - an existing user may sign in when the IdP says the email is verified;
 *   - a new user is created only when the email's domain is on `OIDC_ALLOWED_DOMAINS` (default tenant) or `OIDC_DOMAIN_TENANTS`
 *     (`domain=tenant_id,...`); otherwise sign-in is by invitation only;
 *   - the first sign-in binds the account to the IdP's `iss` and `sub`; a later sign-in with the same email but another subject is refused,
 *     so a reassigned mailbox does not inherit the account.
 */
const ROLES = new Set<Role>(["admin", "risk_owner", "control_owner", "auditor", "viewer"]);

export type Claims = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  nonce?: unknown;
  kontrol_role?: unknown;
  iss?: unknown;
};
export type SignIn =
  | { ok: true; user: { id: string; tenantId: string; email: string; name: string; role: Role }; created: boolean }
  | { ok: false; status: 401 | 403; error: string };

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

/** The organisation a domain signs in to, or null when the domain may not create accounts. */
export function tenantForDomain(domain: string, env: NodeJS.ProcessEnv = process.env) {
  const mapped = new Map(
    list(env.OIDC_DOMAIN_TENANTS)
      .map((pair) => pair.split("=").map((part) => part.trim()) as [string, string])
      .filter(([host, tenant]) => host && tenant),
  );
  const target = mapped.get(domain);
  if (target) return target;
  if (list(env.OIDC_ALLOWED_DOMAINS).includes(domain)) return env.OIDC_DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID;
  return null;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function signInWithClaims(
  claims: Claims,
  context: { issuer: string; expectedNonce: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SignIn> {
  if (typeof claims.nonce !== "string" || !context.expectedNonce || !same(claims.nonce, context.expectedNonce))
    return { ok: false, status: 401, error: "Invalid OIDC nonce" };
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  if (!subject) return { ok: false, status: 401, error: "Identity token has no subject" };
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  // Only an explicit `true` counts: a missing claim is not a verification.
  if (!email || !email.includes("@") || claims.email_verified !== true) return { ok: false, status: 403, error: "Verified email required" };

  const db = (await getDb()).system();
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const home = tenantForDomain(domain, env);
  const candidates = await db.all<{
    id: string;
    tenant_id: string;
    email: string;
    name: string;
    role: Role;
    status: string | null;
    oidc_issuer: string | null;
    oidc_subject: string | null;
  }>("SELECT id,tenant_id,email,name,role,status,oidc_issuer,oidc_subject FROM users WHERE LOWER(email) = ?", email);
  // An existing account is found in the organisation it belongs to; a domain mapped to an organisation prefers that one.
  const defaultTenant = env.OIDC_DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID;
  const existing =
    candidates.find((row) => row.tenant_id === (home ?? defaultTenant)) ?? (candidates.length === 1 ? candidates[0] : undefined);

  if (existing) {
    if (existing.status === "disabled") return { ok: false, status: 403, error: "This account is disabled" };
    if (existing.oidc_subject && (existing.oidc_subject !== subject || existing.oidc_issuer !== context.issuer))
      return { ok: false, status: 403, error: "This account is bound to a different identity" };
    if (!existing.oidc_subject)
      await db.run(
        "UPDATE users SET oidc_issuer = ?, oidc_subject = ? WHERE id = ? AND oidc_subject IS NULL",
        context.issuer,
        subject,
        existing.id,
      );
    await db.run("UPDATE users SET last_login_at = ? WHERE id = ?", new Date().toISOString(), existing.id);
    return {
      ok: true,
      created: false,
      user: { id: existing.id, tenantId: existing.tenant_id, email: existing.email, name: existing.name, role: existing.role },
    };
  }

  if (!home) return { ok: false, status: 403, error: "Sign-in is by invitation: ask an administrator to create your account" };
  // Role claims are only honoured when the deployer explicitly trusts the identity provider to assign them.
  const requested = String(env.OIDC_TRUST_ROLE_CLAIM === "true" ? (claims.kontrol_role ?? "viewer") : "viewer") as Role;
  const role: Role = ROLES.has(requested) ? requested : "viewer";
  if (!(await db.get("SELECT id FROM tenants WHERE id = ?", home)))
    return { ok: false, status: 403, error: "Sign-in is not configured for this organisation" };
  const id = `usr_oidc_${randomUUID()}`;
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim().slice(0, 200) : email;
  const now = new Date().toISOString();
  await db.run(
    "INSERT INTO users (id,tenant_id,email,name,role,created_at,last_login_at,oidc_issuer,oidc_subject) VALUES (?,?,?,?,?,?,?,?,?)",
    id,
    home,
    email,
    name,
    role,
    now,
    now,
    context.issuer,
    subject,
  );
  return { ok: true, created: true, user: { id, tenantId: home, email, name, role } };
}
