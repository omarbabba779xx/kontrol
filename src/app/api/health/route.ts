import { getDb } from "@/lib/core/database";

export const runtime = "nodejs";
export function GET() {
  const check = getDb().prepare("SELECT 1 AS ok").get() as { ok: number };
  return Response.json({ status: check.ok === 1 ? "healthy" : "degraded", service: "kontrol-kernel", time: new Date().toISOString() });
}
