import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase } from "./setup";

isolateDatabase();

const engine = () => import("../src/lib/core/compliance-engine");
const licensed = () => import("../src/lib/core/licensed-content");

const base = { framework: "pci_dss" as const, sourceLabel: "PCI DSS v4.0.1 (our licensed copy)", licenceReference: "PCI SSC document library, order 4711", acknowledgeLicence: true as const };
const items = [
  { id: "Req.8.3.1", title: "All user access to system components is authenticated via a factor", parent: "Req.8.3", procedure: "Examine system configuration settings to verify an authentication factor is required." },
  { id: "Req.8.3.2", title: "Strong cryptography renders authentication factors unreadable", parent: "Req.8.3", procedure: "Examine vendor documentation and system configuration.", guidance: "Applies to all components." },
  { id: "Req.8.4", guidance: "MFA is required for all access into the CDE." },
];

const detail = async (framework = "pci_dss" as const) => (await engine()).frameworkDetail(admin.tenantId, framework);
const requirement = async (id: string) => (await detail()).requirements.find((item) => item.id === id);

async function adoptPci() {
  const { adoptFramework, setImplementation } = await engine();
  await adoptFramework(admin, { frameworkId: "pci_dss", scope: "Cardholder data environment" });
  await setImplementation(admin, { ucCode: "UC-IAM-02", status: "implemented", maturity: 4, notes: "MFA everywhere" });
}

test("imported sub-requirements inherit their parent's controls and replace the parent in the score", async () => {
  await adoptPci();
  const before = await detail();
  const parent = before.requirements.find((item) => item.id === "Req.8.3")!;
  assert.deepEqual(parent.controls, ["UC-IAM-02"]);
  assert.equal(parent.status, "compliant");

  const result = await (await licensed()).importLicensedContent(admin, { ...base, items });
  assert.equal(result.subRequirements, 2);
  assert.equal(result.texts, 4);
  assert.equal(result.contentHash.length, 64);

  const after = await detail();
  const child = after.requirements.find((item) => item.id === "Req.8.3.1")!;
  assert.equal(child.custom, true);
  assert.deepEqual(child.controls, ["UC-IAM-02"], "inherited from the parent section");
  assert.equal(child.status, "compliant");
  assert.equal(child.group, parent.group, "stays in the parent's group");

  const replaced = after.requirements.find((item) => item.id === "Req.8.3")!;
  assert.equal(replaced.status, "not_applicable");
  assert.match(replaced.justification ?? "", /Refined into 2 imported/);
  assert.equal(after.applicable, before.applicable + 1, "two children replace one parent");

  const procedures = (await requirement("Req.8.3.2"))!.licensed;
  assert.deepEqual(procedures.map((item) => item.kind).sort(), ["guidance", "procedure"]);
  assert.equal(procedures[0].sourceLabel, base.sourceLabel);
  assert.equal((await requirement("Req.8.4"))!.licensed[0].body, "MFA is required for all access into the CDE.", "text can be attached to an existing requirement without adding one");
  assert.equal((await requirement("Req.8.4"))!.custom, undefined);
});

test("an imported sub-requirement is scored, reviewable and excludable like any other", async () => {
  const { reviewMapping, setRequirementScope, setImplementation } = await engine();
  await reviewMapping(admin, { frameworkId: "pci_dss", requirementId: "Req.8.3.1", ucCode: "UC-GOV-01", decision: "added", note: "Our authentication standard governs this." });
  assert.ok((await requirement("Req.8.3.1"))!.controls.includes("UC-GOV-01"));
  assert.equal((await requirement("Req.8.3.1"))!.links.find((link) => link.ucCode === "UC-IAM-02")?.basis, "editorial");

  await setRequirementScope(admin, { frameworkId: "pci_dss", requirementId: "Req.8.3.2", applicable: false, justification: "We do not store authentication factors at all." });
  assert.equal((await requirement("Req.8.3.2"))!.status, "not_applicable");

  await setImplementation(admin, { ucCode: "UC-IAM-02", status: "partial", maturity: 2, notes: "MFA partly rolled out" });
  const partial = await requirement("Req.8.3.1");
  assert.ok(partial!.score! < 1, "the score follows the control");
});

