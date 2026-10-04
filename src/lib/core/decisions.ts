import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/db";
import { appendAudit, canonicalJson, sha256, signDecision, verifySignature } from "@/lib/core/integrity";

export async function recordDecision(
  actor: Actor,
  input: { subjectType: string; subjectId: string; outcome: string; conditions: string[]; rationale: string; evidenceIds: string[] },
) {
  const db = (await getDb()).scope(actor.tenantId);
  const evidence = input.evidenceIds.length
    ? await db.all<Record<string, unknown>>(
        `SELECT id, name, content_hash, collected_at, status FROM evidence WHERE tenant_id = ? AND id IN (${input.evidenceIds.map(() => "?").join(",")})`,
        actor.tenantId,
        ...input.evidenceIds,
      )
    : [];
  if (evidence.length !== input.evidenceIds.length) throw new Error("One or more evidence objects are missing or belong to another tenant");
  const decidedAt = new Date().toISOString();
  const id = `decision_${randomUUID()}`;
  const manifest = { generatedAt: decidedAt, count: evidence.length, evidence, rootHash: sha256(canonicalJson(evidence)) };
  const decisionPayload = { id, tenantId: actor.tenantId, ...input, evidenceManifest: manifest, decidedBy: actor.userId, decidedAt };
  const signature = await signDecision(decisionPayload);
  const audit = await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO decisions (id,tenant_id,subject_type,subject_id,outcome,conditions_json,rationale,evidence_manifest_json,decided_by,decided_at,signature) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      actor.tenantId,
      input.subjectType,
      input.subjectId,
      input.outcome,
      JSON.stringify(input.conditions),
      input.rationale,
      JSON.stringify(manifest),
      actor.userId,
      decidedAt,
      signature,
    );
    return appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "decision.recorded",
        objectType: "decision",
        objectId: id,
        payload: { ...decisionPayload, signature },
      },
      tx,
    );
  });
  return { id, signature, manifest, audit, decidedAt };
}

export async function verifyDecision(tenantId: string, decisionId: string) {
  const row = await (
    await getDb()
  )
    .scope(tenantId)
    .get<Record<string, unknown>>("SELECT * FROM decisions WHERE tenant_id = ? AND id = ?", tenantId, decisionId);
  if (!row) return { valid: false, reason: "not_found" };
  const payload = {
    id: row.id,
    tenantId: row.tenant_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    outcome: row.outcome,
    conditions: JSON.parse(String(row.conditions_json)),
    rationale: row.rationale,
    evidenceIds: (JSON.parse(String(row.evidence_manifest_json)) as { evidence: Array<{ id: string }> }).evidence.map((item) => item.id),
    evidenceManifest: JSON.parse(String(row.evidence_manifest_json)),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
  return { valid: await verifySignature(payload, String(row.signature)), signature: row.signature, decision: row };
}
