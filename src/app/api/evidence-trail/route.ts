import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { evidenceTrail } from "@/lib/core/evidence-trail";

export const runtime = "nodejs";

/** GET /api/evidence-trail?control=CTL-GH-004: the evidence, current outcome, gaps and failed collections for one control. */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "evidence:read");
    const control = new URL(request.url).searchParams.get("control") ?? "";
    if (!/^CTL-[A-Z0-9-]{2,40}$/.test(control)) return Response.json({ error: "Give a control code such as CTL-GH-004" }, { status: 400 });
    return Response.json(await evidenceTrail(actor.tenantId, { controlCode: control }));
  } catch (error) { return apiError(error); }
}
