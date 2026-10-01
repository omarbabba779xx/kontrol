import assert from "node:assert/strict";
import { test } from "node:test";

test("rate limiter allows the quota then blocks until the window resets", async () => {
  const { consumeRateLimit, resetRateLimits } = await import("../src/lib/core/rate-limit");
  resetRateLimits();
  const start = 1_000_000;
  for (let i = 0; i < 3; i++) assert.equal(consumeRateLimit("k", start, 3).allowed, true);
  const blocked = consumeRateLimit("k", start + 1_000, 3);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.equal(consumeRateLimit("other", start, 3).allowed, true, "keys are independent");
  assert.equal(consumeRateLimit("k", start + 61_000, 3).allowed, true, "window resets");
});
