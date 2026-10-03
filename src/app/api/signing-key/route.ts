import { publicSigningKey } from "@/lib/core/signing";

export const runtime = "nodejs";

/** The public half of the signing key. Public by design: it lets anyone verify decisions, reports and audit anchors without trusting this server. */
export async function GET() {
  try {
    return Response.json(publicSigningKey(), { headers: { "Cache-Control": "public, max-age=300" } });
  } catch {
    return Response.json({ error: "Signing key unavailable" }, { status: 503 });
  }
}
