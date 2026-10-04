import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Measures the main reads at a stated volume on a throwaway SQLite database, so that "it scales" is a number and not a claim.
 * Usage: npm run measure -- [risks] [evidence] [nonconformities]     (defaults: 2000 20000 1000)
 */
const [risks, evidence, nonconformities] = [2000, 20_000, 1000].map((fallback, index) => Number(process.argv[2 + index] ?? fallback));
process.env.KONTROL_DATABASE_PATH = join(mkdtempSync(join(tmpdir(), "kontrol-measure-")), "kontrol.db");
process.env.KONTROL_SEED = "true";
process.env.KONTROL_DB_DRIVER = "sqlite";

const time = async <T,>(label: string, run: () => Promise<T>) => {
  const started = performance.now();
  const result = await run();
  console.log(`${label.padEnd(46)} ${(performance.now() - started).toFixed(0).padStart(7)} ms`);
  return result;
};

const { getDb, closeDb } = await import("../src/lib/db");
const db = (await getDb()).system();
const tenant = "tenant_acme";
const now = new Date().toISOString();
const user = (await db.get<{ id: string }>("SELECT id FROM users WHERE tenant_id = ? LIMIT 1", tenant))!.id;
const control = (await db.get<{ id: string }>("SELECT id FROM controls WHERE tenant_id = ? LIMIT 1", tenant))!.id;
const asset = (await db.get<{ id: string }>("SELECT id FROM assets WHERE tenant_id = ? LIMIT 1", tenant))!.id;

await time(`insert ${risks} risks`, async () => {
  await (await getDb()).scope(tenant).transaction(async (tx) => {
    for (let index = 0; index < risks; index += 1) {
      const id = `rsk_${randomUUID()}`;
      await tx.run("INSERT INTO risk_items (id,tenant_id,ref,title,category,likelihood,impact,treatment,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", id, tenant, `RSK-${String(index + 1).padStart(5, "0")}`, `Measured risk ${index + 1}`, "cyber", 1 + (index % 5), 1 + ((index * 3) % 5), "undecided", "identified", user, now, now);
      await tx.run("INSERT INTO risk_item_controls (tenant_id,risk_id,uc_code) VALUES (?,?,?)", tenant, id, index % 2 ? "UC-OPS-02" : "UC-IAM-02");
    }
  });
});
await time(`insert ${evidence} evidence records`, async () => {
  await (await getDb()).scope(tenant).transaction(async (tx) => {
    for (let index = 0; index < evidence; index += 1) await tx.run("INSERT INTO evidence (id,tenant_id,control_id,asset_id,name,source,collection_method,content_type,content_json,content_hash,collected_at,expires_at,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", `evidence_${randomUUID()}`, tenant, control, asset, "Measured evidence", "github:api", "automated policy evaluation", "application/json", "{}", "0".repeat(64), new Date(Date.now() - index * 60_000).toISOString(), null, index % 7 ? "healthy" : "failed", user);
  });
});
await time(`insert ${nonconformities} nonconformities`, async () => {
  await (await getDb()).scope(tenant).transaction(async (tx) => {
    for (let index = 0; index < nonconformities; index += 1) await tx.run("INSERT INTO isms_nonconformities (id,tenant_id,ref,source,severity,title,status,raised_by,raised_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", `nc_${randomUUID()}`, tenant, `NC-${String(index + 1).padStart(5, "0")}`, "internal_audit", "minor", `Measured finding ${index + 1}`, "open", user, now, now);
  });
});

const { complianceSnapshot, adoptFramework } = await import("../src/lib/core/compliance-engine");
await adoptFramework({ userId: user, tenantId: tenant, email: "", name: "", role: "admin" }, { frameworkId: "iso27001", scope: "Measurement" });
const { riskSnapshot } = await import("../src/lib/core/risk-register");
const { riskTraceability } = await import("../src/lib/core/risk-traceability");
const { ismsSnapshot } = await import("../src/lib/core/isms");
const { page } = await import("../src/lib/core/paging");
const { verifyAuditChain } = await import("../src/lib/core/integrity");

console.log("");
await time("compliance snapshot", () => complianceSnapshot(tenant));
await time(`risk register (${risks} risks, all rated)`, () => riskSnapshot(tenant));
await time("risk traceability", () => riskTraceability(tenant));
await time("ISMS page with the clause checklist", () => ismsSnapshot(tenant));
await time("one page of 50 risks, with the total", () => page(tenant, "risks", { limit: 50, offset: 1000 }));
await time("one page of 50 evidence records", () => page(tenant, "evidence", { limit: 50, offset: 10_000 }));
await time("audit chain verification", () => verifyAuditChain(tenant));
await closeDb();
