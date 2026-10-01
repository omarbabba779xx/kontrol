import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { evaluateControl } from "@/lib/core/policy-engine";
import { controlEvaluationSchema } from "@/lib/core/schemas";

export const runtime = "nodejs";
export async function POST(request: Request) { try { const actor = await requireActor(request, "controls:evaluate"); const input = controlEvaluationSchema.parse(await request.json()); return Response.json(await evaluateControl(actor, input)); } catch (error) { return apiError(error); } }
