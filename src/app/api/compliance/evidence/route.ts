import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { attachEvidence } from "@/lib/core/compliance-engine";

export const runtime = "nodejs";

const fieldsSchema = z.object({
  ucCode: z.string().regex(/^UC-[A-Z]+-\d{2}$/),
  title: z.string().min(3).max(200),
  kind: z.enum(["document", "record", "report", "certificate"]),
  validUntil: z.string().datetime(),
  note: z.string().max(2000).default(""),
});

/** Uploads a document as evidence for a unified control. It stays pending until someone other than the uploader accepts it. */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, "evidence:write");
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return Response.json({ error: "A non-empty file is required" }, { status: 400 });
    const fields = fieldsSchema.parse({ ucCode: form.get("ucCode"), title: form.get("title"), kind: form.get("kind"), validUntil: form.get("validUntil"), note: form.get("note") ?? "" });
    return Response.json(await attachEvidence(actor, { ...fields, file }), { status: 201 });
  } catch (error) { return apiError(error); }
}
