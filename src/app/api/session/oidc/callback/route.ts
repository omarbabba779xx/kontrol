import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { issueSessionToken, type Role } from "@/lib/core/auth";
import { DEFAULT_TENANT_ID, getDb } from "@/lib/db";

export const runtime = "nodejs";
const allowedRoles = new Set<Role>(["admin", "risk_owner", "control_owner", "auditor", "viewer"]);

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const stored = request.headers.get("cookie")?.match(/(?:^|;\s*)kontrol_oidc=([^;]+)/)?.[1];
    const separator = stored?.indexOf(".") ?? -1;
    const storedState = separator > 0 ? stored?.slice(0, separator) : undefined;
    const verifier = separator > 0 ? stored?.slice(separator + 1) : undefined;
    if (!code || !state || !storedState || !verifier || state !== storedState) return Response.json({ error: "Invalid OIDC state" }, { status: 400 });
    const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
    const clientId = process.env.OIDC_CLIENT_ID;
    if (!issuer || !clientId) return Response.json({ error: "OIDC is not configured" }, { status: 503 });
    const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, { cache: "no-store" });
    if (!discovery.ok) return Response.json({ error: "OIDC discovery failed" }, { status: 502 });
    const metadata = await discovery.json() as { token_endpoint: string; jwks_uri: string };
    const redirectUri = process.env.OIDC_REDIRECT_URI ?? `${url.origin}/api/session/oidc/callback`;
    const tokenResponse = await fetch(metadata.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: process.env.OIDC_CLIENT_SECRET ?? "", code, redirect_uri: redirectUri, code_verifier: verifier }) });
    if (!tokenResponse.ok) return Response.json({ error: "OIDC token exchange failed" }, { status: 401 });
    const tokens = await tokenResponse.json() as { id_token?: string };
    if (!tokens.id_token) return Response.json({ error: "Identity token missing" }, { status: 401 });
    const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(metadata.jwks_uri)), { issuer, audience: clientId });
    const email = String(payload.email ?? "");
    if (!email || payload.email_verified === false) return Response.json({ error: "Verified email required" }, { status: 403 });
    const tenantId = process.env.OIDC_DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID;
    // Role claims are only honoured when the deployer explicitly trusts the identity provider to assign them.
    const requestedRole = String(process.env.OIDC_TRUST_ROLE_CLAIM === "true" ? payload.kontrol_role ?? "viewer" : "viewer") as Role;
    const role: Role = allowedRoles.has(requestedRole) ? requestedRole : "viewer";
    const db = (await getDb()).system();
    let user = await db.get<{ id: string; tenant_id: string; email: string; name: string; role: Role }>("SELECT id,tenant_id,email,name,role FROM users WHERE tenant_id=? AND email=?", tenantId, email);
    if (!user) {
      const id = `usr_oidc_${randomUUID()}`;
      await db.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", id, tenantId, email, String(payload.name ?? email), role, new Date().toISOString());
      user = { id, tenant_id: tenantId, email, name: String(payload.name ?? email), role };
    }
    const token = await issueSessionToken({ userId: user.id, tenantId: user.tenant_id, email: user.email, name: user.name, role: user.role });
    return new Response(null, { status: 302, headers: { Location: `${url.origin}/`, "Set-Cookie": `kontrol_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800` } });
  } catch (error) {
    console.error(error);
    return Response.json({ error: "OIDC authentication failed" }, { status: 401 });
  }
}
