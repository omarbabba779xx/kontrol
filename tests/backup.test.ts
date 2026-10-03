import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

const dir = isolateDatabase();
const vaultDir = mkdtempSync(join(tmpdir(), "kontrol-backup-vault-"));
const work = mkdtempSync(join(tmpdir(), "kontrol-backup-work-"));
const KEY = "b".repeat(40);
setEnv({ KONTROL_VAULT_DIR: vaultDir, KONTROL_SECRETS_KEY: KEY, KONTROL_SECRETS_KEY_PREVIOUS: undefined, S3_BUCKET: undefined, S3_ENDPOINT: undefined });

const backupLib = () => import("../src/lib/ops/backup");
const TEXT = "Signed statement of applicability, version 3";
let documentId = "";
let documentHash = "";

test("a backup of a live system is consistent and verifiable", { skip: process.env.KONTROL_TEST_DB === "postgres" && "the backup tool covers the SQLite profile" }, async () => {
  const { storeVaultDocument } = await import("../src/lib/core/enterprise-engine");
  const { saveCredentials } = await import("../src/lib/core/credentials");
  const stored = await storeVaultDocument(admin, new File([TEXT], "soa.txt", { type: "text/plain" }), "policy");
  documentId = stored.id; documentHash = stored.hash;
  await saveCredentials(admin, "github", { token: "github_pat_" + "B".repeat(30) });

  const { createBackup, verifyBackup } = await backupLib();
  const target = join(work, "backup-1");
  const manifest = await createBackup({ databasePath: join(dir, "kontrol.db"), vaultDir, targetDir: target });
  assert.ok(manifest.vault.length >= 1);
  assert.ok(manifest.audit.some((item) => item.tenantId === admin.tenantId && item.entries > 0 && item.rootHash));
  assert.deepEqual(verifyBackup(target), { ok: true, problems: [], manifest });
  await assert.rejects(createBackup({ databasePath: join(dir, "kontrol.db"), vaultDir, targetDir: target }), /not empty/);
});

test("a restored backup has an intact audit chain, readable documents and usable credentials, and needs the original key", { skip: process.env.KONTROL_TEST_DB === "postgres" && "SQLite profile only" }, async () => {
  const { restoreBackup } = await backupLib();
  const { verifyAuditChainRows } = await import("../src/lib/core/integrity");
  const restoredDb = join(work, "restored", "kontrol.db"), restoredVault = join(work, "restored", "vault");
  restoreBackup({ backupDir: join(work, "backup-1"), databasePath: restoredDb, vaultDir: restoredVault });

  const db = new Database(restoredDb, { readonly: true });
  try {
    for (const tenant of db.prepare("SELECT DISTINCT tenant_id FROM audit_log").all() as Array<{ tenant_id: string }>) {
      const rows = db.prepare("SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY sequence").all(tenant.tenant_id) as Array<Record<string, unknown>>;
      assert.equal(verifyAuditChainRows(rows).valid, true, `audit chain of ${tenant.tenant_id}`);
    }

    // Documents decrypt and match their recorded hash, reading from the restored vault.
    const previousVault = process.env.KONTROL_VAULT_DIR;
    process.env.KONTROL_VAULT_DIR = restoredVault;
    try {
      const { readLocalDocument } = await import("../src/lib/core/vault-store");
      const row = db.prepare("SELECT id, tenant_id, storage_uri, content_hash FROM vault_documents WHERE id = ?").get(documentId) as { id: string; tenant_id: string; storage_uri: string; content_hash: string };
      const read = readLocalDocument(row);
      assert.equal(read.bytes.toString(), TEXT);
      assert.equal(read.sha256, documentHash);

      // Credentials open with the original key and with nothing else.
      const { open } = await import("../src/lib/core/secrets");
      const credential = db.prepare("SELECT ciphertext, iv, tag FROM connector_credentials WHERE tenant_id = ? AND kind = 'github'").get(admin.tenantId) as { ciphertext: string; iv: string; tag: string };
      assert.ok(JSON.parse(open(credential, `${admin.tenantId}:github`)).token.startsWith("github_pat_"));
      process.env.KONTROL_SECRETS_KEY = "z".repeat(40);
      assert.throws(() => open(credential, `${admin.tenantId}:github`));
      assert.throws(() => readLocalDocument(row), /not configured/);
    } finally { process.env.KONTROL_SECRETS_KEY = KEY; process.env.KONTROL_VAULT_DIR = previousVault; }
  } finally { db.close(); }

  // Restoring never overwrites what is already there.
  assert.throws(() => restoreBackup({ backupDir: join(work, "backup-1"), databasePath: restoredDb, vaultDir: restoredVault }), /already exists/);
});

test("a damaged backup is detected before it is restored", { skip: process.env.KONTROL_TEST_DB === "postgres" && "SQLite profile only" }, async () => {
  const { createBackup, verifyBackup, restoreBackup } = await backupLib();
  const target = join(work, "backup-2");
  await createBackup({ databasePath: join(dir, "kontrol.db"), vaultDir, targetDir: target });
  assert.equal(verifyBackup(target).ok, true);

  const vaultFiles = (function list(folder: string): string[] { return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? list(join(folder, entry.name)) : [join(folder, entry.name)])); })(join(target, "vault"));
  appendFileSync(vaultFiles[0], "x");
  const damaged = verifyBackup(target);
  assert.equal(damaged.ok, false);
  assert.match(damaged.problems.join(" "), /vault file altered/);
  assert.throws(() => restoreBackup({ backupDir: target, databasePath: join(work, "r2", "k.db"), vaultDir: join(work, "r2", "vault") }), /not valid/);
  assert.equal(existsSync(join(work, "r2", "k.db")), false, "nothing was restored from a damaged backup");

  const clean = join(work, "backup-3");
  await createBackup({ databasePath: join(dir, "kontrol.db"), vaultDir, targetDir: clean });
  writeFileSync(join(clean, "vault", "intruder.bin"), "not in the manifest");
  assert.match(verifyBackup(clean).problems.join(" "), /not in the manifest/);

  const tampered = join(work, "backup-4");
  await createBackup({ databasePath: join(dir, "kontrol.db"), vaultDir, targetDir: tampered });
  appendFileSync(join(tampered, "kontrol.db"), "tamper");
  assert.match(verifyBackup(tampered).problems.join(" "), /database file does not match/);
});
