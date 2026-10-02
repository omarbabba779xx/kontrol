import "server-only";

import { jwtVerify, SignJWT } from "jose";
import { authSecret, demoAuthAllowed } from "@/lib/core/config";
import { consumeRateLimit } from "@/lib/core/rate-limit";
import { sha256 } from "@/lib/core/integrity";
import { DEFAULT_TENANT_ID, DEFAULT_USER_ID, getDb } from "@/lib/db";

export type Role = "admin" | "risk_owner" | "control_owner" | "auditor" | "viewer";
export type Permission =
  | "graph:read"
  | "evidence:read"
  | "evidence:write"
  | "controls:evaluate"
  | "risks:simulate"
  | "decisions:approve"
  | "connectors:sync"
  | "regulations:ingest"
  | "oscal:export"
  | "agents:run"
  | "users:manage"
  | "credentials:manage"
  | "audit:read"
  | "audit:comment"
  | "audit:manage"
  | "vendors:manage"
  | "risks:manage";

const permissions: Record<Role, Permission[]> = {
  admin: ["graph:read", "evidence:read", "evidence:write", "controls:evaluate", "risks:simulate", "decisions:approve", "connectors:sync", "regulations:ingest", "oscal:export", "agents:run", "users:manage", "credentials:manage", "audit:read", "audit:comment", "audit:manage", "vendors:manage", "risks:manage"],
  risk_owner: ["graph:read", "evidence:read", "risks:simulate", "decisions:approve", "oscal:export", "agents:run", "audit:read", "audit:comment", "audit:manage", "vendors:manage", "risks:manage"],
  control_owner: ["graph:read", "evidence:read", "evidence:write", "controls:evaluate", "connectors:sync", "oscal:export", "agents:run", "audit:read", "audit:comment", "audit:manage", "vendors:manage", "risks:manage"],
  auditor: ["graph:read", "evidence:read", "oscal:export", "agents:run", "audit:read", "audit:comment"],
  viewer: ["graph:read", "evidence:read", "audit:read"],
};

export type Actor = {
  /** Set when the request was authenticated with an API key rather than a session. */
  apiKeyId?: string;
  /** An external auditor: may use the audit workspace for engagements they were granted, and nothing else. */
  external?: boolean;
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  role: Role;
};

const roles = Object.keys(permissions) as Role[];
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function sessionKey() {
  return new TextEncoder().encode(authSecret());
}

/** Cookie-authenticated mutations must originate from the same site (CSRF defence in depth). */
export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try { return new URL(origin).host === host; } catch { return false; }
}

export async function issueSessionToken(actor: Actor) {
  return new SignJWT({ tenantId: actor.tenantId, role: actor.role, email: actor.email, name: actor.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(actor.userId)
    .setIssuer("kontrol")
    .setAudience("kontrol-api")
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(sessionKey());
}

async function demoActor(): Promise<Actor> {
  const row = (await (await getDb()).system().get<{ id: string; tenant_id: string; email: string; name: string; role: Role }>("SELECT id, tenant_id, email, name, role FROM users WHERE id = ?", DEFAULT_USER_ID))!;
  return { userId: row.id, tenantId: row.tenant_id, email: row.email, name: row.name, role: row.role };
}

const KEY_PREFIX = "kon_";
const KEY_TOUCH_MS = 60_000;

/** API keys act as their owner with the key's role, which is never above the owner's and never administrator. */
async function actorFromApiKey(token: string): Promise<Actor | null> {
  const db = (await getDb()).system();
  const row = await db.get<{ id: string; tenant_id: string; user_id: string; role: Role; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; email: string; name: string; status: string; external: number }>(
    "SELECT k.id, k.tenant_id, k.user_id, k.role, k.expires_at, k.revoked_at, k.last_used_at, u.email, u.name, u.status, u.external FROM api_keys k JOIN users u ON u.id = k.user_id AND u.tenant_id = k.tenant_id WHERE k.key_hash = ?", sha256(token));
  const now = new Date().toISOString();
  if (!row || row.revoked_at || row.status !== "active" || (row.expires_at && row.expires_at <= now) || !roles.includes(row.role)) return null;
  if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - KEY_TOUCH_MS) await db.run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", now, row.id);
  return { apiKeyId: row.id, userId: row.user_id, tenantId: row.tenant_id, email: row.email, name: row.name, role: row.role, external: Number(row.external) === 1 };
}

export async function authenticate(request: Request): Promise<Actor | null> {
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)kontrol_session=([^;]+)/)?.[1];
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : cookie;

  if (token?.startsWith(KEY_PREFIX)) return authorization ? actorFromApiKey(token) : null;
  if (token) {
    if (!authorization && MUTATING.has(request.method) && !isSameOrigin(request)) return null;
    try {
      const { payload } = await jwtVerify(token, sessionKey(), { issuer: "kontrol", audience: "kontrol-api", algorithms: ["HS256"] });
      if (!payload.sub || !payload.tenantId || !roles.includes(payload.role as Role)) return null;
      // A disabled user's session stops working immediately, not when the token expires.
      const account = await (await getDb()).system().get<{ status: string; external: number }>("SELECT status, external FROM users WHERE id = ? AND tenant_id = ?", payload.sub, String(payload.tenantId));
      if (!account || account.status !== "active") return null;
      return { userId: payload.sub, tenantId: String(payload.tenantId), email: String(payload.email ?? ""), name: String(payload.name ?? ""), role: payload.role as Role, external: Number(account.external) === 1 };
    } catch {
      return null;
    }
  }

  if (demoAuthAllowed()) return demoActor();
  return null;
}

export async function requireActor(request: Request, permission: Permission): Promise<Actor> {
  const actor = await authenticate(request);
  if (!actor) throw new AuthError("Authentication required", 401);
  if (!consumeRateLimit(`actor:${actor.tenantId}:${actor.userId}`).allowed) throw new AuthError("Rate limit exceeded", 429);
  if (actor.external && !permission.startsWith("audit:")) throw new AuthError("External auditors can only use the audit workspace", 403);
  if (!permissions[actor.role]?.includes(permission)) throw new AuthError(`Role ${actor.role} cannot perform ${permission}`, 403);
  return actor;
}

export function assertTenant(actor: Actor, tenantId: string) {
  if (actor.tenantId !== tenantId) throw new AuthError("Cross-tenant access denied", 403);
}

export class AuthError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function authErrorResponse(error: unknown) {
  if (error instanceof AuthError) return Response.json({ error: error.message }, { status: error.status });
  console.error(error);
  return Response.json({ error: "Internal server error" }, { status: 500 });
}

export { DEFAULT_TENANT_ID };
