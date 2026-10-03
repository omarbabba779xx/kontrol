import Database from "better-sqlite3";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * Backup, verification and restore for the SQLite profile: the database (a consistent online snapshot), the document vault (its files
 * are already encrypted) and a manifest of hashes. The encryption keys are NOT in the backup: they are the operator's secret, kept
 * apart, and a restore is only usable with them. For PostgreSQL use pg_dump or the platform's snapshot facility for the database and
 * the same vault copy; docs/OPERATIONS.md describes both.
 *
 * This module has no dependency on the application runtime so it can run from a script against files at rest.
 */
export type Manifest = {
  format: "kontrol-backup/1";
  createdAt: string;
  database: { file: string; sha256: string; bytes: number };
  vault: Array<{ path: string; sha256: string; bytes: number }>;
  audit: Array<{ tenantId: string; entries: number; rootHash: string | null }>;
};

const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const walk = (directory: string): string[] => (existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])) : []);

function auditHeads(databasePath: string) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return (db.prepare("SELECT tenant_id AS tenantId, COUNT(*) AS entries FROM audit_log GROUP BY tenant_id").all() as Array<{ tenantId: string; entries: number }>).map((row) => {
      const last = db.prepare("SELECT entry_hash FROM audit_log WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1").get(row.tenantId) as { entry_hash: string } | undefined;
      return { tenantId: row.tenantId, entries: Number(row.entries), rootHash: last?.entry_hash ?? null };
    });
  } finally { db.close(); }
}

export async function createBackup(input: { databasePath: string; vaultDir: string; targetDir: string }): Promise<Manifest> {
  const target = resolve(input.targetDir);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`The backup folder ${target} is not empty: refusing to mix two backups`);
  mkdirSync(target, { recursive: true });
  const source = new Database(input.databasePath, { readonly: true });
  const databaseCopy = join(target, "kontrol.db");
  try { await source.backup(databaseCopy); } finally { source.close(); }
  if (existsSync(input.vaultDir)) cpSync(input.vaultDir, join(target, "vault"), { recursive: true });
  const vault = walk(join(target, "vault")).map((file) => ({ path: relative(join(target, "vault"), file).split("\\").join("/"), sha256: hashFile(file), bytes: statSync(file).size }));
  const manifest: Manifest = { format: "kontrol-backup/1", createdAt: new Date().toISOString(), database: { file: "kontrol.db", sha256: hashFile(databaseCopy), bytes: statSync(databaseCopy).size }, vault, audit: auditHeads(databaseCopy) };
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

export type Verification = { ok: boolean; problems: string[]; manifest: Manifest | null };

/** Checks a backup against its manifest without restoring it: every file hash, and that the audit chains end where they ended at backup time. */
export function verifyBackup(backupDir: string): Verification {
  const dir = resolve(backupDir);
  const problems: string[] = [];
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return { ok: false, problems: ["manifest.json is missing"], manifest: null };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  if (manifest.format !== "kontrol-backup/1") problems.push(`unsupported backup format ${String(manifest.format)}`);
  const databasePath = join(dir, manifest.database.file);
  if (!existsSync(databasePath)) problems.push("the database file is missing");
  else if (hashFile(databasePath) !== manifest.database.sha256) problems.push("the database file does not match its recorded hash");
  for (const file of manifest.vault) {
    const path = join(dir, "vault", file.path);
    if (!existsSync(path)) problems.push(`vault file missing: ${file.path}`);
    else if (hashFile(path) !== file.sha256) problems.push(`vault file altered: ${file.path}`);
  }
  const listed = new Set(manifest.vault.map((file) => file.path));
  for (const file of walk(join(dir, "vault"))) { const path = relative(join(dir, "vault"), file).split("\\").join("/"); if (!listed.has(path)) problems.push(`vault file not in the manifest: ${path}`); }
  if (existsSync(databasePath) && !problems.some((item) => item.startsWith("the database"))) {
    const heads = auditHeads(databasePath);
    for (const expected of manifest.audit) {
      const actual = heads.find((head) => head.tenantId === expected.tenantId);
      if (!actual || actual.entries !== expected.entries || actual.rootHash !== expected.rootHash) problems.push(`audit chain of ${expected.tenantId} does not end where it did at backup time`);
    }
  }
  return { ok: problems.length === 0, problems, manifest };
}

/** Restores into empty locations only: it never overwrites a live database or vault. */
export function restoreBackup(input: { backupDir: string; databasePath: string; vaultDir: string }) {
  const check = verifyBackup(input.backupDir);
  if (!check.ok || !check.manifest) throw new Error(`The backup is not valid: ${check.problems.join("; ")}`);
  if (existsSync(input.databasePath)) throw new Error(`${input.databasePath} already exists: restore into a new location, then switch over`);
  if (existsSync(input.vaultDir) && readdirSync(input.vaultDir).length) throw new Error(`${input.vaultDir} is not empty: restore into a new location, then switch over`);
  mkdirSync(resolve(input.databasePath, ".."), { recursive: true });
  cpSync(join(resolve(input.backupDir), check.manifest.database.file), input.databasePath);
  if (existsSync(join(resolve(input.backupDir), "vault"))) cpSync(join(resolve(input.backupDir), "vault"), input.vaultDir, { recursive: true });
  return check.manifest;
}
