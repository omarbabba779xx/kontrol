import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { verifyDecision } from "@/lib/core/decisions";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "evidence:read");
    const { id } = await params;
    return Response.json(await verifyDecision(actor.tenantId, id));
  } catch (error) {
    return apiError(error);
  }
}
