import "server-only";

import { jwtVerify, SignJWT } from "jose";
import { authSecret, demoAuthAllowed } from "@/lib/core/config";
import { DEFAULT_TENANT_ID, DEFAULT_USER_ID, getDb } from "@/lib/core/database";

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
  | "agents:run";

const permissions: Record<Role, Permission[]> = {
  admin: ["graph:read", "evidence:read", "evidence:write", "controls:evaluate", "risks:simulate", "decisions:approve", "connectors:sync", "regulations:ingest", "oscal:export", "agents:run"],
  risk_owner: ["graph:read", "evidence:read", "risks:simulate", "decisions:approve", "oscal:export", "agents:run"],
  control_owner: ["graph:read", "evidence:read", "evidence:write", "controls:evaluate", "connectors:sync", "oscal:export", "agents:run"],
  auditor: ["graph:read", "evidence:read", "oscal:export", "agents:run"],
  viewer: ["graph:read", "evidence:read"],
};

export type Actor = {
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

function demoActor(): Actor {
  const row = getDb().prepare("SELECT id, tenant_id, email, name, role FROM users WHERE id = ?").get(DEFAULT_USER_ID) as { id: string; tenant_id: string; email: string; name: string; role: Role };
  return { userId: row.id, tenantId: row.tenant_id, email: row.email, name: row.name, role: row.role };
}

export async function authenticate(request: Request): Promise<Actor | null> {
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)kontrol_session=([^;]+)/)?.[1];
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : cookie;

  if (token) {
    if (!authorization && MUTATING.has(request.method) && !isSameOrigin(request)) return null;
    try {
      const { payload } = await jwtVerify(token, sessionKey(), { issuer: "kontrol", audience: "kontrol-api", algorithms: ["HS256"] });
      if (!payload.sub || !payload.tenantId || !roles.includes(payload.role as Role)) return null;
      return { userId: payload.sub, tenantId: String(payload.tenantId), email: String(payload.email ?? ""), name: String(payload.name ?? ""), role: payload.role as Role };
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
