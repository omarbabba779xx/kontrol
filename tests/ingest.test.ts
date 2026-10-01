import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
const MASTER = "m".repeat(40);
setEnv({ KONTROL_INGEST_SECRET: MASTER });

const ingest = () => import("../src/lib/core/ingest");

async function send(source: string, payload: unknown, options: { tenant?: string; secretFor?: string; timestamp?: number; mutate?: (body: string) => string } = {}) {
  const { deriveIngestSecret, signPayload } = await ingest();
  const { POST } = await import("../src/app/api/ingest/[source]/route");
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const signature = signPayload(deriveIngestSecret(MASTER, options.secretFor ?? admin.tenantId), timestamp, body);
  const response = await POST(new Request(`http://localhost/api/ingest/${source}`, { method: "POST", headers: { "x-kontrol-tenant": options.tenant ?? admin.tenantId, "x-kontrol-timestamp": timestamp, "x-kontrol-signature": signature, "content-type": "application/json" }, body: options.mutate ? options.mutate(body) : body }), { params: Promise.resolve({ source }) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const lms = (completed: number, enrolled = 100) => ({ asOf: new Date().toISOString(), training: { enrolled, completed } });
const hris = (overdue: number, unscreened: number) => ({ asOf: new Date().toISOString(), hr: { overdueDeprovisioning: overdue, unscreenedActiveStarters: unscreened } });

test("signature scheme: valid, tampered, wrong tenant secret, skewed clock", async () => {
  const { deriveIngestSecret, signPayload, verifySignature } = await ingest();
  const secret = deriveIngestSecret(MASTER, "tenant_a");
  assert.notEqual(secret, deriveIngestSecret(MASTER, "tenant_b"), "one derived secret per tenant");
  const now = 1_800_000_000;
  const signature = signPayload(secret, String(now), "{}");
  assert.ok(verifySignature({ secret, timestamp: String(now), body: "{}", signature, nowSeconds: now }));
  assert.ok(!verifySignature({ secret, timestamp: String(now), body: "{ }", signature, nowSeconds: now }), "body tampering");
  assert.ok(!verifySignature({ secret: deriveIngestSecret(MASTER, "tenant_b"), timestamp: String(now), body: "{}", signature, nowSeconds: now }), "another tenant's secret");
  assert.ok(!verifySignature({ secret, timestamp: String(now), body: "{}", signature, nowSeconds: now + 301 }), "stale timestamp");
  assert.ok(!verifySignature({ secret, timestamp: String(now), body: "{}", signature, nowSeconds: now - 301 }), "future timestamp");
  assert.ok(!verifySignature({ secret, timestamp: "abc", body: "{}", signature, nowSeconds: now }));
  assert.ok(!verifySignature({ secret, timestamp: String(now), body: "{}", signature: signature.slice(0, -2), nowSeconds: now }));
});

test("a signed learning-system report is evaluated by the control pack and becomes machine evidence", async () => {
  const { getDb } = await import("../src/lib/db");
  const ok = await send("lms", lms(97));
  assert.equal(ok.status, 202);
  assert.deepEqual((ok.body.evaluations as Array<{ controlCode: string; passed: boolean }>).map((item) => [item.controlCode, item.passed]), [["CTL-HR-001", true]]);
  assert.equal((ok.body.skipped as unknown[]).length, 2, "the HR controls wait for the HR feed");

  const db = (await getDb()).scope(admin.tenantId);
  const evidence = await db.get<{ status: string; source: string; expires_at: string; collected_at: string }>("SELECT e.status, e.source, e.expires_at, e.collected_at FROM evidence e JOIN controls c ON c.id = e.control_id WHERE c.code = 'CTL-HR-001' ORDER BY e.collected_at DESC LIMIT 1");
  assert.equal(evidence?.status, "healthy");
  assert.equal(evidence?.source, "lms:ingest");
  const days = (Date.parse(evidence!.expires_at) - Date.parse(evidence!.collected_at)) / 86_400_000;
  assert.ok(days > 34 && days < 36, `a monthly feed stays current for about 35 days, got ${days}`);

  const low = await send("lms", lms(80));
  assert.equal(low.status, 202);
  assert.equal((low.body.evaluations as Array<{ passed: boolean }>)[0].passed, false);
  const findings = await db.all<{ title: string }>("SELECT title FROM findings WHERE tenant_id = ? AND status = 'open'", admin.tenantId);
  assert.ok(findings.some((item) => item.title.includes("Security awareness training")));
});

test("an HR report evaluates leaver and screening controls", async () => {
  const result = await send("hris", hris(2, 0));
  assert.equal(result.status, 202);
  const verdicts = Object.fromEntries((result.body.evaluations as Array<{ controlCode: string; passed: boolean }>).map((item) => [item.controlCode, item.passed]));
  assert.deepEqual(verdicts, { "CTL-HR-002": false, "CTL-HR-003": true });
});

test("replays, forged signatures and unknown tenants are refused without leaking which", async () => {
  const payload = hris(0, 0);
  const timestamp = Math.floor(Date.now() / 1000);
  assert.equal((await send("hris", payload, { timestamp })).status, 202);
  assert.equal((await send("hris", payload, { timestamp })).status, 409, "the same signed request cannot be replayed");

  const forged = await send("hris", hris(0, 0), { secretFor: "tenant_other" });
  const unknown = await send("hris", hris(0, 0), { tenant: "tenant_does_not_exist", secretFor: "tenant_does_not_exist" });
  assert.equal(forged.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(forged.body, unknown.body, "identical answers");
  assert.equal((await send("hris", hris(0, 0), { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  assert.equal((await send("hris", payload, { mutate: (body) => body.replace('"overdueDeprovisioning":0', '"overdueDeprovisioning":5') })).status, 401, "a modified body invalidates the signature");
});

test("payload validation: impossible figures, stale or future reports, unknown sources", async () => {
  assert.equal((await send("lms", lms(120, 100))).status, 422, "completed cannot exceed enrolled");
  assert.equal((await send("lms", lms(10, 0))).status, 422, "no enrolment, no rate");
  assert.equal((await send("lms", { asOf: new Date(Date.now() - 90 * 86_400_000).toISOString(), training: { enrolled: 10, completed: 10 } })).status, 422, "a report older than 35 days is not evidence");
  assert.equal((await send("lms", { asOf: new Date(Date.now() + 86_400_000).toISOString(), training: { enrolled: 10, completed: 10 } })).status, 422, "no future reports");
  assert.equal((await send("hris", { asOf: new Date().toISOString(), hr: { overdueDeprovisioning: -1, unscreenedActiveStarters: 0 } })).status, 422);
  assert.equal((await send("payroll", {})).status, 404);
});

test("ingest is off until a strong master secret is configured", async () => {
  setEnv({ KONTROL_INGEST_SECRET: "short" });
  try { assert.equal((await send("lms", lms(99))).status, 503); } finally { setEnv({ KONTROL_INGEST_SECRET: MASTER }); }
});

test("oversized payloads are rejected before they are parsed", async () => {
  const { POST } = await import("../src/app/api/ingest/[source]/route");
  const big = JSON.stringify({ padding: "x".repeat(300 * 1024) });
  const response = await POST(new Request("http://localhost/api/ingest/lms", { method: "POST", headers: { "content-length": String(Buffer.byteLength(big)), "x-kontrol-tenant": admin.tenantId, "x-kontrol-timestamp": "1", "x-kontrol-signature": "sha256=00" }, body: big }), { params: Promise.resolve({ source: "lms" }) });
  assert.equal(response.status, 413);
});
