import assert from "node:assert/strict";
import { test } from "node:test";

test("a server fault answers with a reference and no internals; the detail goes to the log", async () => {
  const { apiError } = await import("../src/lib/core/api");
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const response = apiError(new Error('duplicate key value violates unique constraint "users_pkey" at /srv/app/db.ts:44'));
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string; reference: string };
    assert.equal(body.error, "Internal server error");
    assert.match(body.reference, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(body).includes("users_pkey") && !JSON.stringify(body).includes("/srv/app"));
    assert.ok(logged.some((line) => line.includes(body.reference) && line.includes("users_pkey")), "the reference ties the answer to the detailed log line");
    const text = apiError("a string was thrown");
    assert.equal(text.status, 500);
    // The word "not found" in an internal message no longer turns a fault into a 404.
    assert.equal(apiError(new Error("socket not found")).status, 500);
  } finally { console.error = realError; }
});

test("failures the caller can act on keep their status and message, including a missing control or asset", async () => {
  const { apiError } = await import("../src/lib/core/api");
  const { userError } = await import("../src/lib/core/errors");
  const missing = apiError(userError("Control CTL-X not found"));
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: string }).error, "Control CTL-X not found");
  assert.equal(apiError(userError("Already approved")).status, 409);
});
