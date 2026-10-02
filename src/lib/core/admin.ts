import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { demoAuthAllowed } from "@/lib/core/config";
import type { Actor, Role } from "@/lib/core/auth";
import { credentialStatus } from "@/lib/core/credentials";
import { userError } from "@/lib/core/errors";
import { appendAudit, sha256 } from "@/lib/core/integrity";
import { getDb } from "@/lib/db";

export const ROLES: Role[] = ["admin", "risk_owner", "control_owner", "auditor", "viewer"];
/** API keys can never be administrators: a leaked key must not be able to manage users or credentials. */
export const KEY_ROLES: Role[] = ["risk_owner", "control_owner", "auditor", "viewer"];
export const KEY_PREFIX = "kon_";

type UserRow = { id: string; email: string; name: string; role: Role; status: "active" | "disabled"; created_at: string; last_login_at: string | null; external: number };

async function activeAdminCount(tenantId: string, excluding?: string) {
  const row = await (await getDb()).scope(tenantId).get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'admin' AND status = 'active' AND id <> ?", tenantId, excluding ?? "");
  return Number(row?.n ?? 0);
}

export async function adminSnapshot(tenantId: string) {
  const db = (await getDb()).scope(tenantId);
  const users = await db.all<UserRow>("SELECT id, email, name, role, status, created_at, last_login_at, external FROM users WHERE tenant_id = ? AND id NOT LIKE 'usr_svc_%' ORDER BY created_at", tenantId);
  const keys = await db.all<{ id: string; user_id: string; name: string; prefix: string; role: Role; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null }>(
    "SELECT id, user_id, name, prefix, role, created_at, expires_at, last_used_at, revoked_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC", tenantId);
  const now = new Date().toISOString();
  return {
    users,
    apiKeys: keys.map((key) => ({ ...key, active: key.revoked_at === null && (key.expires_at === null || key.expires_at > now) })),
    credentials: await credentialStatus(tenantId),
    authentication: {
      oidc: Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID),
      oidcRoleClaimTrusted: process.env.OIDC_TRUST_ROLE_CLAIM === "true",
      demoSessions: demoAuthAllowed(),
      secretsKeyConfigured: Boolean(process.env.KONTROL_SECRETS_KEY && process.env.KONTROL_SECRETS_KEY.length >= 32),
      ingestConfigured: Boolean(process.env.KONTROL_INGEST_SECRET && process.env.KONTROL_INGEST_SECRET.length >= 32),
    },
  };
}

export async function inviteUser(actor: Actor, input: { email: string; name: string; role: Role; external?: boolean }) {
  if (input.external && input.role !== "auditor") throw userError("An external user must have the auditor role");
  const email = input.email.trim().toLowerCase();
  const db = (await getDb()).scope(actor.tenantId);
  if (await db.get("SELECT id FROM users WHERE tenant_id = ? AND email = ?", actor.tenantId, email)) throw userError(`A user with email ${email} already exists`);
  const id = `usr_${randomUUID()}`;
  await db.transaction(async (tx) => {
    await tx.run("INSERT INTO users (id,tenant_id,email,name,role,created_at,status,external) VALUES (?,?,?,?,?,?,?,?)", id, actor.tenantId, email, input.name.trim(), input.role, new Date().toISOString(), "active", input.external ? 1 : 0);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "admin.user_created", objectType: "user", objectId: id, payload: { email, role: input.role, external: input.external === true } }, tx);
  });
  return { id, email, role: input.role };
}

async function target(actor: Actor, userId: string) {
  const row = await (await getDb()).scope(actor.tenantId).get<UserRow>("SELECT id, email, name, role, status, created_at, last_login_at, external FROM users WHERE tenant_id = ? AND id = ?", actor.tenantId, userId);
  if (!row) throw userError("User not found");
  return row;
}

export async function setUserRole(actor: Actor, input: { userId: string; role: Role }) {
  const user = await target(actor, input.userId);
  if (Number(user.external) === 1 && input.role !== "auditor") throw userError("An external user must keep the auditor role");
  if (user.role === input.role) return { id: user.id, role: user.role };
  if (user.role === "admin" && user.status === "active" && (await activeAdminCount(actor.tenantId, user.id)) === 0) throw userError("The last active administrator cannot be demoted");
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run("UPDATE users SET role = ? WHERE tenant_id = ? AND id = ?", input.role, actor.tenantId, user.id);
    // Keys cannot outrank their owner: keys above the new role are revoked with the change.
    if (input.role === "viewer" || input.role === "auditor") await tx.run("UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL AND role NOT IN ('viewer','auditor')", new Date().toISOString(), actor.tenantId, user.id);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "admin.role_changed", objectType: "user", objectId: user.id, payload: { from: user.role, to: input.role } }, tx);
  });
  return { id: user.id, role: input.role };
}

export async function setUserStatus(actor: Actor, input: { userId: string; status: "active" | "disabled" }) {
  const user = await target(actor, input.userId);
  if (input.status === "disabled") {
    if (user.id === actor.userId) throw userError("You cannot disable your own account");
    if (user.role === "admin" && user.status === "active" && (await activeAdminCount(actor.tenantId, user.id)) === 0) throw userError("The last active administrator cannot be disabled");
  }
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run("UPDATE users SET status = ? WHERE tenant_id = ? AND id = ?", input.status, actor.tenantId, user.id);
    // A disabled user's keys stop working immediately.
    if (input.status === "disabled") await tx.run("UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL", new Date().toISOString(), actor.tenantId, user.id);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: input.status === "disabled" ? "admin.user_disabled" : "admin.user_enabled", objectType: "user", objectId: user.id, payload: { email: user.email } }, tx);
  });
  return { id: user.id, status: input.status };
}

/** The plaintext key is returned once and never stored: only its SHA-256 and a short prefix are kept. */
export async function createApiKey(actor: Actor, input: { name: string; role: Role; expiresInDays: number }) {
  if (!KEY_ROLES.includes(input.role)) throw userError("API keys cannot be administrators");
  const token = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = `key_${randomUUID()}`;
  const now = Date.now();
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run("INSERT INTO api_keys (id,tenant_id,user_id,name,prefix,key_hash,role,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, actor.tenantId, actor.userId, input.name.trim(), token.slice(0, KEY_PREFIX.length + 6), sha256(token), input.role, actor.userId, new Date(now).toISOString(), new Date(now + input.expiresInDays * 86_400_000).toISOString());
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "admin.api_key_created", objectType: "api_key", objectId: id, payload: { name: input.name, role: input.role, expiresInDays: input.expiresInDays } }, tx);
  });
  return { id, token, role: input.role };
}

export async function revokeApiKey(actor: Actor, keyId: string) {
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    const existing = await tx.get<{ revoked_at: string | null }>("SELECT revoked_at FROM api_keys WHERE tenant_id = ? AND id = ?", actor.tenantId, keyId);
    if (!existing) throw userError("API key not found");
    const result = await tx.run("UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL", new Date().toISOString(), actor.tenantId, keyId);
    if (result.changes !== 1) throw userError("API key is already revoked");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "admin.api_key_revoked", objectType: "api_key", objectId: keyId, payload: {} }, tx);
  });
  return { id: keyId };
}
