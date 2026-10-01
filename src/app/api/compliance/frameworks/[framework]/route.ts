import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { exportStatement, frameworkDetail } from "@/lib/core/compliance-engine";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import type { FrameworkId } from "@/lib/frameworks/types";

export const runtime = "nodejs";

/** `?format=csv|json` downloads a Statement of Applicability; without it the requirement-level detail is returned. */
export async function GET(request: Request, context: { params: Promise<{ framework: string }> }) {
  try {
    const actor = await requireActor(request, "oscal:export");
    const { framework } = await context.params;
    if (!FRAMEWORK_BY_ID.has(framework as FrameworkId)) return Response.json({ error: `Framework ${framework} not found` }, { status: 404 });
    const frameworkId = framework as FrameworkId;
    const format = new URL(request.url).searchParams.get("format");
    if (format === "csv" || format === "json") {
      const statement = await exportStatement(actor.tenantId, frameworkId);
      const headers = { "Content-Disposition": `attachment; filename="soa-${frameworkId}.${format}"` };
      return format === "csv" ? new Response(statement.csv, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } }) : Response.json(statement.json, { headers });
    }
    return Response.json(await frameworkDetail(actor.tenantId, frameworkId));
  } catch (error) { return apiError(error); }
}
