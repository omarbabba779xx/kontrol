import { z } from "zod";
import { requireActor, type Permission } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { ANNEX_III_AREAS, FRIA_RIGHTS, MODEL_CARD_FIELDS, PROHIBITED_PRACTICES } from "@/lib/core/ai-act";
import {
  aiSnapshot,
  approveUseCase,
  classifyUseCase,
  createUseCase,
  retireUseCase,
  reviewFria,
  saveFria,
  saveModelCard,
} from "@/lib/core/ai-governance";

export const runtime = "nodejs";

const role = z.enum(["provider", "deployer", "both"]);
const answers = z.object({
  role: role.default("deployer"),
  prohibited: z.array(z.enum(PROHIBITED_PRACTICES.map((item) => item.id) as [string, ...string[]])).max(10),
  annexIIIArea: z.enum(ANNEX_III_AREAS.map((item) => item.id) as [string, ...string[]]),
  derogationClaimed: z.boolean(),
  profilesPeople: z.boolean(),
  annexIProduct: z.boolean(),
  interactsWithPeople: z.boolean(),
  generatesSyntheticContent: z.boolean(),
  emotionRecognitionOrBiometricCategorisation: z.boolean(),
  gpaiProvider: z.boolean(),
  gpaiSystemic: z.boolean(),
  publicService: z.boolean(),
});
const fria = z.object({
  description: z.string().max(6000),
  affectedGroups: z.string().max(3000),
  rights: z
    .array(z.object({ right: z.enum(FRIA_RIGHTS), impact: z.enum(["none", "low", "medium", "high"]), note: z.string().max(2000) }))
    .max(12),
  mitigations: z.string().max(6000),
  oversight: z.string().max(3000),
  remedy: z.string().max(3000),
});
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().min(3).max(200),
    purpose: z.string().max(2000).optional(),
    role,
    ownerId: z.string().min(3).optional(),
  }),
  z.object({ action: z.literal("classify"), id: z.string().min(3), answers }),
  z.object({ action: z.literal("model_card"), id: z.string().min(3), content: z.record(z.string(), z.string().max(6000)) }),
  z.object({ action: z.literal("fria"), id: z.string().min(3), content: fria, complete: z.boolean() }),
  z.object({ action: z.literal("review_fria"), id: z.string().min(3) }),
  z.object({ action: z.literal("approve"), id: z.string().min(3), note: z.string().min(10).max(2000) }),
  z.object({ action: z.literal("retire"), id: z.string().min(3), note: z.string().min(10).max(2000) }),
]);

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    return Response.json({
      ...(await aiSnapshot(actor.tenantId)),
      library: { prohibited: PROHIBITED_PRACTICES, areas: ANNEX_III_AREAS, modelCardFields: MODEL_CARD_FIELDS, rights: FRIA_RIGHTS },
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = actionSchema.parse(await request.json());
    const permission: Permission = input.action === "approve" || input.action === "review_fria" ? "decisions:approve" : "ai:manage";
    const actor = await requireActor(request, permission);
    switch (input.action) {
      case "create":
        return Response.json(await createUseCase(actor, input), { status: 201 });
      case "classify":
        return Response.json(await classifyUseCase(actor, { id: input.id, answers: input.answers as never }));
      case "model_card":
        return Response.json(await saveModelCard(actor, input), { status: 201 });
      case "fria":
        return Response.json(await saveFria(actor, input));
      case "review_fria":
        return Response.json(await reviewFria(actor, input));
      case "approve":
        return Response.json(await approveUseCase(actor, input));
      case "retire":
        return Response.json(await retireUseCase(actor, input));
    }
  } catch (error) {
    return apiError(error);
  }
}
