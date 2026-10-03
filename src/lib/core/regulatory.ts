import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/db";
import { appendAudit, sha256 } from "@/lib/core/integrity";

type RegulatoryInput = {
  framework: string;
  citation: string;
  title: string;
  text: string;
  sourceUrl: string;
  effectiveFrom?: string;
  supersedesId?: string;
};

const trustedHosts = new Set([
  "eur-lex.europa.eu",
  "digital-strategy.ec.europa.eu",
  "ai-act-service-desk.ec.europa.eu",
  "nist.gov",
  "www.nist.gov",
  "csrc.nist.gov",
  "pages.nist.gov",
  "enisa.europa.eu",
  "www.enisa.europa.eu",
  "iso.org",
  "www.iso.org",
]);

function tokenize(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9à-ÿ]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 3),
  );
}

function diffText(previous: string, current: string) {
  const before = tokenize(previous);
  const after = tokenize(current);
  return {
    added: [...after].filter((word) => !before.has(word)),
    removed: [...before].filter((word) => !after.has(word)),
    similarity: Number(
      ([...after].filter((word) => before.has(word)).length / Math.max(1, new Set([...before, ...after]).size)).toFixed(3),
    ),
  };
}

export async function ingestRegulation(actor: Actor, input: RegulatoryInput) {
  const host = new URL(input.sourceUrl).hostname.toLowerCase();
  if (!trustedHosts.has(host)) throw new Error(`Source host ${host} is not approved`);
  const db = (await getDb()).scope(actor.tenantId);
  const now = new Date().toISOString();
  const previous = input.supersedesId
    ? await db.get<{ id: string; text: string }>(
        "SELECT * FROM obligations WHERE tenant_id = ? AND id = ?",
        actor.tenantId,
        input.supersedesId,
      )
    : await db.get<{ id: string; text: string }>(
        "SELECT * FROM obligations WHERE tenant_id = ? AND framework = ? AND citation = ? ORDER BY recorded_at DESC LIMIT 1",
        actor.tenantId,
        input.framework,
        input.citation,
      );
  const id = `obligation_${randomUUID()}`;
  const versionHash = sha256(input.text);
  const diff = diffText(previous?.text ?? "", input.text);
  const duplicate = await db.get<{ id: string }>(
    "SELECT id FROM obligations WHERE tenant_id = ? AND version_hash = ?",
    actor.tenantId,
    versionHash,
  );
  if (duplicate) return { id: duplicate.id, duplicate: true, diff };

  const controls = await db.all<{ id: string; code: string; title: string; objective: string }>(
    "SELECT id, code, title, objective FROM controls WHERE tenant_id = ? AND valid_to IS NULL",
    actor.tenantId,
  );
  const inputTerms = tokenize(`${input.title} ${input.text}`);
  const mappings = controls
    .map((control) => {
      const terms = tokenize(`${control.title} ${control.objective}`);
      const overlap = [...terms].filter((term) => inputTerms.has(term));
      return { control, overlap, confidence: Math.min(0.95, 0.45 + overlap.length * 0.08) };
    })
    .filter((mapping) => mapping.overlap.length > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);

  await db.transaction(async (tx) => {
    if (previous)
      await tx.run("UPDATE obligations SET effective_to = ? WHERE id = ?", input.effectiveFrom ?? now.slice(0, 10), previous.id);
    await tx.run(
      `INSERT INTO obligations (id,tenant_id,framework,citation,title,text,source_url,effective_from,version_hash,confidence,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      actor.tenantId,
      input.framework,
      input.citation,
      input.title,
      input.text,
      input.sourceUrl,
      input.effectiveFrom ?? null,
      versionHash,
      1,
      now,
    );
    for (const mapping of mappings)
      await tx.run(
        `INSERT INTO graph_edges (id,tenant_id,source_type,source_id,relation,target_type,target_id,confidence,rationale,source_ref,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        actor.tenantId,
        "obligation",
        id,
        "candidate_mapping",
        "control",
        mapping.control.id,
        mapping.confidence,
        `Keyword overlap: ${mapping.overlap.join(", ")}. Human approval required.`,
        input.sourceUrl,
        now,
        now,
      );
  });
  await appendAudit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "regulation.ingested",
    objectType: "obligation",
    objectId: id,
    payload: {
      sourceUrl: input.sourceUrl,
      versionHash,
      diff,
      candidateMappings: mappings.map((mapping) => ({ control: mapping.control.code, confidence: mapping.confidence })),
    },
  });
  return {
    id,
    duplicate: false,
    diff,
    candidateMappings: mappings.map((mapping) => ({
      controlId: mapping.control.id,
      code: mapping.control.code,
      confidence: mapping.confidence,
      rationale: mapping.overlap,
    })),
  };
}

export async function getRegulatoryImpact(tenantId: string, obligationId: string) {
  const db = (await getDb()).scope(tenantId);
  const obligation = await db.get("SELECT * FROM obligations WHERE tenant_id = ? AND id = ?", tenantId, obligationId);
  const edges = await db.all(
    "SELECT * FROM graph_edges WHERE tenant_id = ? AND source_type = 'obligation' AND source_id = ? AND valid_to IS NULL ORDER BY confidence DESC",
    tenantId,
    obligationId,
  );
  return { obligation, edges };
}
