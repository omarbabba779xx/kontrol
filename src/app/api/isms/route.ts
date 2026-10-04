import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import {
  approveReview,
  approveScope,
  CONTEXT_KINDS,
  ismsSnapshot,
  markImplemented,
  measureObjective,
  NC_SEVERITIES,
  NC_SOURCES,
  OBJECTIVE_STATUSES,
  planCorrectiveAction,
  prepareReview,
  raiseNonconformity,
  removeContextItem,
  saveContextItem,
  saveObjective,
  verifyAndClose,
} from "@/lib/core/isms";

export const runtime = "nodejs";

const id = z.string().min(3).max(80);
const text = (max: number) => z.string().max(max);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_context"), id: id.optional(), kind: z.enum(CONTEXT_KINDS), title: z.string().min(3).max(200), detail: text(4000).optional(), requirement: text(2000).optional() }),
  z.object({ action: z.literal("remove_context"), id }),
  z.object({ action: z.literal("approve_scope"), statement: z.string().min(20).max(6000), boundaries: text(4000).optional(), exclusions: text(4000).optional() }),
  z.object({ action: z.literal("save_objective"), id: id.optional(), title: z.string().min(3).max(200), measure: z.string().min(3).max(500), target: z.string().min(1).max(200), ownerId: id.nullable().optional(), dueAt: z.string().datetime(), status: z.enum(OBJECTIVE_STATUSES).optional() }),
  z.object({ action: z.literal("measure_objective"), id, value: z.string().min(1).max(200), status: z.enum(OBJECTIVE_STATUSES) }),
  z.object({ action: z.literal("prepare_review"), heldAt: z.string().datetime(), attendees: z.string().min(3).max(1000) }),
  z.object({ action: z.literal("approve_review"), id, decisions: z.string().min(20).max(8000), actions: z.array(z.object({ title: z.string().min(3).max(200), assigneeId: id.optional(), dueAt: z.string().datetime().optional() })).max(30).optional() }),
  z.object({ action: z.literal("raise_nonconformity"), source: z.enum(NC_SOURCES), severity: z.enum(NC_SEVERITIES), title: z.string().min(3).max(200), description: text(4000).optional(), requirement: text(200).optional(), ucCode: z.string().regex(/^UC-[A-Z]+-\d{2}$/).optional(), ownerId: id.optional(), dueAt: z.string().datetime().optional(), correction: text(2000).optional() }),
  z.object({ action: z.literal("plan_corrective_action"), id, rootCause: z.string().min(10).max(4000), correctiveAction: z.string().min(10).max(4000), ownerId: id, dueAt: z.string().datetime(), correction: text(2000).optional() }),
  z.object({ action: z.literal("mark_implemented"), id, note: z.string().min(10).max(2000) }),
  z.object({ action: z.literal("verify_and_close"), id, effective: z.boolean(), note: z.string().min(10).max(2000) }),
]);

/** GET: the management system on one page: the clause checklist and the records behind it. */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    return Response.json(await ismsSnapshot(actor.tenantId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = actionSchema.parse(await request.json());
    const actor = await requireActor(request, "audit:manage");
    switch (input.action) {
      case "save_context":
        return Response.json(await saveContextItem(actor, input), { status: input.id ? 200 : 201 });
      case "remove_context":
        return Response.json(await removeContextItem(actor, input));
      case "approve_scope":
        return Response.json(await approveScope(actor, input));
      case "save_objective":
        return Response.json(await saveObjective(actor, input), { status: input.id ? 200 : 201 });
      case "measure_objective":
        return Response.json(await measureObjective(actor, input));
      case "prepare_review":
        return Response.json(await prepareReview(actor, input), { status: 201 });
      case "approve_review":
        return Response.json(await approveReview(actor, input));
      case "raise_nonconformity":
        return Response.json(await raiseNonconformity(actor, input), { status: 201 });
      case "plan_corrective_action":
        return Response.json(await planCorrectiveAction(actor, input));
      case "mark_implemented":
        return Response.json(await markImplemented(actor, input));
      case "verify_and_close":
        return Response.json(await verifyAndClose(actor, input));
    }
  } catch (error) {
    return apiError(error);
  }
}
