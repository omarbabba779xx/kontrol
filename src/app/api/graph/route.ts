import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    const db = (await getDb()).scope(actor.tenantId);
    const assets = await db.all("SELECT * FROM assets WHERE tenant_id = ? AND valid_to IS NULL", actor.tenantId);
    const obligations = await db.all("SELECT * FROM obligations WHERE tenant_id = ? AND effective_to IS NULL", actor.tenantId);
    const controls = await db.all("SELECT * FROM controls WHERE tenant_id = ? AND valid_to IS NULL", actor.tenantId);
    const edges = await db.all("SELECT * FROM graph_edges WHERE tenant_id = ? AND valid_to IS NULL", actor.tenantId);
    return Response.json({ nodes: { assets, obligations, controls }, edges });
  } catch (error) { return apiError(error); }
}
