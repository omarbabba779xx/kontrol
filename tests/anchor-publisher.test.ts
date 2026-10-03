import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const publisher = () => import("../src/lib/core/anchor-publisher");
const db = async () => (await import("../src/lib/db")).getDb();
const HOUR = 3_600_000;

type Put = { url: string; method?: string; authorization?: string; body: { kind: string; anchor: { entries: number; signature: string }; publicKey: { fingerprint: string } } };

async function withSink(answer: (put: Put) => number, run: (puts: Put[]) => Promise<void>) {
  const { setOutboundTransport } = await import("../src/lib/core/net-guard");
  const puts: Put[] = [];
  setOutboundTransport(async (url, init) => {
    const put: Put = { url, method: init.method, authorization: init.headers?.Authorization, body: JSON.parse(String(init.body)) };
    puts.push(put);
    return new Response("{}", { status: answer(put) });
  });
  process.env.KONTROL_ANCHOR_SINK_URL = "https://anchors.example.com/kontrol";
  process.env.KONTROL_ANCHOR_SINK_TOKEN = "sink-token";
  try { await run(puts); } finally {
    setOutboundTransport(null);
    delete process.env.KONTROL_ANCHOR_SINK_URL;
    delete process.env.KONTROL_ANCHOR_SINK_TOKEN;
  }
}

test("without a sink, anchors are taken on schedule but reported as not published", async () => {
  const { runAnchoring, anchorStatus } = await publisher();
  const { setImplementation } = await import("../src/lib/core/compliance-engine");
  await setImplementation(admin, { ucCode: "UC-GOV-01", status: "implemented", maturity: 2, notes: "Attested" });
  const now = Date.UTC(2026, 9, 3, 6, 0, 0);
  const first = await runAnchoring(now);
  assert.deepEqual(first.created, [admin.tenantId]);
  assert.equal(first.configured, false);
  const status = await anchorStatus(admin.tenantId);
  assert.equal(status.sinkConfigured, false);
  assert.equal(status.unpublished, 1);
  assert.match(status.guarantee, /database only/);
});

test("the schedule is once per interval across instances, and starts again when the interval has passed", async () => {
  const { runAnchoring } = await publisher();
  const { setImplementation } = await import("../src/lib/core/compliance-engine");
  const now = Date.UTC(2026, 9, 3, 6, 0, 0);
  await setImplementation(admin, { ucCode: "UC-GOV-02", status: "implemented", maturity: 2, notes: "Attested" });
  assert.deepEqual((await runAnchoring(now + HOUR)).created, [], "a second instance within the interval does nothing");
  assert.deepEqual((await runAnchoring(now + 23 * HOUR)).created, []);
  assert.deepEqual((await runAnchoring(now + 25 * HOUR)).created, [admin.tenantId], "a day later it anchors again");
  process.env.KONTROL_ANCHOR_INTERVAL_HOURS = "0";
  try { assert.deepEqual((await runAnchoring(now + 80 * HOUR)).created, [], "interval 0 turns scheduled anchoring off"); } finally { delete process.env.KONTROL_ANCHOR_INTERVAL_HOURS; }
});

test("pending anchors are written to the sink with the signed anchor and the public key, and are marked published", async () => {
  const { publishPendingAnchors, anchorStatus } = await publisher();
  await withSink(() => 200, async (puts) => {
    const result = await publishPendingAnchors();
    assert.equal(result.configured, true);
    assert.equal(result.published, 2, "the two anchors taken so far");
    assert.equal(result.failed, 0);
    assert.equal(puts.length, 2);
    for (const put of puts) {
      assert.equal(put.method, "PUT");
      assert.match(put.url, new RegExp(`^https://anchors\\.example\\.com/kontrol/${admin.tenantId}/\\d+\\.json$`));
      assert.equal(put.authorization, "Bearer sink-token");
      assert.equal(put.body.kind, "kontrol.audit-anchor");
      assert.match(put.body.anchor.signature, /^ed25519:/);
      assert.match(put.body.publicKey.fingerprint, /^[0-9a-f]{64}$/);
    }
    assert.equal((await anchorStatus(admin.tenantId)).unpublished, 0);
    assert.equal((await publishPendingAnchors()).published, 0, "nothing is sent twice");
  });
});

test("a failed publication is kept with its reason and retried; a write-once store that already has the object counts as published", async () => {
  const { runAnchoring, publishPendingAnchors, anchorStatus } = await publisher();
  const { setImplementation } = await import("../src/lib/core/compliance-engine");
  const sys = (await db()).system();
  await setImplementation(admin, { ucCode: "UC-GOV-03", status: "implemented", maturity: 2, notes: "Attested" });
  const later = Date.UTC(2026, 9, 6, 6, 0, 0);
  await runAnchoring(later);
  await withSink(() => 503, async () => {
    const failed = await publishPendingAnchors();
    assert.equal(failed.failed, 1);
    const row = await sys.get<{ published_at: string | null; publish_error: string }>("SELECT published_at, publish_error FROM audit_anchors WHERE published_at IS NULL");
    assert.equal(row?.published_at, null);
    assert.match(row?.publish_error ?? "", /503/);
    assert.equal((await anchorStatus(admin.tenantId)).unpublished, 1);
  });
  await withSink(() => 412, async (puts) => {
    const retried = await publishPendingAnchors();
    assert.equal(puts.length, 1, "the same anchor is sent again");
    assert.equal(retried.published, 1);
    assert.equal((await anchorStatus(admin.tenantId)).unpublished, 0);
  });
});

test("an unreachable sink is reported, not thrown, and the anchor endpoint shows the publication state", async () => {
  const { setOutboundTransport } = await import("../src/lib/core/net-guard");
  const { publishAnchor, anchorSink } = await publisher();
  const { listAnchors } = await import("../src/lib/core/audit-anchor");
  setOutboundTransport(async () => { throw new Error("connect ECONNREFUSED"); });
  process.env.KONTROL_ANCHOR_SINK_URL = "https://anchors.example.com/kontrol";
  try {
    const [anchor] = await listAnchors(admin.tenantId, 1);
    assert.match((await publishAnchor(anchor, anchorSink())) ?? "", /ECONNREFUSED/);
  } finally { setOutboundTransport(null); delete process.env.KONTROL_ANCHOR_SINK_URL; }
  const { GET } = await import("../src/app/api/audit/anchor/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const token = await issueSessionToken({ ...admin, role: "viewer" });
  const body = (await (await GET(new Request("http://localhost/api/audit/anchor", { headers: { authorization: `Bearer ${token}` } }))).json()) as { publication: { sinkConfigured: boolean; scheduledEveryHours: number; anchors: number } };
  assert.equal(body.publication.sinkConfigured, false);
  assert.equal(body.publication.scheduledEveryHours, 24);
  assert.equal(body.publication.anchors, 3);
});
