import "server-only";

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Actor } from "@/lib/core/auth";
import { UserError, userError } from "@/lib/core/errors";
import { appendAudit, sha256 } from "@/lib/core/integrity";
import { log } from "@/lib/core/log";
import { openField, sealField, fieldSealedWithCurrentKey } from "@/lib/core/secrets";
import { openBytes, sealBytes } from "@/lib/core/vault-crypto";
import { getDb } from "@/lib/db";

/**
 * The local document vault. Files are encrypted at rest (vault-crypto.ts) and every read verifies the plaintext against the SHA-256
 * recorded at upload, so a document that was altered, swapped or moved is refused, not served. Documents held in S3 are not handled
 * here: they rely on the bucket's own encryption and Object Lock, which the application can neither verify nor override.
 */
const LOCAL = /^local-vault:\/\/([^/]+)\/([^/]+)\/(.+)$/;

export type VaultRow = { id: string; tenant_id: string; name: string; storage_uri: string; content_hash: string; size_bytes: number; status: string; retention_until: string | null };

const root = () => resolve(process.env.KONTROL_VAULT_DIR ?? join(process.cwd(), ".data", "vault"));
export const aadFor = (tenantId: string, documentId: string) => `vault:${tenantId}:${documentId}`;
export const textAad = (tenantId: string, documentId: string) => `vault-text:${tenantId}:${documentId}`;
export const excerptAad = (tenantId: string, documentId: string) => `vault-excerpt:${tenantId}:${documentId}`;

/** The file behind a local-vault URI, or null when the URI is not local, belongs to another tenant, or points outside the vault. */
export function localPath(tenantId: string, storageUri: string) {
  const match = LOCAL.exec(storageUri);
  if (!match || match[1] !== tenantId) return null;
  const file = resolve(root(), match[1], match[2], match[3]);
  return file.startsWith(root() + sep) ? file : null;
}

/** Writes an encrypted file; never overwrites an existing one. Returns the storage URI. */
export function writeLocalDocument(tenantId: string, documentId: string, fileName: string, bytes: Buffer) {
  const folder = join(root(), tenantId, documentId);
  mkdirSync(folder, { recursive: true });
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  writeFileSync(join(folder, safeName), sealBytes(bytes, aadFor(tenantId, documentId)), { flag: "wx" });
  return `local-vault://${tenantId}/${documentId}/${safeName}`;
}

export type Retrieved = { bytes: Buffer; sha256: string; legacy: boolean; needsRekey: boolean };

/** Decrypts and verifies a local document. Throws if it is missing, tampered with, or does not match its recorded hash. */
export function readLocalDocument(row: Pick<VaultRow, "id" | "tenant_id" | "storage_uri" | "content_hash">): Retrieved {
  const path = localPath(row.tenant_id, row.storage_uri);
  if (!path) throw userError("This document is not held in the local vault (not found)");
  if (!existsSync(path)) throw new UserError("The stored file is missing: restore it from a backup", 410);
  // A document that cannot be authenticated or does not match its recorded hash is refused with an explicit integrity error.
  let opened: ReturnType<typeof openBytes>;
  try { opened = openBytes(readFileSync(path), aadFor(row.tenant_id, row.id)); }
  catch (error) { log.error("vault.integrity_failure", { tenantId: row.tenant_id, documentId: row.id, reason: error instanceof Error ? error.message : "unreadable" }); throw new UserError(`Integrity failure: ${error instanceof Error ? error.message : "the document cannot be opened"}`, 409); }
  const hash = sha256(opened.bytes);
  if (hash !== row.content_hash) { log.error("vault.integrity_failure", { tenantId: row.tenant_id, documentId: row.id, reason: "hash mismatch" }); throw new UserError("Integrity failure: the stored document does not match the hash recorded at upload", 409); }
  return { bytes: opened.bytes, sha256: hash, legacy: opened.legacy, needsRekey: opened.needsRekey };
}

/** Reads a document for a user: tenant-scoped lookup, verified content, and a trace of who read it. */
export async function retrieveDocument(actor: Actor, documentId: string) {
  const db = (await getDb()).scope(actor.tenantId);
  const row = await db.get<VaultRow>("SELECT id, tenant_id, name, storage_uri, content_hash, size_bytes, status, retention_until FROM vault_documents WHERE tenant_id = ? AND id = ?", actor.tenantId, documentId);
  if (!row) throw userError("Document not found");
  if (row.status === "deleted") throw userError("This document was deleted at the end of its retention period (not found)");
  const retrieved = readLocalDocument(row);
  await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "vault.document_read", objectType: "vault_document", objectId: row.id, payload: { sha256: retrieved.sha256 } });
  return { name: row.name, ...retrieved };
}

