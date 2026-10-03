import { signingKeyMode } from "@/lib/core/signing";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  let healthy = false;
  try {
    const check = await (await getDb()).system().get<{ ok: number | string }>("SELECT 1 AS ok");
    healthy = Number(check?.ok) === 1;
  } catch {
    healthy = false;
  }
  return Response.json({ status: healthy ? "healthy" : "degraded", service: "kontrol-kernel", signingKey: signingKeyMode(), time: new Date().toISOString() });
}
