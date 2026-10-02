import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { deleteSchedule, INTERVALS_MINUTES, listSchedules, runScheduleNow, saveSchedule } from "@/lib/core/scheduler";

export const runtime = "nodejs";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), kind: z.string().min(2).max(40), params: z.object({ owner: z.string().max(100).optional(), repository: z.string().max(100).optional(), project: z.string().max(300).optional() }).default({}), intervalMinutes: z.number().refine((value) => (INTERVALS_MINUTES as readonly number[]).includes(value), "Unsupported interval"), enabled: z.boolean().default(true) }),
  z.object({ action: z.literal("delete"), id: z.string().min(3) }),
  z.object({ action: z.literal("run_now"), id: z.string().min(3) }),
]);

export async function GET(request: Request) {
  try { const actor = await requireActor(request, "graph:read"); return Response.json(await listSchedules(actor.tenantId)); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, "connectors:sync");
    const input = actionSchema.parse(await request.json());
    if (input.action === "save") return Response.json(await saveSchedule(actor, input), { status: 201 });
    if (input.action === "delete") return Response.json(await deleteSchedule(actor, input.id));
    return Response.json(await runScheduleNow(actor, input.id));
  } catch (error) { return apiError(error); }
}
