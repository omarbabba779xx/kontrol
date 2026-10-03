import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { deleteDocument, retrieveDocument } from "@/lib/core/vault-store";

export const runtime = "nodejs";

/** Downloads a document after verifying it against the hash recorded at upload. A document that fails verification is never served. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "evidence:read");
    const document = await retrieveDocument(actor, (await context.params).id);
    return new Response(new Uint8Array(document.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${document.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
        "X-Content-SHA256": document.sha256,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}

/** Deletes a document whose retention period has ended. Restricted to those who manage credentials and keys (administrators). */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireActor(request, "credentials:manage");
    const { reason } = z.object({ reason: z.string().min(10).max(1000) }).parse(await request.json());
    return Response.json(await deleteDocument(actor, { id: (await context.params).id, reason }));
  } catch (error) {
    return apiError(error);
  }
}
