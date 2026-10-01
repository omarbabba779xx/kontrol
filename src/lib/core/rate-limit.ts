import "server-only";

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
const buckets = new Map<string, Bucket>();

export function rateLimitPerMinute() {
  const configured = Number(process.env.KONTROL_RATE_LIMIT_PER_MINUTE ?? 600);
  return Number.isFinite(configured) && configured > 0 ? configured : 600;
}

/**
 * Fixed-window limiter keyed per caller. State is per process: behind several instances use a shared
 * limiter at the edge (API gateway, WAF) and treat this one as a last line of defence.
 */
export function consumeRateLimit(key: string, now = Date.now(), limit = rateLimitPerMinute()) {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 10_000) for (const [entryKey, entry] of buckets) if (entry.resetAt <= now) buckets.delete(entryKey);
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
}

export function resetRateLimits() {
  buckets.clear();
}
