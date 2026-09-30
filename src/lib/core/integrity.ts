import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";
import { signingSecret } from "@/lib/core/config";
import { getDb } from "@/lib/core/database";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function signDecision(payload: unknown) {
  return createHmac("sha256", signingSecret()).update(canonicalJson(payload)).digest("hex");
}

export function appendAudit(input: { tenantId: string; actorId: string; action: string; objectType: string; objectId: string; payload: unknown }) {
  const db = getDb();
  const previous = db.prepare("SELECT entry_hash FROM audit_log WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1").get(input.tenantId) as { entry_hash: string } | undefined;
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const payloadJson = canonicalJson(input.payload);
  const entryHash = sha256(canonicalJson({ id, ...input, payload: JSON.parse(payloadJson), previousHash: previous?.entry_hash ?? null, createdAt }));
  db.prepare(`INSERT INTO audit_log (id,tenant_id,actor_id,action,object_type,object_id,payload_json,previous_hash,entry_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.tenantId, input.actorId, input.action, input.objectType, input.objectId, payloadJson, previous?.entry_hash ?? null, entryHash, createdAt,
  );
  return { id, entryHash, previousHash: previous?.entry_hash ?? null, createdAt };
}

export function verifyAuditChain(tenantId: string) {
  const entries = getDb().prepare("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY sequence").all(tenantId) as Array<Record<string, unknown>>;
  let previousHash: string | null = null;
  for (const [position, entry] of entries.entries()) {
    if ((entry.previous_hash ?? null) !== previousHash) return { valid: false, checked: position, brokenAt: entry.id };
    const expected = sha256(canonicalJson({
      id: entry.id,
      tenantId: entry.tenant_id,
      actorId: entry.actor_id,
      action: entry.action,
      objectType: entry.object_type,
      objectId: entry.object_id,
      payload: JSON.parse(String(entry.payload_json)),
      previousHash: entry.previous_hash,
      createdAt: entry.created_at,
    }));
    if (expected !== entry.entry_hash) return { valid: false, checked: position, brokenAt: entry.id };
    previousHash = String(entry.entry_hash);
  }
  return { valid: true, checked: entries.length, rootHash: previousHash };
}
