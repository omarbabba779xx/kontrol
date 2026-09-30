import { createHash, randomBytes } from "node:crypto";

export const runtime = "nodejs";

function base64url(value: Buffer) { return value.toString("base64url"); }

export async function GET(request: Request) {
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) return Response.json({ error: "OIDC is not configured" }, { status: 503 });
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, { cache: "no-store" });
  if (!discovery.ok) return Response.json({ error: "OIDC discovery failed" }, { status: 502 });
  const metadata = await discovery.json() as { authorization_endpoint: string };
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const origin = new URL(request.url).origin;
  const redirectUri = process.env.OIDC_REDIRECT_URI ?? `${origin}/api/session/oidc/callback`;
  const target = new URL(metadata.authorization_endpoint);
  target.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "openid email profile", state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Set-Cookie": `kontrol_oidc=${state}.${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/api/session/oidc; Max-Age=600` } });
}
