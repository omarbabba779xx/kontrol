import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { syncPeople } from "@/lib/connectors";
import { safeEqual } from "@/lib/core/config";
import { sha256 } from "@/lib/core/integrity";
import { consumeRateLimit } from "@/lib/core/rate-limit";
import { serviceActor } from "@/lib/core/service-actors";
import { getDb } from "@/lib/db";

/**
 * Signed webhook for systems of record that cannot be polled (HR, learning management).
 *
 *   X-Kontrol-Tenant:    tenant id
 *   X-Kontrol-Timestamp: unix seconds
 *   X-Kontrol-Signature: sha256=<hex HMAC-SHA256(tenantSecret, `${timestamp}.${rawBody}`)>
 *
 * tenantSecret = HMAC-SHA256(KONTROL_INGEST_SECRET, `ingest:${tenantId}`): one master secret, one derived secret per
 * tenant, so a leaked tenant secret cannot be used for another tenant. Each accepted signature is stored and cannot be
 * replayed, across processes, and timestamps outside a five-minute window are refused.
 */
export class IngestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export const TOLERANCE_SECONDS = 300;
export const MAX_BODY_BYTES = 256 * 1024;

export function masterSecret() {
  const value = process.env.KONTROL_INGEST_SECRET;
  return value && value.length >= 32 ? value : null;
}

export function deriveIngestSecret(master: string, tenantId: string) {
  return createHmac("sha256", master).update(`ingest:${tenantId}`).digest("hex");
}

export function signPayload(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifySignature(input: { secret: string; timestamp: string; body: string; signature: string; nowSeconds?: number }) {
  const timestamp = Number(input.timestamp);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > TOLERANCE_SECONDS) return false;
  return safeEqual(signPayload(input.secret, input.timestamp, input.body), input.signature);
}

const asOf = z.string().datetime().refine((value) => {
  const at = Date.parse(value);
  return at <= Date.now() + 5 * 60_000 && at >= Date.now() - 35 * 86_400_000;
}, "asOf must be within the last 35 days and not in the future");

const lms = z.object({ asOf, training: z.object({ enrolled: z.number().int().min(1).max(10_000_000), completed: z.number().int().min(0) }) })
  .refine((value) => value.training.completed <= value.training.enrolled, "completed cannot exceed enrolled")
  .transform((value) => ({ training: { enrolled: value.training.enrolled, completed: value.training.completed, completionRate: value.training.completed / value.training.enrolled, asOf: value.asOf } }));

const hris = z.object({ asOf, hr: z.object({ overdueDeprovisioning: z.number().int().min(0).max(1_000_000), unscreenedActiveStarters: z.number().int().min(0).max(1_000_000) }) })
  .transform((value) => ({ hr: { ...value.hr, asOf: value.asOf } }));

export const SOURCES = { lms, hris } as const;
export type IngestSource = keyof typeof SOURCES;

export async function ingestReport(input: { source: string; tenantId: string; timestamp: string; signature: string; body: string }) {
  const master = masterSecret();
  if (!master) throw new IngestError("Ingest is not configured: set KONTROL_INGEST_SECRET to at least 32 characters", 503);
  if (Buffer.byteLength(input.body) > MAX_BODY_BYTES) throw new IngestError("Payload too large", 413);
  if (!(input.source in SOURCES)) throw new IngestError("Unknown source", 404);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(input.tenantId)) throw new IngestError("Invalid tenant", 400);
  if (!consumeRateLimit(`ingest:${input.tenantId}`, Date.now(), 60).allowed) throw new IngestError("Rate limit exceeded", 429);

  // The same response for an unknown tenant and a wrong signature, so tenant ids cannot be probed.
  const valid = verifySignature({ secret: deriveIngestSecret(master, input.tenantId), timestamp: input.timestamp, body: input.body, signature: input.signature });
  const tenant = valid ? await (await getDb()).system().get("SELECT id FROM tenants WHERE id = ?", input.tenantId) : undefined;
  if (!valid || !tenant) throw new IngestError("Invalid signature", 401);

  const parsed = SOURCES[input.source as IngestSource].safeParse(JSON.parse(input.body));
  if (!parsed.success) throw new IngestError(parsed.error.issues.map((issue) => issue.message).join("; "), 422);

  const received = await (await getDb()).scope(input.tenantId).run("INSERT INTO ingest_receipts (id,tenant_id,source,signature_hash,received_at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id, signature_hash) DO NOTHING", `rcpt_${randomUUID()}`, input.tenantId, input.source, sha256(input.signature), new Date().toISOString());
  if (received.changes === 0) throw new IngestError("This report was already received", 409);

  const result = await syncPeople(await serviceActor(input.tenantId, "ingest"), parsed.data, `${input.source}:ingest`);
  return { evaluations: result.evaluations, skipped: result.skipped };
}
