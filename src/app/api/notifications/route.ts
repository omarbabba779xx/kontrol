import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { createChannel, deleteChannel, listChannels, retryNotification, SEVERITIES, setChannelEnabled, testChannel, type ChannelKind } from "@/lib/core/notifications";

export const runtime = "nodejs";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_channel"), kind: z.enum(["slack", "webhook", "email", "jira"]), name: z.string().min(2).max(80), config: z.record(z.string(), z.unknown()), events: z.array(z.string().max(60)).max(30).default(["*"]), minSeverity: z.enum(SEVERITIES).default("low") }),
  z.object({ action: z.literal("set_enabled"), id: z.string().min(3), enabled: z.boolean() }),
  z.object({ action: z.literal("delete_channel"), id: z.string().min(3) }),
  z.object({ action: z.literal("test_channel"), id: z.string().min(3) }),
  z.object({ action: z.literal("retry"), id: z.string().min(3) }),
]);

export async function GET(request: Request) {
  try { const actor = await requireActor(request, "credentials:manage"); return Response.json(await listChannels(actor.tenantId)); }
  catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, "credentials:manage");
    const input = actionSchema.parse(await request.json());
    switch (input.action) {
      case "create_channel": return Response.json(await createChannel(actor, { ...input, kind: input.kind as ChannelKind }), { status: 201 });
      case "set_enabled": return Response.json(await setChannelEnabled(actor, input));
      case "delete_channel": return Response.json(await deleteChannel(actor, input.id));
      case "test_channel": return Response.json(await testChannel(actor, input.id));
      case "retry": return Response.json(await retryNotification(actor, input.id));
    }
  } catch (error) { return apiError(error); }
}
