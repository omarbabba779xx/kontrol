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
  TREATMENTS,
  updateRisk,
} from "@/lib/core/risk-register";
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
    likelihood: score,
    impact: score,
    controls: z.array(code).max(30).optional(),
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
  }),
  z.object({
    action: z.literal("accept"),
    id: z.string().min(3),
    days: z.number().int().min(1).max(365),
    note: z.string().min(10).max(2000),
  }),
  z.object({ action: z.literal("close"), id: z.string().min(3), note: z.string().min(10).max(2000) }),
  z.object({ action: z.literal("quantify"), id: z.string().min(3), scenario: scenarioSchema }),
  z.object({ action: z.literal("from_gaps"), limit: z.number().int().min(1).max(25).default(10) }),
  z.object({ action: z.literal("treatment_task"), id: z.string().min(3) }),
]);

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
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
      case "treatment_task":
        return Response.json(await createTreatmentTask(actor, input), { status: 201 });
    }
  } catch (error) {
    return apiError(error);
  }
}
