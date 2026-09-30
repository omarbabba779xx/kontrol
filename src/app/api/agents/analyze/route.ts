import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { agentRequestSchema } from "@/lib/core/schemas";
import { runKontrolAgent } from "@/lib/agents/kontrol-agents";

export const runtime = "nodejs";
export async function POST(request: Request) { try { const actor = await requireActor(request, "agents:run"); const input = agentRequestSchema.parse(await request.json()); return Response.json(await runKontrolAgent(actor, input.agent, input.question, input.subjectId)); } catch (error) { return apiError(error); } }
