import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { buildDecisionBrief } from "@/lib/core/assurance-engine";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const actor = await requireActor(request, "graph:read"); const { id } = await params; return Response.json(buildDecisionBrief(actor.tenantId, id)); }
  catch (error) { return apiError(error); }
}
