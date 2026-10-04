import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { admin, isolateDatabase } from "./setup";

isolateDatabase();

test("the readiness report is a valid, signed PDF whose fingerprint is anchored in the audit chain", async () => {
  const { loadDemoPosture } = await import("../src/lib/core/compliance-engine");
  const { buildReadinessReport } = await import("../src/lib/core/report");
  const { signDecision, verifyAuditChain } = await import("../src/lib/core/integrity");
  const { getDb } = await import("../src/lib/db");

  await loadDemoPosture(admin);
  const { bytes, meta } = await buildReadinessReport(admin);

  assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), meta.pages);
  assert.ok(meta.pages >= 4, `a six-framework report spans several pages, got ${meta.pages}`);
  assert.equal(pdf.getTitle(), "Audit readiness report");
  assert.equal(meta.fingerprint.length, 64);
  assert.equal(meta.signature, await signDecision({ fingerprint: meta.fingerprint, tenant: admin.tenantId, generatedAt: meta.generatedAt }));
  assert.equal(meta.frameworks.length, 6);

  const anchored = await (await getDb()).scope(admin.tenantId).get<{ object_id: string }>("SELECT object_id FROM audit_log WHERE tenant_id = ? AND action = 'compliance.report_generated' ORDER BY sequence DESC LIMIT 1", admin.tenantId);
  assert.equal(anchored?.object_id, meta.fingerprint);
  assert.equal((await verifyAuditChain(admin.tenantId)).valid, true);
});

test("a single-framework report is shorter and names only that framework", async () => {
  const { buildReadinessReport } = await import("../src/lib/core/report");
  const all = await buildReadinessReport(admin);
  const one = await buildReadinessReport(admin, { frameworkId: "iso27001" });
  assert.deepEqual(one.meta.frameworks, ["iso27001"]);
  assert.ok(one.meta.pages < all.meta.pages);
  assert.notEqual(one.meta.fingerprint, all.meta.fingerprint);
});

test("text that the standard PDF fonts cannot encode is made safe instead of crashing the document", async () => {
  const { pdfSafe } = await import("../src/lib/core/report");
  assert.equal(pdfSafe("Café → ≥ 5 — “quoted” ✓ 日本"), "Café -> >= 5 — “quoted” ? ??");
  assert.equal(pdfSafe(null), "");
});
