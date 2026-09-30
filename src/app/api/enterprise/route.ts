import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { addRegulatoryFeed, calculateAttackPaths, calculateBenchmark, checkRegulatoryFeeds, compilePolicy, createCase, createWorkflowDefinition, ensureDemoGrant, enterpriseSnapshot, evaluateContinuousAuthorization } from "@/lib/core/enterprise-engine";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add_feed"), name: z.string().min(3), framework: z.string().min(2), sourceUrl: z.string().url(), cadence: z.string().default("daily") }),
  z.object({ action: z.literal("check_feeds") }),
  z.object({ action: z.literal("compile_policy"), name: z.string().min(3), requirement: z.string().min(15), frequency: z.string().default("continuous") }),
  z.object({ action: z.literal("create_case"), title: z.string().min(3), sourceType: z.string().min(2), sourceId: z.string().min(2), severity: z.enum(["low", "medium", "high", "critical"]), remediation: z.string().min(10) }),
  z.object({ action: z.literal("evaluate_authorizations") }),
  z.object({ action: z.literal("calculate_attack_paths") }),
  z.object({ action: z.literal("create_workflow"), name: z.string().min(3), trigger: z.string().min(3), nodes: z.array(z.object({ id: z.string(), type: z.string(), label: z.string() })).min(2), edges: z.array(z.object({ source: z.string(), target: z.string() })).min(1) }),
  z.object({ action: z.literal("calculate_benchmark") }),
]);

export const runtime = "nodejs";
export async function GET(request: Request) { try { const actor = await requireActor(request, "graph:read"); return Response.json(await enterpriseSnapshot(actor.tenantId)); } catch (error) { return apiError(error); } }
export async function POST(request: Request) { try { const actor = await requireActor(request, "controls:evaluate"); const input = actionSchema.parse(await request.json()); if (input.action === "add_feed") return Response.json(addRegulatoryFeed(actor, input), { status: 201 }); if (input.action === "check_feeds") return Response.json({ results: await checkRegulatoryFeeds(actor) }); if (input.action === "compile_policy") return Response.json(compilePolicy(actor, input), { status: 201 }); if (input.action === "create_case") return Response.json(createCase(actor, input), { status: 201 }); if (input.action === "evaluate_authorizations") { ensureDemoGrant(actor); return Response.json({ results: evaluateContinuousAuthorization(actor) }); } if (input.action === "calculate_attack_paths") return Response.json({ paths: calculateAttackPaths(actor) }); if (input.action === "create_workflow") return Response.json(createWorkflowDefinition(actor, input), { status: 201 }); return Response.json(calculateBenchmark(actor)); } catch (error) { return apiError(error); } }
