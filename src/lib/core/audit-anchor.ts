import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit, signDecision, verifyAuditChain, verifySignature } from "@/lib/core/integrity";
import { publicSigningKey } from "@/lib/core/signing";
import { getDb } from "@/lib/db";

/**
 * The hash chain proves that what is in it was not edited. It cannot show that newer entries, or all of them, were removed: a shorter
 * chain is still a valid chain. An anchor closes that gap. It is a signed statement "this tenant's chain had N entries and this head hash
 * at this time". Once copied somewhere the database owner cannot rewrite (object storage with a retention lock, a transparency log, an
 * auditor's own records), any chain that no longer contains the anchored entry is shown to have been cut back or replaced.
 */
export type Anchor = {
  id?: string;
  tenantId: string;
  entries: number;
  headHash: string;
  keyFingerprint: string;
  createdAt: string;
  signature: string;
};

const payloadOf = (anchor: Omit<Anchor, "signature" | "id">) => ({
  kind: "kontrol.audit-anchor",
  tenantId: anchor.tenantId,
  entries: anchor.entries,
  headHash: anchor.headHash,
  keyFingerprint: anchor.keyFingerprint,
  createdAt: anchor.createdAt,
});

const rowToAnchor = (row: Record<string, unknown>): Anchor => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  entries: Number(row.entries),
  headHash: String(row.head_hash),
  keyFingerprint: String(row.key_fingerprint),
  createdAt: String(row.created_at),
  signature: String(row.signature),
});

export async function createAnchor(actor: Actor) {
  const chain = await verifyAuditChain(actor.tenantId);
  if (!chain.valid) throw userError("The audit chain does not verify; it cannot be anchored");
  if (!chain.checked || !chain.rootHash) throw userError("There is nothing in the audit chain to anchor yet");
  const db = (await getDb()).scope(actor.tenantId);
  const existing = await db.get<Record<string, unknown>>(
    "SELECT * FROM audit_anchors WHERE tenant_id = ? AND entries = ?",
    actor.tenantId,
    chain.checked,
  );
  if (existing) return { anchor: rowToAnchor(existing), created: false, publicKey: await publicSigningKey() };
  const base = {
    tenantId: actor.tenantId,
    entries: chain.checked,
    headHash: chain.rootHash,
    keyFingerprint: (await publicSigningKey()).fingerprint,
    createdAt: new Date().toISOString(),
  };
  const anchor: Anchor = { id: `anchor_${randomUUID()}`, ...base, signature: await signDecision(payloadOf(base)) };
  await db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO audit_anchors (id,tenant_id,entries,head_hash,key_fingerprint,signature,created_at) VALUES (?,?,?,?,?,?,?)",
      anchor.id,
      anchor.tenantId,
      anchor.entries,
      anchor.headHash,
      anchor.keyFingerprint,
      anchor.signature,
      anchor.createdAt,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "audit.anchor",
        objectType: "audit_anchor",
        objectId: anchor.id!,
        payload: { entries: anchor.entries, headHash: anchor.headHash },
      },
      tx,
    );
  });
  return { anchor, created: true, publicKey: await publicSigningKey() };
}

export async function listAnchors(tenantId: string, limit = 100) {
  const rows = await (
    await getDb()
  )
    .scope(tenantId)
    .all<Record<string, unknown>>(
      "SELECT * FROM audit_anchors WHERE tenant_id = ? ORDER BY entries DESC LIMIT ?",
      tenantId,
      Math.min(500, limit),
    );
  return rows.map(rowToAnchor);
}

export type AnchorCheck = { entries: number; createdAt: string; status: "intact" | "chain_shorter" | "head_mismatch" | "bad_signature" };

/**
 * Checks the live chain against anchors: the ones stored here and any the caller holds elsewhere (which are the ones that count against
 * someone with access to the database). `publicKeyPem` verifies signatures as a third party would, without trusting this installation.
 */
export async function verifyAgainstAnchors(tenantId: string, external: Anchor[] = [], publicKeyPem?: string) {
  const chain = await verifyAuditChain(tenantId);
  const db = (await getDb()).scope(tenantId);
  const seen = new Set<string>();
  const anchors = [...(await listAnchors(tenantId, 500)), ...external].filter((anchor) => {
    const key = `${anchor.entries}:${anchor.signature}`;
    if (anchor.tenantId !== tenantId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const checks: AnchorCheck[] = [];
  for (const anchor of anchors) {
    const base = {
      tenantId: anchor.tenantId,
      entries: anchor.entries,
      headHash: anchor.headHash,
      keyFingerprint: anchor.keyFingerprint,
      createdAt: anchor.createdAt,
    };
    let status: AnchorCheck["status"] = "intact";
    if (!(await verifySignature(payloadOf(base), anchor.signature, publicKeyPem))) status = "bad_signature";
    else if (chain.checked < anchor.entries) status = "chain_shorter";
    else {
      const at = await db.get<{ entry_hash: string }>(
        "SELECT entry_hash FROM audit_log WHERE tenant_id = ? ORDER BY sequence LIMIT 1 OFFSET ?",
        tenantId,
        anchor.entries - 1,
      );
      if (at?.entry_hash !== anchor.headHash) status = "head_mismatch";
    }
    checks.push({ entries: anchor.entries, createdAt: anchor.createdAt, status });
  }
  const broken = checks.filter((check) => check.status !== "intact");
  return {
    chain,
    anchored: checks.length,
    checks,
    valid: chain.valid && broken.length === 0,
    problem: broken.length
      ? `${broken.length} anchor(s) do not match the chain: ${[...new Set(broken.map((check) => check.status))].join(", ")}`
      : null,
  };
}
