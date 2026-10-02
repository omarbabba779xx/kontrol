import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { questionnaireDetail } from "@/lib/core/third-party";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "graph:read");
    return Response.json(await questionnaireDetail(actor, (await context.params).id));
  } catch (error) { return apiError(error); }
}
