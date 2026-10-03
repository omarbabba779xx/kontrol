import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
const vaultDir = mkdtempSync(join(tmpdir(), "kontrol-vault-test-"));
const OLD_KEY = "o".repeat(40), NEW_KEY = "n".repeat(40);
setEnv({ KONTROL_VAULT_DIR: vaultDir, KONTROL_SECRETS_KEY: OLD_KEY, KONTROL_SECRETS_KEY_PREVIOUS: undefined, S3_BUCKET: undefined, S3_ENDPOINT: undefined });

const engine = () => import("../src/lib/core/enterprise-engine");
const store = () => import("../src/lib/core/vault-store");
const db = async () => (await import("../src/lib/db")).getDb();
const SECRET_TEXT = "Penetration test report: the administrator password is hunter2-in-the-clear";
const upload = async (name = "report.txt", text = SECRET_TEXT) => (await engine()).storeVaultDocument(admin, new File([text], name, { type: "text/plain" }), "report");
const rowOf = async (id: string) => (await (await db()).scope(admin.tenantId).get<{ id: string; tenant_id: string; storage_uri: string; content_hash: string }>("SELECT id, tenant_id, storage_uri, content_hash FROM vault_documents WHERE id = ?", id))!;

let docId = "";
test("documents are encrypted at rest and come back identical, verified against the recorded hash", async () => {
  const { localPath, retrieveDocument } = await store();
  const stored = await upload();
  docId = stored.id;
  const path = localPath(admin.tenantId, (await rowOf(docId)).storage_uri)!;
  const onDisk = readFileSync(path);
  assert.equal(onDisk.subarray(0, 5).toString(), "KVLT1");
  assert.ok(!onDisk.includes(Buffer.from("hunter2")), "the plaintext is not on disk");
  const back = await retrieveDocument(admin, docId);
  assert.equal(back.bytes.toString(), SECRET_TEXT);
  assert.equal(back.sha256, stored.hash);
  assert.equal(back.legacy, false);
});

test("a tampered file, a file moved to another document, and a forged file are all refused", async () => {
  const { localPath, retrieveDocument } = await store();
  const path = localPath(admin.tenantId, (await rowOf(docId)).storage_uri)!;
  const original = readFileSync(path);

  const flipped = Buffer.from(original);
  flipped[flipped.length - 1] ^= 0xff;
  writeFileSync(path, flipped);
  await assert.rejects(retrieveDocument(admin, docId), (error: Error & { status?: number }) => /Integrity failure/.test(error.message) && error.status === 409);
  writeFileSync(path, original);

  // The same ciphertext placed under another document id does not open: the document id is authenticated.
  const other = await upload("other.txt", "another document");
  const otherPath = localPath(admin.tenantId, (await rowOf(other.id)).storage_uri)!;
  const backup = readFileSync(otherPath);
  writeFileSync(otherPath, original);
  await assert.rejects(retrieveDocument(admin, other.id), /Integrity failure/);
  writeFileSync(otherPath, backup);
  assert.equal((await retrieveDocument(admin, other.id)).bytes.toString(), "another document");

  // A plaintext substitution is caught by the recorded hash.
  writeFileSync(path, "forged content");
  await assert.rejects(retrieveDocument(admin, docId), /Integrity failure/);
  writeFileSync(path, original);
  assert.equal((await retrieveDocument(admin, docId)).bytes.toString(), SECRET_TEXT);
});

test("another tenant cannot retrieve the document", async () => {
  const { retrieveDocument } = await store();
  await assert.rejects(retrieveDocument({ ...admin, tenantId: "tenant_other" }, docId), (error: Error & { status?: number }) => error.status === 404);
});

test("a file written before encryption existed is still readable, and rotation encrypts it", async () => {
  const { localPath, retrieveDocument, resealDocuments, readLocalDocument } = await store();
  const legacy = await upload("legacy.txt", "legacy plaintext document");
  const path = localPath(admin.tenantId, (await rowOf(legacy.id)).storage_uri)!;
  writeFileSync(path, "legacy plaintext document");
  assert.equal((await retrieveDocument(admin, legacy.id)).legacy, true);
  const result = await resealDocuments(admin);
  assert.ok(result.resealed >= 1 && result.failed.length === 0);
  assert.equal(readFileSync(path).subarray(0, 5).toString(), "KVLT1");
  assert.equal(readLocalDocument(await rowOf(legacy.id)).legacy, false);
  assert.equal((await resealDocuments(admin)).resealed, 0, "nothing left to do the second time");
});

test("rotating the secrets key keeps documents and credentials readable, and re-seals them", async () => {
  const { retrieveDocument, readLocalDocument } = await store();
  const { saveCredentials, loadCredentials } = await import("../src/lib/core/credentials");
  const { rotateSecretKeys } = await import("../src/lib/core/key-rotation");
  await saveCredentials(admin, "github", { token: "github_pat_" + "A".repeat(30) });

  // 1. new key, old one kept as previous: everything still opens.
  process.env.KONTROL_SECRETS_KEY = NEW_KEY;
  process.env.KONTROL_SECRETS_KEY_PREVIOUS = OLD_KEY;
  const before = await retrieveDocument(admin, docId);
  assert.equal(before.bytes.toString(), SECRET_TEXT);
  assert.equal(before.needsRekey, true);
  assert.ok((await loadCredentials(admin.tenantId, "github"))?.token.startsWith("github_pat_"));

  // 2. rotate: re-sealed under the new key.
  const rotated = await rotateSecretKeys(admin);
  assert.equal(rotated.complete, true);
  assert.equal(rotated.credentials.resealed, 1);
  assert.ok(rotated.documents.resealed >= 2);
  assert.equal((await retrieveDocument(admin, docId)).needsRekey, false);

  // 3. the old key is no longer needed.
  delete process.env.KONTROL_SECRETS_KEY_PREVIOUS;
  assert.equal((await retrieveDocument(admin, docId)).bytes.toString(), SECRET_TEXT);
  assert.ok((await loadCredentials(admin.tenantId, "github"))?.token.startsWith("github_pat_"));
  assert.equal((await rotateSecretKeys(admin)).credentials.resealed, 0);

  // A key that was never configured opens nothing, and says why.
  process.env.KONTROL_SECRETS_KEY = "x".repeat(40);
  await assert.rejects(retrieveDocument(admin, docId), /not configured/);
  await assert.rejects(loadCredentials(admin.tenantId, "github"), /cannot be decrypted/);
  process.env.KONTROL_SECRETS_KEY = NEW_KEY;
  assert.equal(readLocalDocument(await rowOf(docId)).bytes.toString(), SECRET_TEXT);
});

