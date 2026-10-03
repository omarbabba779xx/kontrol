import assert from "node:assert/strict";
import { test } from "node:test";
import { isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const limiter = () => import("../src/lib/core/rate-limit");

test("a shared limit counts in the database, so it holds after the process-local state is gone (another instance, a restart)", async () => {
  const { consumeSharedRateLimit, resetRateLimits } = await limiter();
  const now = Date.UTC(2026, 9, 3, 12, 0, 10);
  const outcomes: boolean[] = [];
  for (let call = 0; call < 7; call += 1) {
    if (call === 3) resetRateLimits(); // a second instance has none of the first one's memory
    outcomes.push((await consumeSharedRateLimit("probe:a", 5, 60_000, now)).allowed);
  }
  assert.deepEqual(outcomes, [true, true, true, true, true, false, false]);
  const blocked = await consumeSharedRateLimit("probe:a", 5, 60_000, now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 50);
});

test("keys are independent and the count starts over in the next window", async () => {
  const { consumeSharedRateLimit } = await limiter();
  const now = Date.UTC(2026, 9, 3, 12, 5, 0);
  for (let call = 0; call < 3; call += 1) await consumeSharedRateLimit("probe:b", 2, 60_000, now);
  assert.equal((await consumeSharedRateLimit("probe:b", 2, 60_000, now)).allowed, false);
  assert.equal((await consumeSharedRateLimit("probe:c", 2, 60_000, now)).allowed, true, "another key is not affected");
  assert.equal((await consumeSharedRateLimit("probe:b", 2, 60_000, now + 60_000)).allowed, true, "the next window starts at one");
});

test("concurrent calls are counted exactly once each", async () => {
  const { consumeSharedRateLimit } = await limiter();
  const now = Date.UTC(2026, 9, 3, 13, 0, 0);
  const results = await Promise.all(Array.from({ length: 20 }, () => consumeSharedRateLimit("probe:burst", 8, 60_000, now)));
  assert.equal(results.filter((result) => result.allowed).length, 8);
});

test("the forwarding header is believed only for the proxies the deployment says it has, and the nearest one's entry is used", async () => {
  const { clientKey } = await limiter();
  const request = (forwarded: string) => new Request("http://localhost/", { headers: { "x-forwarded-for": forwarded } });
  delete process.env.KONTROL_TRUSTED_PROXY_HOPS;
  assert.equal(clientKey(request("1.2.3.4")), "direct", "no trusted proxy: the header is just a claim by the caller");
  process.env.KONTROL_TRUSTED_PROXY_HOPS = "1";
  assert.equal(clientKey(request("6.6.6.6, 203.0.113.9")), "203.0.113.9", "the caller can write the first entry; the proxy wrote the last");
  process.env.KONTROL_TRUSTED_PROXY_HOPS = "2";
  assert.equal(clientKey(request("6.6.6.6, 198.51.100.4, 203.0.113.9")), "198.51.100.4");
  assert.equal(clientKey(request("203.0.113.9")), "direct", "fewer entries than trusted proxies: not believed");
  delete process.env.KONTROL_TRUSTED_PROXY_HOPS;
});

test("repeated failed authentication from one client is stopped with 429 and Retry-After on the public endpoints", async () => {
  const { requireActor } = await import("../src/lib/core/auth");
  const statuses: number[] = [];
  const anonymous = () => new Request("http://localhost/api/evidence-trail", { headers: { authorization: "Bearer not-a-valid-token" } });
  for (let call = 0; call < 125; call += 1) {
    try { await requireActor(anonymous(), "evidence:read"); } catch (error) { statuses.push((error as { status: number }).status); }
  }
  assert.equal(statuses[0], 401);
  assert.equal(statuses.at(-1), 429);
  assert.ok(statuses.filter((status) => status === 401).length >= 120);
});
