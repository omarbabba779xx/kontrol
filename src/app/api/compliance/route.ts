import { z } from "zod";
import { requireActor, type Permission } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { installControlPack } from "@/lib/connectors";
import {
  adoptFramework,
  complianceSnapshot,
  countersign,
  decideException,
  linkEvidence,
  loadDemoPosture,
  purgeDemoPosture,
  reattest,
  recordComplianceSnapshot,
  requestException,
  reviewEvidence,
  reviewMapping,
  setImplementation,
  setRequirementScope,
  upsertPolicy,
} from "@/lib/core/compliance-engine";

const framework = z.enum(["iso27001", "nist_csf", "soc2", "gdpr", "nis2", "dora", "eu_ai_act", "iso42001", "pci_dss", "cis_v8"]);
const ucCode = z.string().regex(/^UC-[A-Z]+-\d{2}$/);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("adopt_framework"),
    frameworkId: framework,
    scope: z.string().min(5).max(500),
    targetDate: z.string().date().optional(),
  }),
  z.object({
    action: z.literal("set_implementation"),
    ucCode,
    status: z.enum(["not_started", "planned", "partial", "implemented", "not_applicable"]),
    maturity: z.number().int().min(0).max(5),
    ownerId: z.string().min(3).optional(),
    linkedControlCode: z.string().min(3).max(300).optional(),
    notes: z.string().max(2000).default(""),
    reviewDue: z.string().datetime().optional(),
  }),
  z.object({
    action: z.literal("set_requirement_scope"),
    frameworkId: framework,
    requirementId: z.string().min(1).max(40),
    applicable: z.boolean(),
    justification: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal("request_exception"),
    ucCode,
    title: z.string().min(5).max(200),
    justification: z.string().min(20).max(4000),
    compensatingControls: z.string().min(10).max(4000),
    riskLevel: z.enum(["low", "medium", "high", "critical"]),
    expiresAt: z.string().datetime(),
  }),
  z.object({ action: z.literal("decide_exception"), id: z.string().min(3), approve: z.boolean(), note: z.string().min(10).max(2000) }),
  z.object({
    action: z.literal("save_policy"),
    id: z.string().min(3).optional(),
    title: z.string().min(3).max(200),
    version: z.string().min(1).max(30),
    status: z.enum(["draft", "in_review", "approved", "retired"]),
    ownerId: z.string().min(3).optional(),
    nextReview: z.string().datetime().optional(),
    ucCodes: z.array(ucCode).max(50),
    content: z.string().max(500_000).optional(),
  }),
  z.object({
    action: z.literal("review_mapping"),
    frameworkId: framework,
    requirementId: z.string().min(1).max(40),
    ucCode,
    decision: z.enum(["validated", "rejected", "added", "reset"]),
    note: z.string().max(2000).optional(),
  }),
  z.object({ action: z.literal("reattest"), ucCode, note: z.string().min(10).max(2000) }),
  z.object({ action: z.literal("countersign"), ucCode, note: z.string().min(10).max(2000) }),
  z.object({ action: z.literal("review_evidence"), id: z.string().min(3), accept: z.boolean(), note: z.string().min(10).max(2000) }),
  z.object({ action: z.literal("install_pack") }),
  z.object({ action: z.literal("link_evidence") }),
  z.object({ action: z.literal("snapshot") }),
  z.object({ action: z.literal("load_demo") }),
  z.object({ action: z.literal("purge_demo") }),
]);

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    return Response.json(await complianceSnapshot(actor.tenantId));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = actionSchema.parse(await request.json());
    const permission: Permission = ["decide_exception", "review_mapping", "countersign", "review_evidence"].includes(input.action)
      ? "decisions:approve"
      : "controls:evaluate";
    const actor = await requireActor(request, permission);
    switch (input.action) {
      case "adopt_framework":
        return Response.json(await adoptFramework(actor, input), { status: 201 });
      case "set_implementation":
        return Response.json(await setImplementation(actor, input));
      case "set_requirement_scope":
        return Response.json(await setRequirementScope(actor, input));
      case "request_exception":
        return Response.json(await requestException(actor, input), { status: 201 });
      case "decide_exception":
        return Response.json(await decideException(actor, input));
      case "save_policy":
        return Response.json(await upsertPolicy(actor, input), { status: 201 });
      case "snapshot":
        return Response.json(await recordComplianceSnapshot(actor));
      case "review_mapping":
        return Response.json(await reviewMapping(actor, input));
      case "reattest":
        return Response.json(await reattest(actor, input));
      case "countersign":
        return Response.json(await countersign(actor, input));
      case "review_evidence":
        return Response.json(await reviewEvidence(actor, input));
      case "install_pack":
        return Response.json(await installControlPack(actor));
      case "link_evidence":
        return Response.json(await linkEvidence(actor));
      case "load_demo":
        return Response.json(await loadDemoPosture(actor));
      case "purge_demo":
        return Response.json(await purgeDemoPosture(actor));
    }
  } catch (error) {
    return apiError(error);
  }
}