test("a document is deleted only after its retention period, never while it is evidence, and leaves its hash behind", async () => {
  const { deleteDocument, retrieveDocument, localPath } = await store();
  const victim = await upload("old-report.txt", "obsolete report");
  await assert.rejects(deleteDocument(admin, { id: victim.id, reason: "No longer needed here" }), /Retention has not ended/);
  const sys = (await db()).system();
  await sys.run("UPDATE vault_documents SET retention_until = ? WHERE id = ?", new Date(Date.now() - 86_400_000).toISOString(), victim.id);
  await sys.run("INSERT INTO control_evidence (id,tenant_id,uc_code,title,kind,vault_document_id,content_hash,valid_until,uploaded_by,uploaded_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "ev_test", admin.tenantId, "UC-GOV-01", "Policy", "document", victim.id, victim.hash, new Date(Date.now() + 86_400_000).toISOString(), admin.userId, new Date().toISOString(), "accepted");
  await assert.rejects(deleteDocument(admin, { id: victim.id, reason: "Trying to delete evidence" }), /still evidence/);
  await sys.run("UPDATE control_evidence SET status = 'rejected' WHERE id = ?", "ev_test");
  const path = localPath(admin.tenantId, (await rowOf(victim.id)).storage_uri)!;
  assert.ok(existsSync(path));
  await deleteDocument(admin, { id: victim.id, reason: "Retention ended and the report is superseded" });
  assert.equal(existsSync(path), false);
  const row = await sys.get<{ status: string; content_hash: string; extracted_text: string | null }>("SELECT status, content_hash, extracted_text FROM vault_documents WHERE id = ?", victim.id);
  assert.deepEqual([row?.status, row?.content_hash, row?.extracted_text], ["deleted", victim.hash, null]);
  await assert.rejects(retrieveDocument(admin, victim.id), /deleted/);
  await assert.rejects(deleteDocument(admin, { id: victim.id, reason: "Deleting it a second time" }), /already deleted/);
});

test("the download route serves verified bytes with their hash, and only to people who may read evidence", async () => {
  const { GET } = await import("../src/app/api/vault/documents/[id]/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const call = async (role: "viewer" | "admin", id: string) => GET(new Request("http://localhost/x", { headers: { authorization: `Bearer ${await issueSessionToken({ ...admin, role })}` } }), { params: Promise.resolve({ id }) });
  const ok = await call("viewer", docId);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), SECRET_TEXT);
  assert.match(ok.headers.get("x-content-sha256") ?? "", /^[0-9a-f]{64}$/);
  assert.equal((await call("admin", "vault_nope")).status, 404);
});

test("text extracted from a document is encrypted in the database, readable by an authorised reader, and sealed again on rotation", async () => {
  const { retrieveExtractedText, resealDocuments } = await store();
  const secret = "Audit finding: qualified opinion because the production database password is in the wiki";
  const stored = await upload("finding.txt", secret);
  const sys = (await db()).system();
  const raw = await sys.get<{ extracted_text: string; exceptions_json: string }>("SELECT extracted_text, exceptions_json FROM vault_documents WHERE id = ?", stored.id);
  assert.match(raw!.extracted_text, /^enc1:/);
  assert.match(raw!.exceptions_json, /^enc1:/);
  assert.ok(!raw!.extracted_text.includes("password") && !raw!.exceptions_json.includes("qualified"), "neither column holds readable text");

  const read = await retrieveExtractedText(admin, stored.id);
  assert.equal(read.text, secret);
  assert.deepEqual(read.exceptions, [secret]);
  await assert.rejects(retrieveExtractedText({ ...admin, tenantId: "tenant_other" }, stored.id), /not found/);

  // A value moved to another document does not open: the row is part of what is authenticated.
  const other = await upload("other-finding.txt", "something else entirely");
  await sys.run("UPDATE vault_documents SET extracted_text = ? WHERE id = ?", raw!.extracted_text, other.id);
  await assert.rejects(retrieveExtractedText(admin, other.id));

  // Rows written before this encryption existed are plaintext: still readable, sealed by rotation.
  await sys.run("UPDATE vault_documents SET extracted_text = ?, exceptions_json = ? WHERE id = ?", "legacy plaintext", JSON.stringify(["legacy line"]), other.id);
  assert.equal((await retrieveExtractedText(admin, other.id)).text, "legacy plaintext");
  const result = await resealDocuments(admin);
  assert.ok(result.textFieldsResealed >= 2 && result.failed.length === 0);
  const after = await sys.get<{ extracted_text: string }>("SELECT extracted_text FROM vault_documents WHERE id = ?", other.id);
  assert.match(after!.extracted_text, /^enc1:/);
  assert.equal((await retrieveExtractedText(admin, other.id)).text, "legacy plaintext");
  assert.equal((await resealDocuments(admin)).textFieldsResealed, 0, "nothing left to seal");
});
