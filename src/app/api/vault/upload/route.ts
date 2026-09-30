import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { storeVaultDocument } from "@/lib/core/enterprise-engine";

export const runtime = "nodejs";
export async function POST(request: Request) { try { const actor = await requireActor(request, "evidence:write"); const form = await request.formData(); const file = form.get("file"); const documentType = String(form.get("documentType") ?? "other"); if (!(file instanceof File)) return Response.json({ error: "File is required" }, { status: 400 }); return Response.json(await storeVaultDocument(actor, file, documentType), { status: 201 }); } catch (error) { return apiError(error); } }