test("an import is validated completely before anything is written", async () => {
  const { importLicensedContent } = await licensed();
  const { getDb } = await import("../src/lib/db");
  const countBefore = async () => Number((await (await getDb()).scope(admin.tenantId).get<{ n: number }>("SELECT COUNT(*) AS n FROM custom_requirements WHERE tenant_id = ?", admin.tenantId))?.n);
  const before = await countBefore();

  const attempt = (patch: Record<string, unknown>) => importLicensedContent(admin, { ...base, items: [{ id: "Req.5.9.9", title: "A valid new item", parent: "Req.5.2", procedure: "Check." }], ...patch });
  await assert.rejects(attempt({ acknowledgeLicence: false }), /licensed/i, "no acknowledgement, no import");
  await assert.rejects(attempt({ licenceReference: "" }));
  await assert.rejects(attempt({ framework: "nope" }));
  await assert.rejects(attempt({ items: [] }));
  await assert.rejects(attempt({ items: [{ id: "bad id!", title: "x y", parent: "Req.5.2" }] }), /Identifiers/);
  await assert.rejects(attempt({ items: [{ id: "Req.5.9.9", title: "Valid", parent: "Req.5.2", procedure: "ok" }, { id: "Req.5.9.9", title: "Again", parent: "Req.5.2", procedure: "ok" }] }), /duplicate/);
  await assert.rejects(attempt({ items: [{ id: "Req.5.9.9", parent: "Req.5.2", procedure: "ok" }] }), /needs a title/);
  await assert.rejects(attempt({ items: [{ id: "Req.5.9.9", title: "Orphan", parent: "Req.99.1", procedure: "ok" }] }), /needs a parent/);
  await assert.rejects(attempt({ items: [{ id: "Req.5.9.9", title: "No parent" }] }), /needs a parent/);
  await assert.rejects(attempt({ items: [{ id: "Req.8.4" }] }), /nothing to import/);
  await assert.rejects(attempt({ items: [{ id: "A.1", title: "Loop A", parent: "B.1" }, { id: "B.1", title: "Loop B", parent: "A.1" }] }), /parent/);
  await assert.rejects(attempt({ items: Array.from({ length: 5001 }, (_, index) => ({ id: `Req.7.9.${index}`, title: "Too many", parent: "Req.7.1" })) }));
  assert.equal(await countBefore(), before, "a failed import leaves the previous state untouched");
});

test("a sub-requirement can sit under another imported one", async () => {
  const { importLicensedContent } = await licensed();
  await importLicensedContent(admin, { ...base, items: [
    { id: "Req.3.5.1", title: "PAN is rendered unreadable", parent: "Req.3.5" },
    { id: "Req.3.5.1.1", title: "Hashes are keyed cryptographic hashes", parent: "Req.3.5.1" },
    { id: "Req.3.5.1.2", title: "Disk-level encryption is not the only mechanism", parent: "Req.3.5.1" },
  ] });
  const leaf = (await requirement("Req.3.5.1.1"))!;
  assert.deepEqual(leaf.controls, ["UC-DAT-03"], "inherited from Req.3.5 through two imported levels");
  assert.equal((await requirement("Req.3.5.1"))!.status, "not_applicable", "the middle level is replaced by its children");
  assert.equal((await requirement("Req.3.5"))!.status, "not_applicable");
  assert.equal((await requirement("Req.8.3.1")), undefined, "a new import replaces the previous one for the framework");
});

test("the import is recorded with its licence acknowledgement, and removing it restores the catalogue", async () => {
  const { complianceSnapshot } = await engine();
  const { removeLicensedContent } = await licensed();
  const { getDb } = await import("../src/lib/db");
  const snapshot = await complianceSnapshot(admin.tenantId);
  assert.equal(snapshot.imports.length, 1);
  assert.equal(snapshot.imports[0].licence_reference, base.licenceReference);
  assert.equal(snapshot.imports[0].acknowledged_by, admin.userId);
  assert.equal(snapshot.catalog.find((item) => item.id === "pci_dss")!.imported, 3);

  const counts = await removeLicensedContent(admin, "pci_dss");
  assert.equal(counts.subRequirements, 3);
  const restored = await requirement("Req.3.5");
  assert.notEqual(restored!.status, "not_applicable");
  assert.equal(await requirement("Req.3.5.1"), undefined);
  assert.equal((await complianceSnapshot(admin.tenantId)).imports.length, 0);
  const stored = await (await getDb()).scope(admin.tenantId).all<{ n: number }>("SELECT COUNT(*) AS n FROM licensed_content WHERE tenant_id = ?", admin.tenantId);
  assert.equal(Number(stored[0].n), 0, "no licensed text remains");

  const actions = new Set((await (await getDb()).scope(admin.tenantId).all<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE tenant_id = ? AND action LIKE 'compliance.licensed%'", admin.tenantId)).map((row) => row.action));
  assert.ok(actions.has("compliance.licensed_content_imported") && actions.has("compliance.licensed_content_removed"));
});

test("imported content belongs to one tenant", async () => {
  const { importLicensedContent } = await licensed();
  const { complianceSnapshot } = await engine();
  const { getDb } = await import("../src/lib/db");
  await importLicensedContent(admin, { ...base, items });
  await (await getDb()).system().run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", "tenant_other", "Other Corp", "EU", new Date().toISOString());
  const other = await complianceSnapshot("tenant_other");
  assert.equal(other.imports.length, 0);
  assert.equal(other.catalog.find((item) => item.id === "pci_dss")!.imported, 0);
  const otherDetail = await (await engine()).frameworkDetail("tenant_other", "pci_dss");
  assert.equal(otherDetail.requirements.some((item) => item.custom), false);
  assert.equal(otherDetail.requirements.every((item) => item.licensed.length === 0), true);
});

test("business-rule failures answer with 4xx codes, not 500", async () => {
  const { apiError } = await import("../src/lib/core/api");
  const { userError } = await import("../src/lib/core/errors");
  const status = (message: string) => apiError(userError(message)).status;
  assert.equal(status("Separation of duties: nope"), 403);
  assert.equal(status("Exception has already been decided"), 409);
  assert.equal(status("Control X not found"), 404);
  assert.equal(status("A justification is required"), 400);
  assert.equal(apiError(new Error("database exploded")).status, 500);

  const { decideException } = await engine();
  await assert.rejects(decideException(admin, { id: "exc_missing", approve: true, note: "Looking for a missing one" }), (error: Error & { status?: number }) => error.status === 404);
});
