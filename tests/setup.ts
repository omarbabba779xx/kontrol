import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Points the kernel at a throwaway SQLite file. Call before importing any kernel module. */
export function isolateDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "kontrol-test-"));
  process.env.KONTROL_DATABASE_PATH = join(dir, "kontrol.db");
  return dir;
}

export function setEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else (process.env as Record<string, string>)[key] = value;
  }
}

export const admin = { userId: "usr_leila", tenantId: "tenant_acme", email: "leila@acme.example", name: "Leila Mansour", role: "admin" as const };
export const riskOwner = { userId: "usr_maya", tenantId: "tenant_acme", email: "maya@acme.example", name: "Maya Chen", role: "risk_owner" as const };
