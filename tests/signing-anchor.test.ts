import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const db = async () => (await import("../src/lib/db")).getDb();

test("facts posted to the evaluate endpoint are recorded as manual and never verify a control", async () => {
  const { POST } = await import("../src/app/api/controls/evaluate/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const { setImplementation, complianceSnapshot } = await import("../src/lib/core/compliance-engine");
  const owner = await issueSessionToken({ ...admin, role: "control_owner" });
  const facts = { production: true, branch_protection: true, required_reviews: 2, dismiss_stale_reviews: true, enforce_admins: true };
  const response = await POST(new Request("http://localhost/api/controls/evaluate", { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify({ controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts, source: "github:api" }) }));
  assert.equal(response.status, 200);
  const sys = (await db()).system();
  const row = (await sys.get<{ source: string; collection_method: string; content_json: string }>("SELECT source, collection_method, content_json FROM evidence ORDER BY collected_at DESC LIMIT 1"))!;
  assert.equal(row.source, `manual:${admin.userId}`, "the claimed source is ignored");
  assert.equal(row.collection_method, "manual assertion");
  assert.ok((JSON.parse(row.content_json) as { provenance: { limits: string[] } }).provenance.limits.some((text) => /asserted by the caller/.test(text)));

  await setImplementation(admin, { ucCode: "UC-SDL-01", status: "implemented", maturity: 3, notes: "Attested" });
  await sys.run("UPDATE control_implementations SET linked_control_code = 'CTL-SDLC-004' WHERE uc_code = 'UC-SDL-01'");
  const snapshot = await complianceSnapshot(admin.tenantId);
  const control = snapshot.controls.find((item) => item.code === "UC-SDL-01")!;
  assert.notEqual(control.verification, "verified", "asserted facts cannot make a control verified");
});

test("decisions and reports are signed with Ed25519 and verify with the public key alone; older HMAC signatures still verify here", async () => {
  const { signDecision, verifySignature } = await import("../src/lib/core/integrity");
  const { publicSigningKey, legacyHmac } = await import("../src/lib/core/signing");
  const { canonicalJson } = await import("../src/lib/core/integrity");
  const payload = { fingerprint: "abc", tenant: admin.tenantId };
  const signature = signDecision(payload);
  assert.match(signature, /^ed25519:/);
  assert.equal(signDecision(payload), signature, "Ed25519 is deterministic");
  const key = publicSigningKey();
  assert.equal(verifySignature(payload, signature, key.publicKeyPem), true, "a third party needs only the public key");
  assert.equal(verifySignature({ ...payload, tenant: "other" }, signature, key.publicKeyPem), false);
  assert.equal(verifySignature(payload, signature.slice(0, -4) + "AAAA", key.publicKeyPem), false);
  const stranger = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal(verifySignature(payload, signature, stranger), false, "another key does not verify it");
  const legacy = legacyHmac(canonicalJson(payload));
  assert.equal(verifySignature(payload, legacy), true, "history signed before this change stays verifiable");
  assert.equal(verifySignature(payload, legacy, key.publicKeyPem), false, "an HMAC cannot be checked by a third party");
});

test("an anchor shows that the audit chain was cut back, even though the shorter chain still verifies", { skip: process.env.KONTROL_TEST_DB === "postgres" ? "on PostgreSQL the application role cannot remove the triggers; only the owner can, which is what the anchor guards against" : false }, async () => {
  const { setImplementation } = await import("../src/lib/core/compliance-engine");
  const { createAnchor, verifyAgainstAnchors } = await import("../src/lib/core/audit-anchor");
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  const sys = (await db()).system();
  for (const code of ["UC-GOV-01", "UC-GOV-02", "UC-GOV-03"]) await setImplementation(admin, { ucCode: code, status: "implemented", maturity: 2, notes: "Attested" });

  const first = await createAnchor(admin);
  assert.equal(first.created, true);
  assert.equal(first.anchor.keyFingerprint, first.publicKey.fingerprint);
  assert.ok((await createAnchor(admin)).anchor.entries > first.anchor.entries, "anchoring is itself recorded in the chain, so each anchor covers a longer chain");
  assert.equal((await verifyAgainstAnchors(admin.tenantId)).valid, true);
  assert.equal((await verifyAgainstAnchors(admin.tenantId, [first.anchor], first.publicKey.publicKeyPem)).valid, true, "verifiable as a third party");

  // Later entries are written, a second anchor is taken, and both copies are kept outside the database.
  await setImplementation(admin, { ucCode: "UC-GOV-04", status: "implemented", maturity: 2, notes: "Attested" });
  const second = await createAnchor(admin);
  const outside = [first.anchor, second.anchor];

  // The database owner removes the newest entries and the stored anchors. Nothing inside the database objects.
  const total = (await verifyAuditChain(admin.tenantId)).checked;
  // The append-only triggers stop the application, not the database owner: here the owner removes them first.
  await sys.run("DROP TRIGGER IF EXISTS audit_no_delete");
  await sys.run("DELETE FROM audit_log WHERE tenant_id = ? AND sequence > (SELECT sequence FROM audit_log WHERE tenant_id = ? ORDER BY sequence LIMIT 1 OFFSET ?)", admin.tenantId, admin.tenantId, first.anchor.entries - 2);
  await sys.run("DELETE FROM audit_anchors WHERE tenant_id = ?", admin.tenantId);
  const cut = await verifyAuditChain(admin.tenantId);
  assert.equal(cut.valid, true, "the truncated chain is internally consistent");
  assert.ok(cut.checked < total);

  const verdict = await verifyAgainstAnchors(admin.tenantId, outside, first.publicKey.publicKeyPem);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.checks.some((check) => check.status === "chain_shorter"), "the copy held outside shows entries are missing");
  assert.match(verdict.problem ?? "", /do not match the chain/);

  const forged = { ...first.anchor, headHash: "f".repeat(64) };
  assert.equal((await verifyAgainstAnchors(admin.tenantId, [forged], first.publicKey.publicKeyPem)).checks.find((check) => check.status === "bad_signature") !== undefined, true, "an edited anchor fails its signature");
});

test("the signing key is public and the anchor API needs the right permissions", async () => {
  const { GET: keyRoute } = await import("../src/app/api/signing-key/route");
  const body = (await (await keyRoute()).json()) as { algorithm: string; publicKeyPem: string; fingerprint: string };
  assert.equal(body.algorithm, "Ed25519");
  assert.match(body.publicKeyPem, /BEGIN PUBLIC KEY/);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE/);
  const { GET, POST } = await import("../src/app/api/audit/anchor/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const call = (handler: typeof GET | typeof POST, token: string, method = "GET") => handler(new Request("http://localhost/api/audit/anchor", { method, headers: { authorization: `Bearer ${token}` }, ...(method === "POST" ? { body: "" } : {}) }));
  const viewer = await issueSessionToken({ ...admin, role: "viewer" });
  assert.equal((await call(GET, viewer)).status, 200);
  assert.equal((await call(POST, viewer, "POST")).status, 403, "a viewer cannot create anchors");
});
