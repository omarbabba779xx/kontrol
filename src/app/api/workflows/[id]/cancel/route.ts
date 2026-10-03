import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { cancelWorkflow } from "@/lib/core/workflow-engine";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "controls:evaluate");
    const { reason } = z.object({ reason: z.string().min(5).max(1000) }).parse(await request.json());
    return Response.json(await cancelWorkflow(actor, (await params).id, reason));
  } catch (error) { return apiError(error); }
}
