import { IngestError, ingestReport } from "@/lib/core/ingest";

export const runtime = "nodejs";

/** Signed report from an HR or learning system. See src/lib/core/ingest.ts for the signature scheme. */
export async function POST(request: Request, context: { params: Promise<{ source: string }> }) {
  try {
    const { source } = await context.params;
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > 256 * 1024) throw new IngestError("Payload too large", 413);
    const body = await request.text();
    try { JSON.parse(body); } catch { throw new IngestError("Body must be JSON", 400); }
    return Response.json(await ingestReport({
      source,
      tenantId: request.headers.get("x-kontrol-tenant") ?? "",
      timestamp: request.headers.get("x-kontrol-timestamp") ?? "",
      signature: request.headers.get("x-kontrol-signature") ?? "",
      body,
    }), { status: 202 });
  } catch (error) {
    if (error instanceof IngestError) return Response.json({ error: error.message }, { status: error.status });
    console.error(error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
