import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { legacyHmac, signBytes, verifyBytes } from "@/lib/core/signing";
import { getDb, type Executor } from "@/lib/db";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const record = value as Record<string, unknown>;
  // Like JSON.stringify, leave out keys whose value is undefined: they have no JSON form and would corrupt the payload.
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

/** Signs the canonical form of a payload with the Ed25519 key. Third parties verify it with the public key alone. */
export function signDecision(payload: unknown) {
  return signBytes(canonicalJson(payload));
}

/** Verifies a signature made by `signDecision`, or by the earlier HMAC form. Pass a public key (PEM) to verify as a third party would. */
export function verifySignature(payload: unknown, signature: string, publicKeyPem?: string) {
  const message = canonicalJson(payload);
  if (signature.startsWith("ed25519:")) return verifyBytes(message, signature, publicKeyPem);
  if (publicKeyPem) return false;
  const expected = Buffer.from(legacyHmac(message)),
    given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

type AuditInput = { tenantId: string; actorId: string; action: string; objectType: string; objectId: string; payload: unknown };

async function appendWithin(tx: Executor, input: AuditInput) {
  // Serialise writers per tenant so the hash chain can never fork (unique indexes are the backstop).
  if (tx.dialect === "postgres") await tx.get("SELECT pg_advisory_xact_lock(hashtext(?))", input.tenantId);
  const previous = await tx.get<{ entry_hash: string }>(
    "SELECT entry_hash FROM audit_log WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1",
    input.tenantId,
  );
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const payloadJson = canonicalJson(input.payload);
  const entryHash = sha256(
    canonicalJson({ id, ...input, payload: JSON.parse(payloadJson), previousHash: previous?.entry_hash ?? null, createdAt }),
  );
  await tx.run(
    `INSERT INTO audit_log (id,tenant_id,actor_id,action,object_type,object_id,payload_json,previous_hash,entry_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.tenantId,
    input.actorId,
    input.action,
    input.objectType,
    input.objectId,
    payloadJson,
    previous?.entry_hash ?? null,
    entryHash,
    createdAt,
  );
  return { id, entryHash, previousHash: previous?.entry_hash ?? null, createdAt };
}

/** Appends to the tenant's audit chain. Pass `tx` to make the entry atomic with the caller's own writes. */
export async function appendAudit(input: AuditInput, tx?: Executor) {
  if (tx) return appendWithin(tx, input);
  const scope = (await getDb()).scope(input.tenantId);
  return scope.transaction((inner) => appendWithin(inner, input));
}

/** Pure verification of an ordered list of audit rows (used by the API, the migration tool and tests). */
export function verifyAuditChainRows(entries: Array<Record<string, unknown>>) {
  let previousHash: string | null = null;
  for (const [position, entry] of entries.entries()) {
    if ((entry.previous_hash ?? null) !== previousHash) return { valid: false as const, checked: position, brokenAt: String(entry.id) };
    const expected = sha256(
      canonicalJson({
        id: entry.id,
        tenantId: entry.tenant_id,
        actorId: entry.actor_id,
        action: entry.action,
        objectType: entry.object_type,
        objectId: entry.object_id,
        payload: JSON.parse(String(entry.payload_json)),
        previousHash: entry.previous_hash,
        createdAt: entry.created_at,
      }),
    );
    if (expected !== entry.entry_hash) return { valid: false as const, checked: position, brokenAt: String(entry.id) };
    previousHash = String(entry.entry_hash);
  }
  return { valid: true as const, checked: entries.length, rootHash: previousHash };
}

export async function verifyAuditChain(tenantId: string) {
  const entries = await (
    await getDb()
  )
    .scope(tenantId)
    .all<Record<string, unknown>>("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY sequence", tenantId);
  return verifyAuditChainRows(entries);
}
