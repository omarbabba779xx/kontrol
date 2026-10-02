import { importPKCS8, SignJWT } from "jose";

/**
 * Token exchanges for the connectors that use OAuth. They take `fetch` as a parameter so tests can verify the exact
 * request that would be sent. Errors never include the secret material that was submitted.
 */
type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/admin.directory.user.readonly"];
export const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

/** Service account with domain-wide delegation: a signed JWT impersonating `adminEmail` is exchanged for an access token. */
export async function googleAccessToken(credentials: { serviceAccountJson: string; adminEmail: string }, fetchImpl: FetchLike = fetch as unknown as FetchLike, now = Math.floor(Date.now() / 1000)) {
  const account = JSON.parse(credentials.serviceAccountJson) as { client_email: string; private_key: string };
  const key = await importPKCS8(account.private_key, "RS256");
  const assertion = await new SignJWT({ scope: GOOGLE_SCOPES.join(" ") })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.client_email)
    .setSubject(credentials.adminEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const response = await fetchImpl(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(), signal: AbortSignal.timeout(15_000) });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(`Google token exchange failed (${response.status}${body.error ? `: ${body.error}` : ""}). Check domain-wide delegation, the scope ${GOOGLE_SCOPES[0]}, and the delegated administrator.`);
  return body.access_token;
}

/** Client-credentials flow for an Entra ID app registration with application permissions. */
export async function entraAccessToken(credentials: { tenantId: string; clientId: string; clientSecret: string }, fetchImpl: FetchLike = fetch as unknown as FetchLike) {
  const response = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: credentials.clientId, client_secret: credentials.clientSecret, scope: GRAPH_SCOPE }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !body.access_token) throw new Error(`Entra token request failed (${response.status}${body.error ? `: ${body.error}` : ""}). Check the tenant id, client id, secret and admin consent.`);
  return body.access_token;
}
