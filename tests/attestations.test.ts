import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_VAULT_DIR: mkdtempSync(join(tmpdir(), "kontrol-vault-")), KONTROL_REQUIRE_COUNTERSIGN: undefined });

const engine = () => import("../src/lib/core/compliance-engine");
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const control = async (code: string) => (await (await engine()).complianceSnapshot(admin.tenantId)).controls.find((item) => item.code === code)!;
const score = async () => (await (await engine()).complianceSnapshot(admin.tenantId)).scores.find((item) => item.frameworkId === "iso27001")!.score;

async function adoptIso() {
  const { adoptFramework } = await engine();
  await adoptFramework(admin, { frameworkId: "iso27001", scope: "Whole organisation under test" });
}

test("an attestation gets a review date by status, and a lapsed one stops counting in full", async () => {
  const { setImplementation, complianceSnapshot } = await engine();
  await adoptIso();
  await setImplementation(admin, { ucCode: "UC-GOV-01", status: "implemented", maturity: 4, notes: "Policy framework approved" });
  const fresh = await control("UC-GOV-01");
  assert.ok(Date.parse(fresh.reviewDue!) > Date.now() + 360 * DAY, "implemented claims are reviewed yearly");
  assert.equal(fresh.attestationExpired, false);
  const healthy = await score();

  await setImplementation(admin, { ucCode: "UC-GOV-01", status: "implemented", maturity: 4, notes: "Policy framework approved", reviewDue: iso(-3) });
  const lapsed = await control("UC-GOV-01");
  assert.equal(lapsed.attestationExpired, true);
  assert.equal(lapsed.weight, 0.5, "capped at partial");
  assert.ok(await score() < healthy);
  const alerts = (await complianceSnapshot(admin.tenantId)).alerts;
  assert.ok(alerts.expiredAttestations.some((item) => item.code === "UC-GOV-01"));

  await setImplementation(admin, { ucCode: "UC-GOV-02", status: "partial", maturity: 2, notes: "Roles drafted", reviewDue: iso(10) });
  assert.ok((await complianceSnapshot(admin.tenantId)).alerts.expiringAttestations.some((item) => item.code === "UC-GOV-02"), "warned 30 days ahead");
  assert.ok((await control("UC-PHY-01")).reviewDue === null, "an unattested control has no clock");
});

test("re-attesting renews the clock and clears the countersignature", async () => {
  const { reattest, countersign, setImplementation } = await engine();
  await assert.rejects(reattest(admin, { ucCode: "UC-NOPE-99", note: "Still accurate and unchanged." }), /not found/);
  await assert.rejects(reattest(admin, { ucCode: "UC-DAT-01", note: "Never attested control here." }), /Only an implemented/);

  await setImplementation(admin, { ucCode: "UC-GOV-03", status: "implemented", maturity: 3, notes: "Scope documented", reviewDue: iso(-1) });
  assert.equal((await control("UC-GOV-03")).attestationExpired, true);
  await countersign(riskOwner, { ucCode: "UC-GOV-03", note: "Checked the scope statement myself." });
  await reattest(admin, { ucCode: "UC-GOV-03", note: "Scope reviewed, unchanged this year." });
  const renewed = await control("UC-GOV-03");
  assert.equal(renewed.attestationExpired, false);
  assert.equal(renewed.countersignedBy, null, "a renewed claim needs a fresh second pair of eyes");
});

test("a second person must countersign, and changing the attestation voids the countersignature", async () => {
  const { countersign, setImplementation } = await engine();
  await setImplementation(admin, { ucCode: "UC-GOV-04", status: "implemented", maturity: 3, notes: "Risk method in place" });
  await assert.rejects(countersign(admin, { ucCode: "UC-GOV-04", note: "Confirming my own work." }), /Separation of duties/);
  await assert.rejects(countersign(riskOwner, { ucCode: "UC-DAT-01", note: "Nothing attested to confirm." }), /Only an implemented/);
  await countersign(riskOwner, { ucCode: "UC-GOV-04", note: "Reviewed the methodology and register." });
  assert.equal((await control("UC-GOV-04")).countersignedBy, riskOwner.userId);

  await setImplementation(admin, { ucCode: "UC-GOV-04", status: "implemented", maturity: 4, notes: "Method updated" });
  assert.equal((await control("UC-GOV-04")).countersignedBy, null);
});

test("when the organisation requires countersignature, an unconfirmed claim counts as partial", async () => {
  const { countersign, setImplementation } = await engine();
  await setImplementation(admin, { ucCode: "UC-GOV-05", status: "implemented", maturity: 3, notes: "KPIs reported to management" });
  assert.equal((await control("UC-GOV-05")).weight, 1);
  setEnv({ KONTROL_REQUIRE_COUNTERSIGN: "true" });
  try {
    const waiting = await control("UC-GOV-05");
    assert.equal(waiting.awaitingCountersignature, true);
    assert.equal(waiting.weight, 0.5);
    await countersign(riskOwner, { ucCode: "UC-GOV-05", note: "Saw the management review minutes." });
    assert.equal((await control("UC-GOV-05")).weight, 1);
  } finally { setEnv({ KONTROL_REQUIRE_COUNTERSIGN: undefined }); }
});

