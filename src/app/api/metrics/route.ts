import { safeEqual } from "@/lib/core/config";
import { collectMetrics } from "@/lib/core/metrics";

export const runtime = "nodejs";

/** Prometheus scrape endpoint. Disabled (404) unless KONTROL_METRICS_TOKEN is set; otherwise requires it as a bearer token. */
export async function GET(request: Request) {
  const token = process.env.KONTROL_METRICS_TOKEN;
  if (!token || token.length < 24) return new Response("Not found", { status: 404 });
  const presented = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!safeEqual(presented, token)) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  return new Response(await collectMetrics(), { headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" } });
}
