import { appendAudit } from "@/lib/core/integrity";
import type { Db } from "@/lib/db/types";

/**
 * Whether to load the demonstration tenant. In production it is opt-in (`KONTROL_SEED=true`), so a fresh deployment never starts with
 * invented people and data; elsewhere it is on unless `KONTROL_SEED=false`.
 */
export function shouldSeed(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV === "production" ? env.KONTROL_SEED === "true" : env.KONTROL_SEED !== "false";
}

/**
 * What the first start puts in an empty database: the demonstration tenant with its sample records, the same organisation and
 * administrator with no record at all (`KONTROL_SEED=empty`, for working a case of your own under demo sign-in), or nothing.
 * The empty seed exists for evaluation; production starts from `KONTROL_BOOTSTRAP_ADMIN_EMAIL` instead.
 */
export function seedMode(env: Record<string, string | undefined> = process.env): "sample" | "empty" | "none" {
  if (env.KONTROL_SEED === "empty") return env.NODE_ENV === "production" ? "none" : "empty";
  return shouldSeed(env) ? "sample" : "none";
}

/**
 * Creates the first organisation and its administrator on an empty database, so that someone can sign in without demo data.
 * Does nothing when any tenant exists, so it can run at every start. The administrator signs in through the identity provider with
 * the email given here; no password or secret is created.
 */
export async function bootstrapTenant(db: Db, env: Record<string, string | undefined> = process.env, defaultTenantId = "tenant_acme") {
  const email = env.KONTROL_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email) return { created: false as const };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("KONTROL_BOOTSTRAP_ADMIN_EMAIL is not a valid email address");
  const system = db.system();
  const existing = await system.get<{ count: number | string }>("SELECT COUNT(*) AS count FROM tenants");
  if (Number(existing?.count ?? 0) > 0) return { created: false as const };
  const tenantId = env.OIDC_DEFAULT_TENANT_ID ?? defaultTenantId;
  const userId = `usr_bootstrap_${Math.abs([...email].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) | 0, 7)).toString(36)}`;
  const now = new Date().toISOString();
  await system.transaction(async (tx) => {
    await tx.run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", tenantId, env.KONTROL_BOOTSTRAP_TENANT_NAME?.trim() || "Organisation", env.KONTROL_BOOTSTRAP_REGION?.trim() || "EU", now);
    await tx.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", userId, tenantId, email, email.split("@")[0], "admin", now);
    await appendAudit({ tenantId, actorId: "system", action: "tenant.bootstrapped", objectType: "tenant", objectId: tenantId, payload: { adminEmail: email } }, tx);
  });
  return { created: true as const, tenantId, userId };
}
