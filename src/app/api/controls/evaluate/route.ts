import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { evaluateControl } from "@/lib/core/policy-engine";
import { controlEvaluationSchema } from "@/lib/core/schemas";

export const runtime = "nodejs";
/**
 * Facts posted here are asserted by the caller, not collected from the system. The evidence is therefore always recorded as manual,
 * attributed to the user, whatever source the body claims; manual evidence is kept and hashed but never counts as verification.
 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, "controls:evaluate");
    const input = controlEvaluationSchema.parse(await request.json());
    return Response.json(await evaluateControl(actor, { ...input, source: `manual:${actor.userId}`, provenance: { collector: { name: "manual-assertion", version: "1" }, limits: ["facts were asserted by the caller and not collected from the system"] } }));
  } catch (error) { return apiError(error); }
}
