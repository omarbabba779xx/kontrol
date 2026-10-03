import "server-only";

import { getDb } from "@/lib/db";

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
const buckets = new Map<string, Bucket>();

export function rateLimitPerMinute() {
  const configured = Number(process.env.KONTROL_RATE_LIMIT_PER_MINUTE ?? 600);
  return Number.isFinite(configured) && configured > 0 ? configured : 600;
}

/**
 * Fixed-window limiter keyed per caller, kept in this process. It is the cheap first line for authenticated traffic: every request of a
 * signed-in user passes through it without touching the database. It does not span instances; the limits that must hold across
 * instances (sign-in, unauthenticated endpoints, repeated authentication failures) use `consumeSharedRateLimit`.
 */
export function consumeRateLimit(key: string, now = Date.now(), limit = rateLimitPerMinute()) {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 10_000) for (const [entryKey, entry] of buckets) if (entry.resetAt <= now) buckets.delete(entryKey);
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
  };
}

export function resetRateLimits() {
  buckets.clear();
}

/**
 * Fixed-window limiter shared by every instance through the database: one atomic upsert per call, so two instances cannot both
 * count the same request as the first. If the database cannot be reached the process-local limiter answers instead; a limiter that
 * fails open on an outage would be an invitation, one that fails closed would turn an outage into a lockout of everybody.
 */
export async function consumeSharedRateLimit(key: string, limit: number, windowMs = WINDOW_MS, now = Date.now()) {
  try {
    const db = (await getDb()).system();
    // The window opens at the first request and lasts windowMs, so it is not tied to the wall clock: a burst cannot be split in two by
    // a minute boundary it happened to straddle.
    const expired = "? - rate_limits.window_start >= ?";
    const row = await db.get<{ count: number | string; window_start: number | string }>(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN ${expired} THEN 1 ELSE rate_limits.count + 1 END, window_start = CASE WHEN ${expired} THEN ? ELSE rate_limits.window_start END RETURNING count, window_start`,
      key, now, now, windowMs, now, windowMs, now,
    );
    const count = Number(row?.count ?? 1);
    const windowStart = Number(row?.window_start ?? now);
    // Old windows are removed now and then rather than on a timer, so there is nothing to schedule.
    if (Math.random() < 0.01) await db.run("DELETE FROM rate_limits WHERE window_start < ?", now - 3_600_000 - windowMs).catch(() => undefined);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
    };
  } catch {
    return consumeRateLimit(`shared-fallback:${key}`, now, limit);
  }
}

/**
 * Who is calling, for limits on requests that carry no identity. The forwarding header is only believed when the deployment says a
 * proxy it controls sets it (`KONTROL_TRUSTED_PROXY_HOPS`, the number of proxies in front of the app); the address that proxy appended is
 * used, not the first one, which the caller can write themselves.
 */
export function clientKey(request: Request) {
  const hops = Number(process.env.KONTROL_TRUSTED_PROXY_HOPS ?? 0);
  if (!Number.isInteger(hops) || hops < 1) return "direct";
  const forwarded = (request.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded.length >= hops ? forwarded[forwarded.length - hops].slice(0, 64) : "direct";
}

export const tooManyRequests = (retryAfterSeconds: number) =>
  Response.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });
