import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { recordDecision } from "@/lib/core/decisions";
import { decisionSchema } from "@/lib/core/schemas";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, "decisions:approve");
    return Response.json(await recordDecision(actor, decisionSchema.parse(await request.json())), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
