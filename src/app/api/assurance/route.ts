import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { assessVendors, createAuditorRequest, getAssuranceSnapshot, respondToAuditor, runAssuranceScan, simulateDigitalTwin } from "@/lib/core/assurance-engine";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("scan") }),
  z.object({ action: z.literal("assess_vendors") }),
  z.object({ action: z.literal("simulate_twin"), name: z.string().min(3), changeType: z.enum(["new_vendor", "ai_release", "regulatory_change", "control_removed", "cloud_incident", "country_expansion"]), magnitude: z.number().min(.25).max(3), subjectId: z.string().optional() }),
  z.object({ action: z.literal("auditor_request"), requesterName: z.string().min(2), requesterEmail: z.string().email(), subject: z.string().min(3), question: z.string().min(10), scope: z.array(z.string()).max(50), dueAt: z.string().datetime().optional() }),
  z.object({ action: z.literal("auditor_respond"), requestId: z.string().min(3), response: z.string().min(10), status: z.enum(["answered", "rejected"]) }),
]);

export const runtime = "nodejs";

export async function GET(request: Request) {
  try { const actor = await requireActor(request, "evidence:read"); return Response.json(await getAssuranceSnapshot(actor.tenantId)); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const input = actionSchema.parse(await request.json());
    const actor = await requireActor(request, input.action === "simulate_twin" ? "risks:simulate" : input.action === "auditor_request" ? "controls:evaluate" : "controls:evaluate");
    if (input.action === "scan") return Response.json(await runAssuranceScan(actor));
    if (input.action === "assess_vendors") return Response.json({ assessments: await assessVendors(actor) });
    if (input.action === "simulate_twin") return Response.json(await simulateDigitalTwin(actor, input));
    if (input.action === "auditor_respond") return Response.json(await respondToAuditor(actor, input));
    return Response.json(await createAuditorRequest(actor, input), { status: 201 });
  } catch (error) { return apiError(error); }
}
