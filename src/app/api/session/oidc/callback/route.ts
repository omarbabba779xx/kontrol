import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { issueSessionToken } from "@/lib/core/auth";
import { assertResolvesPublic, safeFetch } from "@/lib/core/net-guard";
import { signInWithClaims } from "@/lib/core/oidc";

export const runtime = "nodejs";

// The one-time state cookie is single use: every answer from this route, success or failure, removes it.
const CLEAR = "kontrol_oidc=; HttpOnly; Secure; SameSite=Lax; Path=/api/session/oidc; Max-Age=0";
const fail = (error: string, status: number) => Response.json({ error }, { status, headers: { "Set-Cookie": CLEAR } });

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const [storedState, nonce, verifier] = (request.headers.get("cookie")?.match(/(?:^|;\s*)kontrol_oidc=([^;]+)/)?.[1] ?? "").split(".");
    if (!code || !state || !storedState || !nonce || !verifier || state !== storedState) return fail("Invalid OIDC state", 400);
    const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
    const clientId = process.env.OIDC_CLIENT_ID;
    if (!issuer || !clientId) return fail("OIDC is not configured", 503);
    await assertResolvesPublic(issuer);
    const discovery = await safeFetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) });
    if (!discovery.ok) return fail("OIDC discovery failed", 502);
    const metadata = await discovery.json() as { token_endpoint: string; jwks_uri: string };
    await assertResolvesPublic(metadata.token_endpoint);
    await assertResolvesPublic(metadata.jwks_uri);
    const redirectUri = process.env.OIDC_REDIRECT_URI ?? `${url.origin}/api/session/oidc/callback`;
    const tokenResponse = await safeFetch(metadata.token_endpoint, { method: "POST", signal: AbortSignal.timeout(8000), headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: process.env.OIDC_CLIENT_SECRET ?? "", code, redirect_uri: redirectUri, code_verifier: verifier }) });
    if (!tokenResponse.ok) return fail("OIDC token exchange failed", 401);
    const tokens = await tokenResponse.json() as { id_token?: string };
    if (!tokens.id_token) return fail("Identity token missing", 401);
    const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(metadata.jwks_uri), { [customFetch]: (jwksUrl, options) => safeFetch(jwksUrl, { headers: Object.fromEntries(options.headers.entries()), signal: options.signal }) }), { issuer, audience: clientId });
    const result = await signInWithClaims(payload, { issuer, expectedNonce: nonce });
    if (!result.ok) return fail(result.error, result.status);
    const token = await issueSessionToken({ userId: result.user.id, tenantId: result.user.tenantId, email: result.user.email, name: result.user.name, role: result.user.role });
    const headers = new Headers({ Location: `${url.origin}/` });
    headers.append("Set-Cookie", CLEAR);
    headers.append("Set-Cookie", `kontrol_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800`);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error(error);
    return fail("OIDC authentication failed", 401);
  }
}
