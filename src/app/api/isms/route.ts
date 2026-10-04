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
import { closeIncident, concludeInternalAudit, INCIDENT_SEVERITIES, operationsSnapshot, planInternalAudit, raiseAuditFinding, RECORD_KINDS, reportIncident, saveRecord, updateIncident } from "@/lib/core/isms-operations";

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
  z.object({ action: z.literal("save_record"), id: id.optional(), kind: z.enum(RECORD_KINDS), title: z.string().min(3).max(200), status: z.string().max(20).optional(), ownerId: id.nullable().optional(), dueAt: z.string().datetime().nullable().optional(), detail: z.record(z.string().max(40), z.string().max(2000)) }),
  z.object({ action: z.literal("report_incident"), title: z.string().min(3).max(200), description: text(4000).optional(), severity: z.enum(INCIDENT_SEVERITIES), detectedAt: z.string().datetime(), assetId: id.optional(), personalData: z.boolean().optional(), ownerId: id.optional() }),
  z.object({ action: z.literal("update_incident"), id, status: z.enum(["reported", "contained", "resolved"]).optional(), rootCause: text(4000).optional(), lessons: text(4000).optional(), ownerId: id.nullable().optional(), notified: z.object({ at: z.string().datetime(), note: z.string().min(5).max(1000) }).optional() }),
  z.object({ action: z.literal("close_incident"), id, rootCause: z.string().min(10).max(4000), lessons: z.string().min(10).max(4000), nonconformity: z.object({ severity: z.enum(NC_SEVERITIES), title: z.string().min(3).max(200), ownerId: id.optional() }).optional(), noNonconformityReason: text(1000).optional() }),
  z.object({ action: z.literal("plan_internal_audit"), name: z.string().min(3).max(200), objectives: z.string().min(10).max(2000), criteria: z.string().min(5).max(2000), scope: text(2000).optional(), auditorId: id, periodStart: z.string().datetime(), periodEnd: z.string().datetime(), ucCodes: z.array(z.string().regex(/^UC-[A-Z]+-\d{2}$/)).max(60).optional() }),
  z.object({ action: z.literal("raise_audit_finding"), auditId: id, severity: z.enum(NC_SEVERITIES), title: z.string().min(3).max(200), description: text(4000).optional(), requirement: text(200).optional(), ucCode: z.string().regex(/^UC-[A-Z]+-\d{2}$/).optional() }),
  z.object({ action: z.literal("conclude_internal_audit"), auditId: id, conclusion: z.string().min(20).max(6000) }),
]);

/** GET: the management system on one page: the clause checklist and the records behind it. */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    const [system, operations] = await Promise.all([ismsSnapshot(actor.tenantId), operationsSnapshot(actor.tenantId)]);
    // Internal audits planned through the programme carry their plan and conclusion; the others are plain engagements.
    return Response.json({ ...system, ...operations, internalAudits: [...operations.internalAudits, ...system.internalAudits.filter((audit) => !operations.internalAudits.some((planned) => planned.id === audit.id))] });
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
      case "save_record":
        return Response.json(await saveRecord(actor, input), { status: input.id ? 200 : 201 });
      case "report_incident":
        return Response.json(await reportIncident(actor, input), { status: 201 });
      case "update_incident":
        return Response.json(await updateIncident(actor, input));
      case "close_incident":
        return Response.json(await closeIncident(actor, input));
      case "plan_internal_audit":
        return Response.json(await planInternalAudit(actor, input), { status: 201 });
      case "raise_audit_finding":
        return Response.json(await raiseAuditFinding(actor, input), { status: 201 });
      case "conclude_internal_audit":
        return Response.json(await concludeInternalAudit(actor, input));
    }
  } catch (error) {
    return apiError(error);
  }
}
