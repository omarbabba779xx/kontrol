import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { evidenceRecord } from "@/lib/core/evidence-trail";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "evidence:read");
    return Response.json(await evidenceRecord(actor.tenantId, (await params).id));
  } catch (error) {
    return apiError(error);
  }
}
