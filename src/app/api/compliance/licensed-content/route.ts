import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { refreshComplianceTrend } from "@/lib/core/compliance-engine";
import { importLicensedContent, listImports, MAX_IMPORT_BYTES, removeLicensedContent } from "@/lib/core/licensed-content";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import type { FrameworkId } from "@/lib/frameworks/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try { const actor = await requireActor(request, "graph:read"); return Response.json({ imports: await listImports(actor.tenantId) }); }
  catch (error) { return apiError(error); }
}

/**
 * Imports the organisation's own licensed copy of framework text (see src/lib/core/licensed-content.ts). Administrators only.
 * The body must include `acknowledgeLicence: true`; the acknowledgement, licence reference and a content hash are recorded in the audit log.
 */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, "regulations:ingest");
    if (Number(request.headers.get("content-length") ?? 0) > MAX_IMPORT_BYTES) return Response.json({ error: "Import is larger than 5 MB" }, { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) return Response.json({ error: "Import is larger than 5 MB" }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return Response.json({ error: "Body must be JSON" }, { status: 400 }); }
    const result = await importLicensedContent(actor, body);
    await refreshComplianceTrend(actor);
    return Response.json(result, { status: 201 });
  } catch (error) { return apiError(error); }
}

/** Removes everything imported for a framework, for example when a licence lapses. */
export async function DELETE(request: Request) {
  try {
    const actor = await requireActor(request, "regulations:ingest");
    const framework = new URL(request.url).searchParams.get("framework") ?? "";
    if (!FRAMEWORK_BY_ID.has(framework as FrameworkId)) return Response.json({ error: `Framework ${framework} not found` }, { status: 404 });
    const result = await removeLicensedContent(actor, framework as FrameworkId);
    await refreshComplianceTrend(actor);
    return Response.json(result);
  } catch (error) { return apiError(error); }
}
