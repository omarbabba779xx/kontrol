import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { createArrangement, createProvider, registerSnapshot, reviewQuestionnaire, revokeQuestionnaire, SERVICE_TYPES, sendQuestionnaire, terminateArrangement, updateArrangement, updateProvider } from "@/lib/core/third-party";
import { QUESTIONS, SECTIONS } from "@/lib/core/vendor-questionnaire";

export const runtime = "nodejs";

const country = z.string().regex(/^[A-Z]{2}$/);
const sub = z.object({ name: z.string().min(1).max(200), country: country.optional(), service: z.string().max(200).optional(), rank: z.number().int().min(1).max(10).optional() });
const arrangementFields = {
  serviceType: z.enum(SERVICE_TYPES), description: z.string().max(2000).optional(), functionSupported: z.string().min(2).max(300), criticality: z.enum(["critical_or_important", "not_critical"]),
  startDate: z.string().datetime(), endDate: z.string().datetime().nullable().optional(), noticePeriodDays: z.number().int().min(0).max(3650).nullable().optional(),
  governingLaw: country.nullable().optional(), serviceCountry: country.nullable().optional(), dataCountry: country.nullable().optional(),
  dataSensitivity: z.enum(["none", "personal", "special_or_confidential"]), subcontractors: z.array(sub).max(20), substitutability: z.enum(["easy", "difficult", "impossible", "not_assessed"]),
  exitPlan: z.boolean(), exitTestedAt: z.string().datetime().nullable().optional(), auditRights: z.boolean(), incidentNotificationHours: z.number().int().min(1).max(720).nullable().optional(),
};
const lei = z.string().regex(/^[A-Z0-9]{18}[0-9]{2}$/);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_provider"), name: z.string().min(2).max(200), lei: lei.optional(), country, parentName: z.string().max(200).optional(), parentLei: lei.optional(), providerType: z.enum(["third_party", "intra_group"]) }),
  z.object({ action: z.literal("update_provider"), id: z.string().min(3), lei: lei.nullable().optional(), country: country.optional(), parentName: z.string().max(200).nullable().optional(), parentLei: lei.nullable().optional(), status: z.enum(["active", "exited"]).optional() }),
  z.object({ action: z.literal("create_arrangement"), providerId: z.string().min(3), ...arrangementFields }),
  z.object({ action: z.literal("update_arrangement"), id: z.string().min(3), changes: z.object(arrangementFields).partial() }),
  z.object({ action: z.literal("terminate_arrangement"), id: z.string().min(3), reason: z.string().min(5).max(1000) }),
  z.object({ action: z.literal("send_questionnaire"), providerId: z.string().min(3), days: z.number().int().min(1).max(60).default(14), respondentEmail: z.string().email().optional() }),
  z.object({ action: z.literal("revoke_questionnaire"), id: z.string().min(3) }),
  z.object({ action: z.literal("review_questionnaire"), id: z.string().min(3), accept: z.boolean(), note: z.string().min(10).max(2000) }),
]);

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    return Response.json({ ...(await registerSnapshot(actor.tenantId)), library: { sections: SECTIONS, questions: QUESTIONS } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const input = actionSchema.parse(await request.json());
    const actor = await requireActor(request, "vendors:manage");
    switch (input.action) {
      case "create_provider": return Response.json(await createProvider(actor, input), { status: 201 });
      case "update_provider": return Response.json(await updateProvider(actor, input));
      case "create_arrangement": return Response.json(await createArrangement(actor, input), { status: 201 });
      case "update_arrangement": return Response.json(await updateArrangement(actor, { id: input.id, changes: input.changes }));
      case "terminate_arrangement": return Response.json(await terminateArrangement(actor, input));
      case "send_questionnaire": return Response.json(await sendQuestionnaire(actor, input), { status: 201 });
      case "revoke_questionnaire": return Response.json(await revokeQuestionnaire(actor, input.id));
      case "review_questionnaire": return Response.json(await reviewQuestionnaire(actor, input));
    }
  } catch (error) { return apiError(error); }
}
