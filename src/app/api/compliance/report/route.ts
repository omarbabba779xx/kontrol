import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { buildReadinessReport } from "@/lib/core/report";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import type { FrameworkId } from "@/lib/frameworks/types";

export const runtime = "nodejs";

/** Audit readiness report as a PDF. `?framework=iso27001` limits it to one adopted framework. */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "oscal:export");
    const framework = new URL(request.url).searchParams.get("framework");
    if (framework && !FRAMEWORK_BY_ID.has(framework as FrameworkId)) return Response.json({ error: `Framework ${framework} not found` }, { status: 404 });
    const { bytes, meta } = await buildReadinessReport(actor, { frameworkId: (framework as FrameworkId | null) ?? undefined });
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="audit-readiness${framework ? `-${framework}` : ""}.pdf"`, "X-Report-Fingerprint": meta.fingerprint, "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