// ---- documentary evidence -----------------------------------------------------------------------------------------------
const pdf = (text: string) => new File([`%PDF-1.4 ${text}`], "training-register.pdf", { type: "application/pdf" });

test("uploaded evidence stays pending, cannot be self-approved, and once accepted backs the claim as documented", async () => {
  const { attachEvidence, reviewEvidence, setImplementation, frameworkDetail } = await engine();
  await setImplementation(admin, { ucCode: "UC-HR-02", status: "implemented", maturity: 3, notes: "Annual training delivered" });
  assert.equal((await control("UC-HR-02")).verification, "unverified");

  const base = { ucCode: "UC-HR-02", title: "2026 training attendance register", kind: "record" as const, note: "Signed by HR", file: pdf("attendance 2026") };
  await assert.rejects(attachEvidence(admin, { ...base, validUntil: iso(-1) }), /future/);
  await assert.rejects(attachEvidence(admin, { ...base, validUntil: iso(800) }), /730 days/);
  const uploaded = await attachEvidence(admin, { ...base, validUntil: iso(300) });
  assert.equal(uploaded.status, "pending");
  assert.equal(uploaded.hash.length, 64);
  assert.equal((await control("UC-HR-02")).verification, "unverified", "pending evidence proves nothing");

  await assert.rejects(reviewEvidence(admin, { id: uploaded.id, accept: true, note: "Approving my own upload." }), /Separation of duties/);
  const results = await Promise.allSettled([
    reviewEvidence(riskOwner, { id: uploaded.id, accept: true, note: "Register matches the HR export." }),
    reviewEvidence(riskOwner, { id: uploaded.id, accept: false, note: "Competing decision attempt." }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1, "a review is final");
  assert.equal((await control("UC-HR-02")).verification, results[0].status === "fulfilled" ? "documented" : "unverified");

  const detail = await frameworkDetail(admin.tenantId, "iso27001");
  assert.equal(detail.requirements.find((item) => item.id === "A6.3")?.verified, results[0].status === "fulfilled", "documented evidence counts as backed");
});

test("rejected, expired and contradicted evidence does not back a claim", async () => {
  const { attachEvidence, reviewEvidence, setImplementation } = await engine();
  const { getDb } = await import("../src/lib/db");
  await setImplementation(admin, { ucCode: "UC-HR-01", status: "implemented", maturity: 3, notes: "Screening in place" });
  const rejected = await attachEvidence(admin, { ucCode: "UC-HR-01", title: "Screening policy", kind: "document", validUntil: iso(200), note: "", file: pdf("screening v1") });
  await reviewEvidence(riskOwner, { id: rejected.id, accept: false, note: "Does not cover contractors." });
  assert.equal((await control("UC-HR-01")).verification, "unverified");

  const accepted = await attachEvidence(admin, { ucCode: "UC-HR-01", title: "Screening policy v2", kind: "document", validUntil: iso(200), note: "", file: pdf("screening v2") });
  await reviewEvidence(riskOwner, { id: accepted.id, accept: true, note: "Now covers contractors." });
  assert.equal((await control("UC-HR-01")).verification, "documented");

  await (await getDb()).scope(admin.tenantId).run("UPDATE control_evidence SET valid_until = ? WHERE id = ?", iso(-2), accepted.id);
  assert.equal((await control("UC-HR-01")).verification, "stale", "accepted evidence lapses");
  await assert.rejects(reviewEvidence(riskOwner, { id: "cev_missing", accept: true, note: "Nothing to review here." }), /not found/);
});

test("a document never overrides failing machine evidence", async () => {
  const { attachEvidence, reviewEvidence, setImplementation, linkEvidence } = await engine();
  const { syncAws } = await import("../src/lib/connectors");
  await syncAws(admin); // demo facts: S3 public access block fails
  await setImplementation(admin, { ucCode: "UC-OPS-04", status: "implemented", maturity: 3, notes: "Network controls in place" });
  await linkEvidence(admin);
  const doc = await attachEvidence(admin, { ucCode: "UC-OPS-04", title: "Network design review", kind: "report", validUntil: iso(100), note: "", file: pdf("network review") });
  await reviewEvidence(riskOwner, { id: doc.id, accept: true, note: "Design review looks sound to me." });
  assert.equal((await control("UC-OPS-04")).verification, "failing");
});

test("evidence and attestation changes are chained in the audit log", async () => {
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  const { getDb } = await import("../src/lib/db");
  assert.equal((await verifyAuditChain(admin.tenantId)).valid, true);
  const actions = new Set((await (await getDb()).scope(admin.tenantId).all<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE tenant_id = ? AND action LIKE 'compliance.%'", admin.tenantId)).map((row) => row.action));
  for (const expected of ["compliance.attestation_renewed", "compliance.attestation_countersigned", "compliance.evidence_attached", "compliance.evidence_accepted", "compliance.evidence_rejected"]) assert.ok(actions.has(expected), `missing ${expected}`);
});
