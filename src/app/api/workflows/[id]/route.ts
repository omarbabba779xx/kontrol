import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { workflowDetail } from "@/lib/core/workflow-engine";

export const runtime = "nodejs";

/** A workflow with every attempt of every step: the result each produced, its hash, and how it failed. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "graph:read");
    return Response.json(await workflowDetail(actor.tenantId, (await params).id));
  } catch (error) {
    return apiError(error);
  }
}
