import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { engagementDetail } from "@/lib/core/audit-workspace";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "audit:read");
    return Response.json(await engagementDetail(actor, (await context.params).id));
  } catch (error) { return apiError(error); }
}
