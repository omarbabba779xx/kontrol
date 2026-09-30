import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { getDb } from "@/lib/core/database";
import { startWorkflow } from "@/lib/core/workflow-engine";

const workflowSchema = z.object({ kind: z.enum(["continuous_control", "ai_release", "regulatory_change"]), payload: z.record(z.string(), z.unknown()).default({}) });
export const runtime = "nodejs";
export async function GET(request: Request) { try { const actor = await requireActor(request, "graph:read"); return Response.json(getDb().prepare("SELECT * FROM workflows WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100").all(actor.tenantId)); } catch (error) { return apiError(error); } }
export async function POST(request: Request) { try { const actor = await requireActor(request, "controls:evaluate"); const input = workflowSchema.parse(await request.json()); return Response.json(startWorkflow(actor, input.kind, input.payload), { status: 201 }); } catch (error) { return apiError(error); } }
