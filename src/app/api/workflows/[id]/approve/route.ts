import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { approveWorkflow } from "@/lib/core/workflow-engine";

const approvalSchema = z.object({ approved: z.boolean(), comment: z.string().min(5).max(2000) });
export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "decisions:approve");
    const { id } = await params;
    const input = approvalSchema.parse(await request.json());
    return Response.json(approveWorkflow(actor, id, input.approved, input.comment));
  } catch (error) {
    return apiError(error);
  }
}
