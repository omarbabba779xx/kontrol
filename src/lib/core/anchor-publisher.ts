import "server-only";

import { createAnchor, type Anchor } from "@/lib/core/audit-anchor";
import { consumeSharedRateLimit } from "@/lib/core/rate-limit";
import { safeFetch } from "@/lib/core/net-guard";
import { serviceActor } from "@/lib/core/service-actors";
import { publicSigningKey } from "@/lib/core/signing";
import { getDb } from "@/lib/db";

/**
 * Anchors only protect the audit chain if they exist and sit somewhere the database owner cannot rewrite. This takes both steps off the
 * operator:
 *
 *   - every `KONTROL_ANCHOR_INTERVAL_HOURS` (default 24, 0 turns it off) each organisation's chain head is anchored, once across all
 *     instances (the shared limiter is the gate);
 *   - each anchor is written to `KONTROL_ANCHOR_SINK_URL` with an HTTPS PUT (`<sink>/<tenant>/<entries>.json`, bearer
 *     `KONTROL_ANCHOR_SINK_TOKEN`). The sink is what makes it immutable: a gateway to an object store with a retention lock (S3 Object Lock,
 *     a pre-signed upload service), a transparency log, or any append-only service you run. A publication that fails is kept and retried.
 *
 * Without a sink anchors are still taken and stored here, and the status says they are not published: that is a weaker guarantee, and the
 * API reports it as such instead of implying more.
 */
const HOUR = 3_600_000;

export const anchorIntervalHours = () => {
  const value = Number(process.env.KONTROL_ANCHOR_INTERVAL_HOURS ?? 24);
  return Number.isFinite(value) && value >= 0 ? value : 24;
};
export type AnchorSink = { kind: "https"; url: string; token?: string } | { kind: "s3"; bucket: string; prefix: string; retentionDays: number; mode: "COMPLIANCE" | "GOVERNANCE" };

/**
 * Where anchors go. An S3 bucket with Object Lock is written to directly (`KONTROL_ANCHOR_S3_BUCKET`): each anchor is a new object
 * under a retention lock, in COMPLIANCE mode by default, which nobody can shorten or remove, the account root included. Otherwise an
 * HTTPS endpoint (`KONTROL_ANCHOR_SINK_URL`) receives them.
 */
export const anchorSink = (): AnchorSink | null => {
  const bucket = process.env.KONTROL_ANCHOR_S3_BUCKET?.trim();
  if (bucket) {
    const days = Number(process.env.KONTROL_ANCHOR_RETENTION_DAYS ?? 3650);
    return { kind: "s3", bucket, prefix: (process.env.KONTROL_ANCHOR_S3_PREFIX ?? "audit-anchors").replace(/^\/+|\/+$/g, ""), retentionDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : 3650, mode: process.env.KONTROL_ANCHOR_LOCK_MODE === "GOVERNANCE" ? "GOVERNANCE" : "COMPLIANCE" };
  }
  const url = process.env.KONTROL_ANCHOR_SINK_URL?.trim().replace(/\/$/, "");
  return url ? { kind: "https", url, token: process.env.KONTROL_ANCHOR_SINK_TOKEN } : null;
};

type S3Like = { send(command: unknown): Promise<unknown> };
let s3Client: S3Like | null = null;
/** Test seam: replaces the S3 client. Never called by application code. */
export function setAnchorS3Client(client: S3Like | null) { s3Client = client; }

