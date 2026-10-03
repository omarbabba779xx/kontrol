import { z } from "zod";
import { requireActor, type Permission } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import {
  comment,
  createEngagement,
  createRequest,
  ENGAGEMENT_STATUSES,
  generateRequests,
  grantAccess,
  KINDS,
  listEngagements,
  REQUEST_STATUSES,
  respond,
  revokeAccess,
  setEngagementStatus,
  setRequestStatus,
} from "@/lib/core/audit-workspace";

export const runtime = "nodejs";

const framework = z.enum(["iso27001", "nist_csf", "soc2", "gdpr", "nis2", "dora", "eu_ai_act", "iso42001", "pci_dss", "cis_v8"]);
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_engagement"),
    name: z.string().min(3).max(200),
    frameworkId: framework,
    kind: z.enum(KINDS),
    scope: z.string().max(4000).optional(),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    auditorOrg: z.string().max(200).optional(),
    leadId: z.string().min(3).optional(),
  }),
  z.object({ action: z.literal("set_status"), id: z.string().min(3), status: z.enum(ENGAGEMENT_STATUSES) }),
  z.object({
    action: z.literal("grant_access"),
    engagementId: z.string().min(3),
    userId: z.string().min(3),
    days: z.number().int().min(1).max(180),
  }),
  z.object({ action: z.literal("revoke_access"), engagementId: z.string().min(3), userId: z.string().min(3) }),
  z.object({
    action: z.literal("create_request"),
    engagementId: z.string().min(3),
    title: z.string().min(3).max(300),
    description: z.string().max(5000).optional(),
    ucCode: z
      .string()
      .regex(/^UC-[A-Z]+-\d{2}$/)
      .optional(),
    assigneeId: z.string().min(3).optional(),
    dueAt: z.string().datetime().optional(),
  }),
  z.object({
    action: z.literal("generate_requests"),
    engagementId: z.string().min(3),
    limit: z.number().int().min(1).max(100).default(40),
  }),
  z.object({
    action: z.literal("respond"),
    requestId: z.string().min(3),
    note: z.string().max(5000).optional(),
    evidence: z.object({ type: z.enum(["control_evidence", "machine_evidence", "vault"]), id: z.string().min(3) }).optional(),
  }),
  z.object({ action: z.literal("comment"), requestId: z.string().min(3), body: z.string().min(2).max(5000) }),
  z.object({ action: z.literal("set_request_status"), requestId: z.string().min(3), status: z.enum(REQUEST_STATUSES) }),
]);

const MANAGE = new Set(["create_engagement", "set_status", "grant_access", "revoke_access", "generate_requests", "respond"]);

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "audit:read");
    return Response.json({ engagements: await listEngagements(actor) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = actionSchema.parse(await request.json());
    const permission: Permission = MANAGE.has(input.action) ? "audit:manage" : "audit:comment";
    const actor = await requireActor(request, permission);
    switch (input.action) {
      case "create_engagement":
        return Response.json(await createEngagement(actor, { ...input, frameworkId: input.frameworkId }), { status: 201 });
      case "set_status":
        return Response.json(await setEngagementStatus(actor, input));
      case "grant_access":
        return Response.json(await grantAccess(actor, input), { status: 201 });
      case "revoke_access":
        return Response.json(await revokeAccess(actor, input));
      case "create_request":
        return Response.json(await createRequest(actor, input), { status: 201 });
      case "generate_requests":
        return Response.json(await generateRequests(actor, input), { status: 201 });
      case "respond":
        return Response.json(await respond(actor, input));
      case "comment":
        return Response.json(await comment(actor, input), { status: 201 });
      case "set_request_status":
        return Response.json(await setRequestStatus(actor, input));
    }
  } catch (error) {
    return apiError(error);
  }
}
