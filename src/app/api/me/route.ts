import { authenticate } from "@/lib/core/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

/** Who the caller is, so the interface can show only what they may use. */
export async function GET(request: Request) {
  const actor = await authenticate(request);
  if (!actor) return Response.json({ error: "Authentication required" }, { status: 401 });
  const organisation = await (await getDb()).scope(actor.tenantId).get<{ name: string }>("SELECT name FROM tenants WHERE id = ?", actor.tenantId);
  return Response.json({ userId: actor.userId, name: actor.name, role: actor.role, external: actor.external === true, organisation: organisation?.name ?? null });
}
