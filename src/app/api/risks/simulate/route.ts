import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { scenarioSchema } from "@/lib/core/schemas";
import { persistRiskSimulation, simulateRisk } from "@/lib/core/risk-engine";

export const runtime = "nodejs";
export async function POST(request: Request) { try { const actor = await requireActor(request, "risks:simulate"); const scenario = scenarioSchema.parse(await request.json()); const result = simulateRisk(scenario); const riskId = persistRiskSimulation(actor, scenario, result); return Response.json({ riskId, ...result }); } catch (error) { return apiError(error); } }
