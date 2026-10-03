import { z } from "zod";
import { apiError } from "@/lib/core/api";
import { clientKey, consumeSharedRateLimit, tooManyRequests } from "@/lib/core/rate-limit";
import { publicQuestionnaire, submitPublicQuestionnaire } from "@/lib/core/third-party";

export const runtime = "nodejs";

/** Public endpoints, authorised only by the unguessable one-time token in the URL. Rate-limited per caller. */
async function limited(request: Request) {
  const result = await consumeSharedRateLimit(`vendor-response:${clientKey(request)}`, 30);
  return result.allowed ? null : tooManyRequests(result.retryAfterSeconds);
}

const body = z.object({
  respondentName: z.string().min(2).max(200),
  respondentEmail: z.string().email().max(200),
  answers: z.record(
    z.string().max(20),
    z.object({ answer: z.enum(["yes", "partial", "no", "na"]), comment: z.string().max(2000).optional() }),
  ),
});

export async function GET(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const blocked = await limited(request);
    if (blocked) return blocked;
    return Response.json(await publicQuestionnaire((await context.params).token), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const blocked = await limited(request);
    if (blocked) return blocked;
    if (Number(request.headers.get("content-length") ?? 0) > 128 * 1024)
      return Response.json({ error: "Payload too large" }, { status: 413 });
    return Response.json(await submitPublicQuestionnaire((await context.params).token, body.parse(await request.json())), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