async function putToS3(sink: Extract<AnchorSink, { kind: "s3" }>, anchor: Anchor, body: string): Promise<string | null> {
  const { PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
  const client = s3Client ?? new S3Client({});
  try {
    await client.send(new PutObjectCommand({
      Bucket: sink.bucket,
      Key: `${sink.prefix}/${anchor.tenantId}/${String(anchor.entries).padStart(12, "0")}.json`,
      Body: body,
      ContentType: "application/json",
      // Never replace an anchor that is already there, and hold the new one under a retention lock.
      IfNoneMatch: "*",
      ObjectLockMode: sink.mode,
      ObjectLockRetainUntilDate: new Date(Date.now() + sink.retentionDays * 86_400_000),
    }));
    return null;
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
    // The object already exists: a write-once store refusing a repeat means the anchor is safely there.
    if (name === "PreconditionFailed") return null;
    // A bucket without Object Lock would silently store a deletable copy: say so instead of counting it as published.
    if (name === "InvalidRequest" || name === "InvalidBucketState") return "the bucket does not have Object Lock enabled: anchors written there could be deleted";
    return `S3 ${name || "error"}: ${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`;
  }
}

type Row = { id: string; tenant_id: string; entries: number; head_hash: string; key_fingerprint: string; signature: string; created_at: string };

/** Writes one anchor to the sink. Returns null on success, or the reason it failed. */
export async function publishAnchor(anchor: Anchor, sink = anchorSink()): Promise<string | null> {
  if (!sink) return "no sink configured";
  const body = JSON.stringify({ kind: "kontrol.audit-anchor", anchor, publicKey: await publicSigningKey() });
  if (sink.kind === "s3") return putToS3(sink, anchor, body);
  try {
    const response = await safeFetch(`${sink.url}/${encodeURIComponent(anchor.tenantId)}/${anchor.entries}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(sink.token ? { Authorization: `Bearer ${sink.token}` } : {}) },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    // 409/412 mean the object already exists, which is what a write-once store answers to a repeat: the anchor is there.
    return response.ok || response.status === 409 || response.status === 412 ? null : `sink answered ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : "sink unreachable";
  }
}

/** Publishes anchors that have not reached the sink yet, oldest first. */
export async function publishPendingAnchors(tenantId?: string, limit = 20) {
  const sink = anchorSink();
  if (!sink) return { published: 0, failed: 0, configured: false };
  const db = (await getDb()).system();
  const rows = await db.all<Row>(
    `SELECT id, tenant_id, entries, head_hash, key_fingerprint, signature, created_at FROM audit_anchors WHERE published_at IS NULL ${tenantId ? "AND tenant_id = ?" : ""} ORDER BY created_at LIMIT ?`,
    ...(tenantId ? [tenantId, limit] : [limit]),
  );
  let published = 0, failed = 0;
  for (const row of rows) {
    const anchor: Anchor = { id: row.id, tenantId: row.tenant_id, entries: Number(row.entries), headHash: row.head_hash, keyFingerprint: row.key_fingerprint, createdAt: row.created_at, signature: row.signature };
    const problem = await publishAnchor(anchor, sink);
    if (problem === null) { await db.run("UPDATE audit_anchors SET published_at = ?, publish_error = NULL WHERE id = ?", new Date().toISOString(), row.id); published += 1; }
    else { await db.run("UPDATE audit_anchors SET publish_error = ? WHERE id = ?", problem, row.id); failed += 1; }
  }
  return { published, failed, configured: true };
}

/** Anchors every organisation whose last anchor is older than the interval, then publishes what is pending. Safe to call from every instance. */
export async function runAnchoring(now = Date.now()) {
  const hours = anchorIntervalHours();
  const db = (await getDb()).system();
  const created: string[] = [];
  if (hours > 0) {
    for (const tenant of await db.all<{ id: string }>("SELECT id FROM tenants")) {
      // One instance wins the window per organisation; the others see the gate closed and move on.
      if (!(await consumeSharedRateLimit(`anchor:${tenant.id}`, 1, hours * HOUR, now)).allowed) continue;
      try {
        const result = await createAnchor(await serviceActor(tenant.id, "scheduler"));
        if (result.created) created.push(tenant.id);
      } catch (error) {
        // An empty chain has nothing to anchor yet; anything else is worth a line in the log.
        if (!/nothing in the audit chain/.test(error instanceof Error ? error.message : "")) console.error("anchoring:", error instanceof Error ? error.message : error);
      }
    }
  }
  return { created, ...(await publishPendingAnchors()) };
}

/** What an operator needs to know: is anchoring on, where do anchors go, how many have not arrived. */
export async function anchorStatus(tenantId: string) {
  const db = (await getDb()).scope(tenantId);
  const counts = await db.get<{ total: number | string; pending: number | string; last_at: string | null; last_published_at: string | null }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN published_at IS NULL THEN 1 ELSE 0 END) AS pending, MAX(created_at) AS last_at, MAX(published_at) AS last_published_at FROM audit_anchors WHERE tenant_id = ?",
    tenantId,
  );
  const sink = anchorSink();
  return {
    scheduledEveryHours: anchorIntervalHours() || null,
    sinkConfigured: sink !== null,
    anchors: Number(counts?.total ?? 0),
    unpublished: Number(counts?.pending ?? 0),
    lastAnchoredAt: counts?.last_at ?? null,
    lastPublishedAt: counts?.last_published_at ?? null,
    sink: sink ? (sink.kind === "s3" ? `s3://${sink.bucket}/${sink.prefix} (Object Lock, ${sink.mode}, ${sink.retentionDays} days)` : sink.url) : null,
    guarantee: sink ? (sink.kind === "s3" ? "anchors are written to an S3 bucket under an Object Lock retention" : "anchors are copied to the external sink") : "anchors are kept in the database only: removing them along with the chain would not be detected until a sink is configured",
  };
}
