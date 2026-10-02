import "server-only";

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { Actor } from "@/lib/core/auth";
import { complianceSnapshot, exportStatement } from "@/lib/core/compliance-engine";
import { engagementFor, periodCoverage, recordDownload } from "@/lib/core/audit-workspace";
import { canonicalJson, sha256, signDecision, verifyAuditChain } from "@/lib/core/integrity";
import { buildReadinessReport } from "@/lib/core/report";
import { getDb } from "@/lib/db";

/**
 * The evidence pack an auditor takes away. It is self-verifying: a manifest lists every file with its SHA-256, the tenant's
 * hash-chained audit log is included in full so the auditor can recompute the chain independently, and the manifest carries
 * an HMAC signature. Files that live in S3 object storage are listed with their hashes but not embedded.
 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PACK_BYTES = 120 * 1024 * 1024;
const MAX_AUDIT_ROWS = 100_000;
const MAX_MACHINE_POINTS = 400;

const safeName = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);

function vaultPath(tenantId: string, storageUri: string) {
  const match = /^local-vault:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(storageUri);
  if (!match || match[1] !== tenantId) return null;
  const root = resolve(process.env.KONTROL_VAULT_DIR ?? join(process.cwd(), ".data", "vault"));
  const file = resolve(root, match[1], match[2], match[3]);
  return file.startsWith(root + sep) ? file : null; // never read outside the vault
}

const README = `KONTROL EVIDENCE PACK

Verify this pack:
  1. Each file's SHA-256 is listed in manifest.json (files[].sha256).
  2. manifest.json is signed: "signature" is HMAC-SHA-256 over the canonical manifest without the signature field,
     with the platform signing key. Ask the organisation to confirm it, or compare "manifestFingerprint" with the value
     recorded in their audit log (action audit.pack_downloaded).
  3. audit-log.json contains the complete tenant audit chain. Each entry's entry_hash is
     SHA-256 over {id, tenantId, actorId, action, objectType, objectId, payload, previousHash, createdAt} (canonical JSON, keys sorted)
     and previous_hash must equal the preceding entry_hash. manifest.auditChain gives the root hash and entry count.

Machine evidence (controls/*.json) lists the population of automated evaluations during the period with their stored facts,
status and content hash, so samples can be drawn independently. period-coverage.csv shows, per control, the days of the period with
healthy evidence, failing evidence, and no evidence.
`;

const csv = (rows: unknown[][]) => rows.map((row) => row.map((cell) => { let text = cell === null || cell === undefined ? "" : String(cell); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }).join(",")).join("\n");

export async function buildEvidencePack(actor: Actor, engagementId: string) {
  const engagement = await engagementFor(actor, engagementId);
  const db = (await getDb()).scope(actor.tenantId);
  const files = new Map<string, Uint8Array>();
  const notes: string[] = [];
  let total = 0;
  const add = (path: string, data: Uint8Array | string) => {
    const bytes = typeof data === "string" ? strToU8(data) : data;
    if (total + bytes.length > MAX_PACK_BYTES) { notes.push(`${path} omitted: pack size limit reached`); return; }
    total += bytes.length;
    files.set(path, bytes);
  };

  // Compliance posture for the framework in scope.
  const statement = await exportStatement(actor.tenantId, engagement.framework_id);
  add(`compliance/soa-${engagement.framework_id}.csv`, statement.csv);
  add(`compliance/soa-${engagement.framework_id}.json`, JSON.stringify(statement.json, null, 2));
  const report = await buildReadinessReport(actor, { frameworkId: engagement.framework_id }).catch(() => null);
  if (report) add("compliance/readiness-report.pdf", report.bytes); else notes.push("readiness-report.pdf omitted: the framework is not adopted by this organisation");

  // Per-control evidence: attestation, linked executable controls, documents, and the machine-evidence population in the period.
  const snapshot = await complianceSnapshot(actor.tenantId);
  const from = engagement.period_start, to = engagement.period_end;
  const documents = await db.all<{ id: string; uc_code: string; title: string; kind: string; vault_document_id: string | null; content_hash: string; valid_until: string; uploaded_by: string; reviewed_by: string | null; reviewed_at: string | null; status: string }>("SELECT id, uc_code, title, kind, vault_document_id, content_hash, valid_until, uploaded_by, reviewed_by, reviewed_at, status FROM control_evidence WHERE tenant_id = ? AND status = 'accepted'", actor.tenantId);
  for (const control of snapshot.controls.filter((item) => item.status !== "not_started")) {
    const codes = (control.linkedControlCode ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    const machine: unknown[] = [];
    for (const code of codes) {
      const rows = await db.all<{ id: string; collected_at: string; status: string; source: string; content_hash: string; content_json: string }>("SELECT e.id, e.collected_at, e.status, e.source, e.content_hash, e.content_json FROM evidence e JOIN controls c ON c.id = e.control_id WHERE e.tenant_id = ? AND c.code = ? AND e.collected_at >= ? AND e.collected_at <= ? ORDER BY e.collected_at LIMIT ?", actor.tenantId, code, from, to, MAX_MACHINE_POINTS);
      machine.push({ control: code, evaluations: rows.map((row) => ({ id: row.id, collectedAt: row.collected_at, status: row.status, source: row.source, sha256: row.content_hash, content: JSON.parse(row.content_json) as unknown })) });
    }
    const docs = documents.filter((item) => item.uc_code === control.code);
    add(`controls/${control.code}.json`, JSON.stringify({ code: control.code, title: control.title, domain: control.domainLabel, status: control.status, maturity: control.maturity, attestedBy: control.attestedBy, attestedAt: control.attestedAt, countersignedBy: control.countersignedBy, reviewDue: control.reviewDue, verification: control.verification, linkedControls: codes, documentaryEvidence: docs.map((doc) => ({ id: doc.id, title: doc.title, kind: doc.kind, sha256: doc.content_hash, validUntil: doc.valid_until, uploadedBy: doc.uploaded_by, reviewedBy: doc.reviewed_by, reviewedAt: doc.reviewed_at })), machineEvidence: machine }, null, 2));
    for (const doc of docs) {
      if (!doc.vault_document_id) continue;
      const row = await db.get<{ name: string; storage_uri: string; size_bytes: number }>("SELECT name, storage_uri, size_bytes FROM vault_documents WHERE tenant_id = ? AND id = ?", actor.tenantId, doc.vault_document_id);
      const path = row ? vaultPath(actor.tenantId, row.storage_uri) : null;
      if (!row || !path || !existsSync(path) || statSync(path).size > MAX_FILE_BYTES) { notes.push(`${doc.title}: file not embedded (${row?.storage_uri.startsWith("s3://") ? "stored in S3 object storage" : "unavailable or too large"}); its SHA-256 is ${doc.content_hash}`); continue; }
      const bytes = readFileSync(path);
      if (sha256(bytes) !== doc.content_hash) { notes.push(`${doc.title}: file on disk does not match its recorded hash and was not embedded`); continue; }
      add(`evidence/${control.code}/${safeName(doc.id)}-${safeName(row.name)}`, bytes);
    }
  }

  // Operating effectiveness over the period.
  const coverage = await periodCoverage(actor.tenantId, engagement);
  add("period-coverage.csv", csv([["unified_control", "executable_control", "evaluations_in_period", "failures", "healthy_days", "failing_days", "days_without_evidence", "longest_gap_days"], ...coverage.controls.flatMap((item) => item.controls.map((control) => [item.ucCode, control.code, control.points, control.failures, control.healthyDays, control.failingDays, control.gapDays, control.longestGapDays]))]));

  // Requests and the conversation.
  const requests = await db.all<Record<string, unknown>>("SELECT ref, title, description, uc_code, status, due_at, created_at, resolved_at FROM audit_requests WHERE tenant_id = ? AND engagement_id = ? ORDER BY ref", actor.tenantId, engagement.id);
  const events = await db.all<Record<string, unknown>>("SELECT request_id, kind, author_id, body, reference_json, created_at FROM audit_events WHERE tenant_id = ? AND engagement_id = ? ORDER BY created_at", actor.tenantId, engagement.id);
  add("requests.json", JSON.stringify({ requests, events }, null, 2));

  // The audit chain, complete, so that it can be verified without trusting us.
  const chain = await verifyAuditChain(actor.tenantId);
  const rows = await db.all<Record<string, unknown>>("SELECT id, tenant_id, actor_id, action, object_type, object_id, payload_json, previous_hash, entry_hash, created_at FROM audit_log WHERE tenant_id = ? ORDER BY sequence LIMIT ?", actor.tenantId, MAX_AUDIT_ROWS);
  add("audit-log.json", JSON.stringify(rows));
  add("README.txt", README);

  const generatedAt = new Date().toISOString();
  const fileList = [...files.entries()].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(Buffer.from(bytes)) })).sort((a, b) => a.path.localeCompare(b.path));
  const body = {
    engagement: { id: engagement.id, name: engagement.name, framework: engagement.framework_id, kind: engagement.kind, periodStart: engagement.period_start, periodEnd: engagement.period_end, status: engagement.status },
    generatedAt,
    generatedBy: actor.name,
    auditChain: chain.valid ? { valid: true, entries: chain.checked, rootHash: chain.rootHash, included: rows.length } : { valid: false, brokenAt: chain.brokenAt },
    files: fileList,
    notes,
  };
  const manifestFingerprint = sha256(canonicalJson(body));
  const manifest = { ...body, manifestFingerprint, signature: signDecision({ manifestFingerprint, tenant: actor.tenantId, generatedAt }) };
  add("manifest.json", JSON.stringify(manifest, null, 2));

  await recordDownload(actor, engagement.id, manifestFingerprint);
  const zip = zipSync(Object.fromEntries(files), { level: 6 });
  return { bytes: zip, manifest, filename: `${safeName(engagement.name)}-evidence-pack.zip` };
}
