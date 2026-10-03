import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";

/** Active people in the tenant, for pickers (assignees, reviewers). Names and roles only: no emails. */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    const users = await (
      await getDb()
    )
      .scope(actor.tenantId)
      .all<{ id: string; name: string; role: string; external: number }>(
        "SELECT id, name, role, external FROM users WHERE tenant_id = ? AND status = 'active' AND id NOT LIKE 'usr_svc_%' ORDER BY name",
        actor.tenantId,
      );
    return Response.json({ users: users.map((user) => ({ ...user, external: user.external === 1 })), me: actor.userId });
  } catch (error) {
    return apiError(error);
  }
}
