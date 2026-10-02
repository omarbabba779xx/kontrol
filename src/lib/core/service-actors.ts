import "server-only";

import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/db";

/**
 * Non-human actors (the ingest endpoint, the scheduler, the notifier) need a user row because findings and evidence
 * reference users. They are `control_owner`s: they can evaluate controls and write evidence, and nothing more.
 */
export const SERVICE_USERS = {
  ingest: { id: "usr_svc_ingest", name: "Ingest service", email: "ingest@service.invalid" },
  scheduler: { id: "usr_svc_scheduler", name: "Scheduler", email: "scheduler@service.invalid" },
} as const;

export async function serviceActor(tenantId: string, service: keyof typeof SERVICE_USERS): Promise<Actor> {
  const user = SERVICE_USERS[service];
  const db = (await getDb()).system();
  if (!(await db.get("SELECT id FROM users WHERE id = ? AND tenant_id = ?", user.id, tenantId))) {
    await db.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING", user.id, tenantId, user.email, user.name, "control_owner", new Date().toISOString());
  }
  return { userId: user.id, tenantId, email: user.email, name: user.name, role: "control_owner" };
}
