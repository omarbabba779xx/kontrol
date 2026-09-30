import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { getDb } from "@/lib/core/database";

export const runtime = "nodejs";
export async function GET(request: Request) { try { const actor = await requireActor(request, "graph:read"); const db = getDb(); return Response.json({ nodes: { assets: db.prepare("SELECT * FROM assets WHERE tenant_id = ? AND valid_to IS NULL").all(actor.tenantId), obligations: db.prepare("SELECT * FROM obligations WHERE tenant_id = ? AND effective_to IS NULL").all(actor.tenantId), controls: db.prepare("SELECT * FROM controls WHERE tenant_id = ? AND valid_to IS NULL").all(actor.tenantId) }, edges: db.prepare("SELECT * FROM graph_edges WHERE tenant_id = ? AND valid_to IS NULL").all(actor.tenantId) }); } catch (error) { return apiError(error); } }
