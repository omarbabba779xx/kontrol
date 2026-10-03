import { createHash, randomBytes } from "node:crypto";
import { assertResolvesPublic, safeFetch } from "@/lib/core/net-guard";
import { clientKey, consumeSharedRateLimit, tooManyRequests } from "@/lib/core/rate-limit";

export const runtime = "nodejs";

const base64url = (value: Buffer) => value.toString("base64url");

export async function GET(request: Request) {
  const limit = await consumeSharedRateLimit(`oidc:${clientKey(request)}`, 20);
  if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);
  const issuer = process.env.OIDC_ISSUER?.replace(/\/$/, "");
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!issuer || !clientId) return Response.json({ error: "OIDC is not configured" }, { status: 503 });
  try { await assertResolvesPublic(issuer); } catch { return Response.json({ error: "OIDC issuer is not allowed" }, { status: 502 }); }
  const discovery = await safeFetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!discovery?.ok) return Response.json({ error: "OIDC discovery failed" }, { status: 502 });
  const metadata = await discovery.json() as { authorization_endpoint: string };
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const origin = new URL(request.url).origin;
  const redirectUri = process.env.OIDC_REDIRECT_URI ?? `${origin}/api/session/oidc/callback`;
  const target = new URL(metadata.authorization_endpoint);
  target.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256" }).toString();
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Set-Cookie": `kontrol_oidc=${state}.${nonce}.${verifier}; HttpOnly; Secure; SameSite=Lax; Path=/api/session/oidc; Max-Age=600` } });
}
