import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { runNextWorkflowStep } from "@/lib/core/workflow-engine";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { try { const actor = await requireActor(request, "controls:evaluate"); const { id } = await params; return Response.json(await runNextWorkflowStep(actor, id)); } catch (error) { return apiError(error); } }
