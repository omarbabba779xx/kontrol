import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { ingestRegulation } from "@/lib/core/regulatory";
import { regulatoryIngestSchema } from "@/lib/core/schemas";

export const runtime = "nodejs";
export async function POST(request: Request) { try { const actor = await requireActor(request, "regulations:ingest"); return Response.json(ingestRegulation(actor, regulatoryIngestSchema.parse(await request.json()))); } catch (error) { return apiError(error); } }
