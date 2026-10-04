import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { anchorStatus, publishPendingAnchors } from "@/lib/core/anchor-publisher";
import { createAnchor, listAnchors, verifyAgainstAnchors } from "@/lib/core/audit-anchor";
import { publicSigningKey } from "@/lib/core/signing";

export const runtime = "nodejs";

const anchorSchema = z.object({
  tenantId: z.string(),
  entries: z.number().int().positive(),
  headHash: z.string().length(64),
  keyFingerprint: z.string(),
  createdAt: z.string(),
  signature: z.string(),
});
const verifySchema = z.object({ anchors: z.array(anchorSchema).max(500).default([]), publicKeyPem: z.string().max(2000).optional() });

/** Takes an anchor and tries to publish it straight away, so the caller sees whether it reached the sink. */
async function anchored(actor: Awaited<ReturnType<typeof requireActor>>) {
  const result = await createAnchor(actor);
  return { ...result, publication: { ...(await publishPendingAnchors(actor.tenantId)), ...(await anchorStatus(actor.tenantId)) } };
}

/** GET: the stored anchors and how the live chain compares. Copy them to storage the database owner cannot rewrite. */
export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "audit:read");
    return Response.json({
      anchors: await listAnchors(actor.tenantId),
      verification: await verifyAgainstAnchors(actor.tenantId),
      publicKey: await publicSigningKey(),
      publication: await anchorStatus(actor.tenantId),
    });
  } catch (error) {
    return apiError(error);
  }
}

/** POST: with an empty body, signs the current head of the chain. With `anchors`, checks the chain against copies held elsewhere. */
export async function POST(request: Request) {
  try {
    const actor = await requireActor(request, "audit:manage");
    const text = await request.text();
    if (!text.trim()) return Response.json(await anchored(actor), { status: 201 });
    const input = verifySchema.parse(JSON.parse(text));
    if (!input.anchors.length) return Response.json(await anchored(actor), { status: 201 });
    return Response.json(await verifyAgainstAnchors(actor.tenantId, input.anchors, input.publicKeyPem));
  } catch (error) {
    return apiError(error);
  }
}
