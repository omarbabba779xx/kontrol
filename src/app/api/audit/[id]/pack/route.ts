import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { buildEvidencePack } from "@/lib/core/audit-pack";

export const runtime = "nodejs";

/** The engagement's self-verifying evidence pack (ZIP). Every download is recorded. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "audit:read");
    const pack = await buildEvidencePack(actor, (await context.params).id);
    return new Response(Buffer.from(pack.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${pack.filename}"`,
        "X-Pack-Fingerprint": pack.manifest.manifestFingerprint,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
