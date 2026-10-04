import { z } from "zod";
import { requireActor, type Permission } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import {
  acceptRisk,
  CATEGORIES,
  closeRisk,
  createFromGaps,
  createRisk,
  createTreatmentTask,
  quantifyRisk,
  riskSnapshot,
  riskTraceability,
  setRiskMethod,
  treatmentPlanCsv,
  TREATMENTS,
  updateRisk,
} from "@/lib/core/risk-register";
import { createScenario, riskIdentification, valueAsset } from "@/lib/core/risk-assets";
import { METHODS, THREAT_SOURCES } from "@/lib/core/risk-method";
import { scenarioSchema } from "@/lib/core/schemas";

export const runtime = "nodejs";

const score = z.number().int().min(1).max(5);
const code = z.string().regex(/^UC-[A-Z]+-\d{2}$/);
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: z.string().min(3).max(200),
    description: z.string().max(4000).optional(),
    category: z.enum(CATEGORIES),
    asset: z.string().max(200).optional(),
    ownerId: z.string().min(3).optional(),
    likelihood: score.optional(),
    impact: score,
    controls: z.array(code).max(30).optional(),
    assetId: z.string().min(3).optional(),
    threatSource: z.enum(THREAT_SOURCES).optional(),
    threatEvent: z.string().max(500).optional(),
    vulnerability: z.string().max(1000).optional(),
    predisposingConditions: z.string().max(1000).optional(),
    likelihoodInitiation: score.optional(),
    likelihoodImpact: score.optional(),
  }),
  z.object({
    action: z.literal("update"),
    id: z.string().min(3),
    title: z.string().min(3).max(200).optional(),
    description: z.string().max(4000).optional(),
    category: z.enum(CATEGORIES).optional(),
    asset: z.string().max(200).optional(),
    ownerId: z.string().min(3).nullable().optional(),
    likelihood: score.optional(),
    impact: score.optional(),
    controls: z.array(code).max(30).optional(),
    treatment: z.enum(TREATMENTS).optional(),
    treatmentPlan: z.string().max(4000).optional(),
    targetDate: z.string().datetime().nullable().optional(),
    assetId: z.string().min(3).nullable().optional(),
    threatSource: z.enum(THREAT_SOURCES).optional(),
    threatEvent: z.string().max(500).optional(),
    vulnerability: z.string().max(1000).optional(),
    predisposingConditions: z.string().max(1000).optional(),
    likelihoodInitiation: score.optional(),
    likelihoodImpact: score.optional(),
  }),
  z.object({
    action: z.literal("accept"),
    id: z.string().min(3),
    days: z.number().int().min(1).max(730),
    note: z.string().min(10).max(2000),
  }),
  z.object({ action: z.literal("close"), id: z.string().min(3), note: z.string().min(10).max(2000) }),
  z.object({ action: z.literal("quantify"), id: z.string().min(3), scenario: scenarioSchema }),
  z.object({ action: z.literal("from_gaps"), limit: z.number().int().min(1).max(25).default(10) }),
  z.object({ action: z.literal("treatment_task"), id: z.string().min(3) }),
  z.object({ action: z.literal("value_asset"), assetId: z.string().min(3), confidentiality: score, integrity: score, availability: score, rationale: z.string().max(1000).optional() }),
  z.object({ action: z.literal("scenario"), assetId: z.string().min(3), threatId: z.string().regex(/^TH-[A-Z]+-\d{2}$/), likelihood: score.optional(), likelihoodInitiation: score.optional(), likelihoodImpact: score.optional(), impact: score.optional(), impactReason: z.string().max(500).optional(), ownerId: z.string().min(3).optional() }),
  z.object({
    action: z.literal("set_method"),
    method: z.enum(METHODS),
    thresholds: z.object({ medium: z.number().int(), high: z.number().int(), critical: z.number().int() }),
    appetite: z.enum(["low", "medium", "high"]),
    appetiteLevel: z.number().int().min(1).max(4).optional(),
    maxAcceptanceDays: z.number().int(),
    likelihoodLabels: z.array(z.string()).length(5).optional(),
    impactLabels: z.array(z.string()).length(5).optional(),
    impactCriteria: z.array(z.string()).length(5).optional(),
    impactCriteriaByDimension: z.object({ confidentiality: z.array(z.string()).length(5), integrity: z.array(z.string()).length(5), availability: z.array(z.string()).length(5) }).optional(),
  }),
]);

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    const params = new URL(request.url).searchParams;
    if (params.get("format") === "treatment-plan")
      return new Response(await treatmentPlanCsv(actor.tenantId), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="risk-treatment-plan.csv"' } });
    if (params.get("view") === "identification") return Response.json(await riskIdentification(actor.tenantId));
    if (params.get("view") === "traceability") return Response.json(await riskTraceability(actor.tenantId));
    return Response.json(await riskSnapshot(actor.tenantId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = actionSchema.parse(await request.json());
    const permission: Permission = input.action === "accept" ? "decisions:approve" : "risks:manage";
    const actor = await requireActor(request, permission);
    switch (input.action) {
      case "create":
        return Response.json(await createRisk(actor, input), { status: 201 });
      case "update":
        return Response.json(await updateRisk(actor, input));
      case "accept":
        return Response.json(await acceptRisk(actor, input));
      case "close":
        return Response.json(await closeRisk(actor, input));
      case "quantify":
        return Response.json(await quantifyRisk(actor, input));
      case "from_gaps":
        return Response.json(await createFromGaps(actor, input), { status: 201 });
      case "value_asset":
        return Response.json(await valueAsset(actor, input));
      case "scenario":
        return Response.json(await createScenario(actor, input), { status: 201 });
      case "set_method":
        return Response.json(await setRiskMethod(actor, input));
      case "treatment_task":
        return Response.json(await createTreatmentTask(actor, input), { status: 201 });
    }
  } catch (error) {
    return apiError(error);
  }
}
