import { authenticate, type Actor } from "@/lib/core/auth";
import { safeEqual } from "@/lib/core/config";
import { apiError } from "@/lib/core/api";
import { runDueWorkflows } from "@/lib/core/workflow-engine";
import { runAssuranceScan } from "@/lib/core/assurance-engine";
import { runDueJobs } from "@/lib/core/scheduler";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    let actor = await authenticate(request);
    if (process.env.CRON_SECRET && supplied && safeEqual(supplied, process.env.CRON_SECRET)) actor = { userId: "system:cron", tenantId: "tenant_acme", email: "system@kontrol.local", name: "Kontrol Scheduler", role: "admin" } satisfies Actor;
    if (!actor) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const processed = await runDueWorkflows(actor, 25);
    const assurance = await runAssuranceScan(actor);
    const connectors = await runDueJobs();
    return Response.json({ processed, assurance, connectors: connectors.map(({ scheduleId, status, error }) => ({ scheduleId, status, error })) });
  } catch (error) { return apiError(error); }
}