/** Re-encrypts every local document with the current key (and encrypts any written before encryption existed). */
export async function resealDocuments(actor: Actor) {
  const db = (await getDb()).scope(actor.tenantId);
  const text = await resealTextFields(actor);
  const rows = await db.all<VaultRow>("SELECT id, tenant_id, name, storage_uri, content_hash, size_bytes, status, retention_until FROM vault_documents WHERE tenant_id = ? AND status <> 'deleted'", actor.tenantId);
  let resealed = 0, current = 0, skipped = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    const path = localPath(row.tenant_id, row.storage_uri);
    if (!path) { skipped += 1; continue; }
    try {
      const retrieved = readLocalDocument(row);
      if (!retrieved.needsRekey) { current += 1; continue; }
      const temporary = `${path}.rekey`;
      writeFileSync(temporary, sealBytes(retrieved.bytes, aadFor(row.tenant_id, row.id)));
      renameSync(temporary, path);
      resealed += 1;
    } catch (error) { failed.push({ id: row.id, reason: error instanceof Error ? error.message : "unknown error" }); }
  }
  return { resealed, alreadyCurrent: current, notLocal: skipped, failed: [...failed, ...text.failed], textFieldsResealed: text.resealed };
}

/**
 * Deletes a local document once its retention period has ended. The record stays, with its hash and the fact of deletion, so the
 * history remains verifiable; the content and the extracted text are removed. Nothing held under retention can be deleted.
 */
export async function deleteDocument(actor: Actor, input: { id: string; reason: string }) {
  const db = (await getDb()).scope(actor.tenantId);
  const row = await db.get<VaultRow>("SELECT id, tenant_id, name, storage_uri, content_hash, size_bytes, status, retention_until FROM vault_documents WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
  if (!row) throw userError("Document not found");
  if (row.status === "deleted") throw userError("This document is already deleted");
  if (!LOCAL.test(row.storage_uri)) throw userError("This document is held in object storage under retention: delete it through the bucket's own lifecycle rules");
  if (row.retention_until && row.retention_until > new Date().toISOString()) throw userError(`Retention has not ended: this document must be kept until ${row.retention_until.slice(0, 10)}`);
  const inUse = await db.get("SELECT id FROM control_evidence WHERE tenant_id = ? AND vault_document_id = ? AND status IN ('pending','accepted')", actor.tenantId, row.id);
  if (inUse) throw userError("This document is still evidence for a control: retire the evidence first");
  const path = localPath(row.tenant_id, row.storage_uri);
  await db.transaction(async (tx) => {
    await tx.run("UPDATE vault_documents SET status = 'deleted', storage_uri = ?, extracted_text = NULL WHERE tenant_id = ? AND id = ?", `deleted://${row.id}`, actor.tenantId, row.id);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "vault.document_deleted", objectType: "vault_document", objectId: row.id, payload: { sha256: row.content_hash, reason: input.reason, retentionUntil: row.retention_until } }, tx);
  });
  if (path) rmSync(path, { force: true });
  return { id: row.id };
}


/** Seals the extracted text and the excerpt of every document with the current key (and seals those stored before encryption existed). */
async function resealTextFields(actor: Actor) {
  const db = (await getDb()).scope(actor.tenantId);
  const rows = await db.all<{ id: string; extracted_text: string | null; exceptions_json: string | null }>("SELECT id, extracted_text, exceptions_json FROM vault_documents WHERE tenant_id = ?", actor.tenantId);
  let resealed = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  for (const row of rows) {
    try {
      const parts: Array<[string, string | null, string]> = [["extracted_text", row.extracted_text, textAad(actor.tenantId, row.id)], ["exceptions_json", row.exceptions_json, excerptAad(actor.tenantId, row.id)]];
      for (const [column, value, aad] of parts) {
        if (!value || fieldSealedWithCurrentKey(value, aad)) continue;
        await db.run(`UPDATE vault_documents SET ${column} = ? WHERE tenant_id = ? AND id = ?`, sealField(openField(value, aad), aad), actor.tenantId, row.id);
        resealed += 1;
      }
    } catch (error) { failed.push({ id: row.id, reason: error instanceof Error ? error.message : "unknown error" }); }
  }
  return { resealed, failed };
}

/** The text extracted from a document, decrypted for an authorised reader, with a trace of the read. */
export async function retrieveExtractedText(actor: Actor, documentId: string) {
  const db = (await getDb()).scope(actor.tenantId);
  const row = await db.get<{ id: string; extracted_text: string | null; exceptions_json: string | null; status: string }>("SELECT id, extracted_text, exceptions_json, status FROM vault_documents WHERE tenant_id = ? AND id = ?", actor.tenantId, documentId);
  if (!row || row.status === "deleted") throw userError("Document not found");
  const text = row.extracted_text ? openField(row.extracted_text, textAad(actor.tenantId, row.id)) : null;
  const exceptions = row.exceptions_json ? (JSON.parse(openField(row.exceptions_json, excerptAad(actor.tenantId, row.id))) as string[]) : [];
  await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "vault.text_read", objectType: "vault_document", objectId: row.id, payload: {} });
  return { text, exceptions };
}
