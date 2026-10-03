// Backup, verify and restore (SQLite profile).
//   npm run backup -- create  <folder>          snapshot of the database and the vault into an empty folder
//   npm run backup -- verify  <folder>          check a backup against its manifest
//   npm run backup -- restore <folder> <db> <vault>   restore into new, empty locations
// The encryption keys (KONTROL_SECRETS_KEY and its previous values) are not part of the backup. Keep them separately.
import { join } from "node:path";
import { createBackup, restoreBackup, verifyBackup } from "../src/lib/ops/backup";

const [command, ...args] = process.argv.slice(2);
const databasePath = process.env.KONTROL_DATABASE_PATH ?? join(process.cwd(), ".data", "kontrol.db");
const vaultDir = process.env.KONTROL_VAULT_DIR ?? join(process.cwd(), ".data", "vault");

async function main() {
  if (command === "create" && args[0]) {
    const manifest = await createBackup({ databasePath, vaultDir, targetDir: args[0] });
    console.log(`Backup written to ${args[0]}: database ${manifest.database.bytes} bytes, ${manifest.vault.length} vault files, ${manifest.audit.length} audit chains.`);
  } else if (command === "verify" && args[0]) {
    const result = verifyBackup(args[0]);
    console.log(result.ok ? "Backup is valid." : `Backup is NOT valid:\n- ${result.problems.join("\n- ")}`);
    process.exit(result.ok ? 0 : 1);
  } else if (command === "restore" && args[0] && args[1] && args[2]) {
    const manifest = restoreBackup({ backupDir: args[0], databasePath: args[1], vaultDir: args[2] });
    console.log(`Restored the backup of ${manifest.createdAt} into ${args[1]} and ${args[2]}. Start with the same KONTROL_SECRETS_KEY.`);
  } else {
    console.log("Usage: backup create <folder> | verify <folder> | restore <folder> <database> <vault>");
    process.exit(2);
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
