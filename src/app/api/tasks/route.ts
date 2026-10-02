import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { addComment, createTask, createTaskFromFinding, createTasksFromRoadmap, listTasks, PRIORITIES, STATUSES, updateTask } from "@/lib/core/tasks";

export const runtime = "nodejs";

const priority = z.enum(PRIORITIES);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title: z.string().min(3).max(200), description: z.string().max(5000).optional(), priority: priority.default("medium"), dueAt: z.string().datetime().optional(), assigneeId: z.string().min(3).optional(), ucCode: z.string().regex(/^UC-[A-Z]+-\d{2}$/).optional() }),
  z.object({ action: z.literal("update"), id: z.string().min(3), status: z.enum(STATUSES).optional(), assigneeId: z.string().min(3).nullable().optional(), priority: priority.optional(), dueAt: z.string().datetime().nullable().optional(), title: z.string().min(3).max(200).optional() }),
  z.object({ action: z.literal("comment"), taskId: z.string().min(3), body: z.string().min(2).max(4000) }),
  z.object({ action: z.literal("from_roadmap"), limit: z.number().int().min(1).max(25).default(10) }),
  z.object({ action: z.literal("from_finding"), findingId: z.string().min(3) }),
]);

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "graph:read");
    const params = new URL(request.url).searchParams;
    return Response.json({ tasks: await listTasks(actor.tenantId, { status: params.get("status") ?? undefined, open: params.get("open") === "1", assigneeId: params.get("assignee") === "me" ? actor.userId : params.get("assignee") ?? undefined }) });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, "controls:evaluate");
    const input = actionSchema.parse(await request.json());
    switch (input.action) {
      case "create": return Response.json(await createTask(actor, input), { status: 201 });
      case "update": return Response.json(await updateTask(actor, input));
      case "comment": return Response.json(await addComment(actor, input), { status: 201 });
      case "from_roadmap": return Response.json(await createTasksFromRoadmap(actor, input), { status: 201 });
      case "from_finding": return Response.json(await createTaskFromFinding(actor, input.findingId), { status: 201 });
    }
  } catch (error) { return apiError(error); }
}
