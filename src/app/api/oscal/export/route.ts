import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { exportOscalAssessmentResults } from "@/lib/core/oscal";

export const runtime = "nodejs";
export async function GET(request: Request) { try { const actor = await requireActor(request, "oscal:export"); return Response.json(await exportOscalAssessmentResults(actor.tenantId), { headers: { "Content-Disposition": `attachment; filename="kontrol-oscal-${new Date().toISOString().slice(0, 10)}.json"` } }); } catch (error) { return apiError(error); } }
