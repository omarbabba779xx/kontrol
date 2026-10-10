import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import type { Actor } from "../src/lib/core/auth";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_VAULT_DIR: mkdtempSync(join(tmpdir(), "kontrol-audit-vault-")), KONTROL_SECRETS_KEY: "k".repeat(40) });

const ws = () => import("../src/lib/core/audit-workspace");
const pack = () => import("../src/lib/core/audit-pack");
const adminMod = () => import("../src/lib/core/admin");
const engine = () => import("../src/lib/core/compliance-engine");
const db = async () => (await import("../src/lib/db")).getDb();
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();

let auditor: Actor = admin; // an external auditor, set up in the first test
let engagementId = "";

const bearer = async (actor: Actor) => { const { issueSessionToken } = await import("../src/lib/core/auth"); return { authorization: `Bearer ${await issueSessionToken(actor)}` }; };
const asExternal = (id: string): Actor => ({ ...admin, userId: id, email: "auditor@firm.example", name: "Ada Auditor", role: "auditor" as const, external: true });

test("external auditors are a restricted kind of user: they must be auditors, and they can reach nothing but the audit workspace", async () => {
  const { inviteUser } = await adminMod();
  await assert.rejects(inviteUser(admin, { email: "x@firm.example", name: "Wrong Role", role: "viewer", external: true }), /must have the auditor role/);
  const created = await inviteUser(admin, { email: "auditor@firm.example", name: "Ada Auditor", role: "auditor", external: true });
  auditor = asExternal(created.id);

  const { GET: complianceGet } = await import("../src/app/api/compliance/route");
  const { GET: adminGet } = await import("../src/app/api/admin/route");
  const { GET: auditGet } = await import("../src/app/api/audit/route");
  const { GET: meGet } = await import("../src/app/api/me/route");
  const headers = await bearer(auditor);
  const call = (handler: (request: Request) => Promise<Response>, path: string) => handler(new Request(`http://localhost${path}`, { headers }));
  const denied = await call(complianceGet, "/api/compliance");
  assert.equal(denied.status, 403);
  assert.match(((await denied.json()) as { error: string }).error, /only use the audit workspace/);
  assert.equal((await call(adminGet, "/api/admin")).status, 403);
  assert.equal((await call(auditGet, "/api/audit")).status, 200);
  assert.deepEqual(await (await call(meGet, "/api/me")).json(), { userId: created.id, name: "Ada Auditor", role: "auditor", external: true, organisation: "Acme Financial Europe" });

  const { setUserRole } = await adminMod();
  await assert.rejects(setUserRole(admin, { userId: created.id, role: "viewer" }), /must keep the auditor role/);
});

test("an engagement validates its period and framework, and moves forward only", async () => {
  const { createEngagement, setEngagementStatus, listEngagements } = await ws();
  const base = { name: "SOC 2 Type II 2026", frameworkId: "soc2" as const, kind: "soc2_type2" as const, scope: "Lending platform", periodStart: iso(-60), periodEnd: iso(30), auditorOrg: "Firm LLP" };
  await assert.rejects(createEngagement(admin, { ...base, periodEnd: base.periodStart }), /end after it starts/);
  await assert.rejects(createEngagement(admin, { ...base, periodEnd: iso(500) }), /cannot exceed 400 days/);
  await assert.rejects(createEngagement(admin, { ...base, frameworkId: "nope" as never }), /not found/);
  await assert.rejects(createEngagement(admin, { ...base, leadId: "usr_nobody" }), /Lead not found/);
  engagementId = (await createEngagement(admin, { ...base, leadId: riskOwner.userId })).id;

  assert.equal((await listEngagements(admin))[0].status, "planning");
  await setEngagementStatus(admin, { id: engagementId, status: "fieldwork" });
  await assert.rejects(setEngagementStatus(admin, { id: engagementId, status: "planning" }), /forward only/);
});

test("access is granted per engagement, expires, and an engagement the auditor was not granted does not exist for them", async () => {
  const { grantAccess, revokeAccess, listEngagements, engagementDetail, createEngagement } = await ws();
  const other = await createEngagement(admin, { name: "ISO 27001 surveillance", frameworkId: "iso27001", kind: "iso27001_certification", periodStart: iso(-30), periodEnd: iso(30) });

  assert.deepEqual(await listEngagements(auditor), [], "no grant, nothing visible");
  await assert.rejects(engagementDetail(auditor, engagementId), (error: Error & { status?: number }) => error.status === 404);
  await assert.rejects(grantAccess(admin, { engagementId, userId: riskOwner.userId, days: 30 }), /Only external auditors/);
  await assert.rejects(grantAccess(admin, { engagementId, userId: auditor.userId, days: 400 }), /1 and 180 days/);

  await grantAccess(admin, { engagementId, userId: auditor.userId, days: 30 });
  assert.deepEqual((await listEngagements(auditor)).map((item) => item.id), [engagementId]);
  const detail = await engagementDetail(auditor, engagementId);
  assert.deepEqual(detail.access, [], "an external auditor never sees who else has access");
  assert.equal(detail.canManage, false);
  await assert.rejects(engagementDetail(auditor, other.id), (error: Error & { status?: number }) => error.status === 404, "same answer as a missing engagement");
  assert.equal((await listEngagements(admin)).length, 2, "internal users see every engagement");

  await (await db()).scope(admin.tenantId).run("UPDATE audit_access SET expires_at = ? WHERE engagement_id = ?", iso(-1), engagementId);
  assert.deepEqual(await listEngagements(auditor), [], "expired");
  await grantAccess(admin, { engagementId, userId: auditor.userId, days: 10 });
  assert.equal((await listEngagements(auditor)).length, 1, "re-granting renews it");
  await revokeAccess(admin, { engagementId, userId: auditor.userId });
  assert.deepEqual(await listEngagements(auditor), [], "revoked");
  await assert.rejects(revokeAccess(admin, { engagementId, userId: auditor.userId }), /No active access/);
  await grantAccess(admin, { engagementId, userId: auditor.userId, days: 60 });
});

test("requests are numbered, an auditor can raise them, and nobody accepts a response they provided", async () => {
  const { createRequest, respond, setRequestStatus, comment, engagementDetail } = await ws();
  const { attachEvidence, reviewEvidence, setImplementation } = await engine();

  const first = await createRequest(auditor, { engagementId, title: "Provide the access review for Q2", ucCode: "UC-IAM-01", assigneeId: riskOwner.userId, dueAt: iso(5) });
  const second = await createRequest(admin, { engagementId, title: "Provide the training register" });
  assert.deepEqual([first.ref, second.ref], ["PBC-001", "PBC-002"]);
  await assert.rejects(createRequest(auditor, { engagementId, title: "Bad control", ucCode: "UC-NOPE-99" }), /not found/);
  await assert.rejects(createRequest(auditor, { engagementId, title: "Bad assignee", assigneeId: auditor.userId }), /Assignee not found/);

  await assert.rejects(respond(admin, { requestId: first.id }), /note or evidence/);
  await assert.rejects(respond(admin, { requestId: first.id, evidence: { type: "control_evidence", id: "cev_missing" } }), /Evidence not found/);

  await setImplementation(admin, { ucCode: "UC-IAM-01", status: "implemented", maturity: 3, notes: "Access reviews run quarterly" });
  const upload = await attachEvidence(admin, { ucCode: "UC-IAM-01", title: "Q2 access review", kind: "report", validUntil: iso(200), note: "", file: new File(["%PDF-1.4 access review q2"], "access-review-q2.pdf", { type: "application/pdf" }) });
  await assert.rejects(respond(admin, { requestId: first.id, evidence: { type: "control_evidence", id: upload.id } }), /accepted/, "unreviewed evidence cannot be given to auditors");
  await reviewEvidence(riskOwner, { id: upload.id, accept: true, note: "Reviewed against the IdP export." });
  await respond(admin, { requestId: first.id, note: "Attached, covers April to June.", evidence: { type: "control_evidence", id: upload.id } });

  await assert.rejects(setRequestStatus(admin, { requestId: first.id, status: "accepted" }), /Separation of duties/);
  await assert.rejects(setRequestStatus(riskOwner, { requestId: first.id, status: "accepted" }), /Separation of duties/);
  await assert.rejects(setRequestStatus(auditor, { requestId: second.id, status: "accepted" }), /Only a provided response/, "nothing to accept yet");

  await comment(auditor, { requestId: first.id, body: "Please also show the leaver list." });
  await setRequestStatus(auditor, { requestId: first.id, status: "needs_more" });
  await respond(admin, { requestId: first.id, note: "Leaver list attached to the same file." });
  await setRequestStatus(auditor, { requestId: first.id, status: "accepted" });
  await assert.rejects(setRequestStatus(auditor, { requestId: first.id, status: "open" }), /already accepted/);

  const detail = await engagementDetail(auditor, engagementId);
  const row = detail.requests.find((item) => item.ref === "PBC-001")!;
  assert.equal(row.status, "accepted");
  assert.ok(row.resolved_at);
  const response = row.events.find((event) => event.kind === "response" && event.reference.type === "control_evidence")!;
  assert.equal((response.reference.hash as string).length, 64, "the hash of what was provided is recorded");
  assert.deepEqual(row.events.map((event) => event.kind), ["status", "response", "comment", "status", "response", "status"]);
});

test("generated requests follow the attested controls of the framework and are not duplicated", async () => {
  const { generateRequests } = await ws();
  const { setImplementation } = await engine();
  await setImplementation(admin, { ucCode: "UC-GOV-01", status: "implemented", maturity: 3, notes: "Policies approved" });
  await setImplementation(admin, { ucCode: "UC-OPS-05", status: "partial", maturity: 2, notes: "Logging rollout" });
  const first = await generateRequests(admin, { engagementId, limit: 10 });
  assert.ok(first.created >= 2);
  const again = await generateRequests(admin, { engagementId, limit: 10 });
  assert.equal(again.created, 0, "UC-IAM-01 already has its request, and the rest were just created");
});

test("period coverage counts healthy, failing and missing days from the evidence timeline", async () => {
  const { periodCoverage } = await ws();
  const { setImplementation } = await engine();
  const { installControlPack } = await import("../src/lib/connectors");
  await installControlPack(admin, "aws");
  await setImplementation(admin, { ucCode: "UC-OPS-05", status: "implemented", maturity: 3, notes: "CloudTrail everywhere", linkedControlCode: "CTL-AWS-005" });

  const database = (await db()).scope(admin.tenantId);
  const control = (await database.get<{ id: string }>("SELECT id FROM controls WHERE tenant_id = ? AND code = 'CTL-AWS-005'", admin.tenantId))!;
  await database.run("DELETE FROM evidence WHERE control_id = ?", control.id);
  const start = Date.now() - 20 * DAY, end = start + 30 * DAY;
  const point = async (day: number, validDays: number, status: "healthy" | "failed") => database.run("INSERT INTO evidence (id,tenant_id,control_id,asset_id,name,source,collection_method,content_type,content_json,content_hash,collected_at,expires_at,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    `ev_cov_${day}`, admin.tenantId, control.id, null, "coverage", "aws:api", "automated policy evaluation", "application/json", "{}", "h".repeat(64), new Date(start + day * DAY).toISOString(), new Date(start + (day + validDays) * DAY).toISOString(), status, admin.userId);
  await point(0, 4, "healthy");   // days 0-4 healthy
  await point(10, 3, "healthy");  // 4-10 gap, then 10-13 healthy
  await point(13, 2, "failed");   // 13-15 failing
  await point(15, 5, "healthy");  // 15-20 healthy; now is day 20, so the period is elapsed to there

  const coverage = await periodCoverage(admin.tenantId, { period_start: new Date(start).toISOString(), period_end: new Date(end).toISOString() });
  assert.equal(coverage.periodDays, 30);
  assert.ok(Math.abs(coverage.elapsedDays - 20) < 0.01);
  const item = coverage.controls.find((entry) => entry.ucCode === "UC-OPS-05")!;
  const aws = item.controls[0];
  assert.deepEqual([aws.code, aws.points, aws.failures], ["CTL-AWS-005", 4, 1]);
  assert.ok(Math.abs(aws.healthyDays - 12) < 0.05, `healthy ${aws.healthyDays}`);
  assert.ok(Math.abs(aws.failingDays - 2) < 0.05, `failing ${aws.failingDays}`);
  assert.ok(Math.abs(aws.gapDays - 6) < 0.05, `gap ${aws.gapDays}`);
  assert.ok(Math.abs(aws.longestGapDays - 6) < 0.05);
  assert.ok(Math.abs((item.effectiveness ?? 0) - 0.6) < 0.01, "12 healthy days of 20 elapsed");
});

test("the evidence pack is self-verifying: hashes, signature, the full audit chain, embedded documents and a recorded download", async () => {
  const { buildEvidencePack } = await pack();
  const { verifyAuditChainRows, sha256, signDecision, canonicalJson } = await import("../src/lib/core/integrity");
  const built = await buildEvidencePack(auditor, engagementId);
  const files = unzipSync(built.bytes);
  const names = Object.keys(files).sort();
  for (const expected of ["README.txt", "audit-log.json", "manifest.json", "period-coverage.csv", "requests.json", "compliance/soa-soc2.csv", "compliance/soa-soc2.json", "controls/UC-IAM-01.json", "controls/UC-OPS-05.json"]) assert.ok(names.includes(expected), `missing ${expected}`);
  const embedded = names.find((name) => name.startsWith("evidence/UC-IAM-01/") && name.endsWith("access-review-q2.pdf"));
  assert.ok(embedded, "the accepted document is embedded");
  assert.equal(strFromU8(files[embedded!]), "%PDF-1.4 access review q2");

  const manifest = JSON.parse(strFromU8(files["manifest.json"])) as { files: Array<{ path: string; sha256: string; bytes: number }>; manifestFingerprint: string; signature: string; generatedAt: string; auditChain: { valid: boolean; rootHash: string; entries: number }; notes: string[]; engagement: { id: string } };
  assert.equal(manifest.engagement.id, engagementId);
  for (const entry of manifest.files) { assert.equal(sha256(Buffer.from(files[entry.path])), entry.sha256, `${entry.path} matches its listed hash`); assert.equal(files[entry.path].length, entry.bytes); }
  assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), names.filter((name) => name !== "manifest.json"), "the manifest lists exactly the files in the pack");

  const { signature, manifestFingerprint, ...body } = manifest;
  assert.equal(sha256(canonicalJson(body)), manifestFingerprint);
  assert.equal(signature, await signDecision({ manifestFingerprint, tenant: admin.tenantId, generatedAt: manifest.generatedAt }));

  const rows = JSON.parse(strFromU8(files["audit-log.json"])) as Array<Record<string, unknown>>;
  const verdict = verifyAuditChainRows(rows);
  assert.equal(verdict.valid, true, "an auditor can recompute the whole chain from the file alone");
  assert.equal(verdict.rootHash, manifest.auditChain.rootHash);
  assert.ok(rows.some((row) => row.action === "audit.response_provided"));
  rows[3] = { ...rows[3], action: "tampered" };
  assert.equal(verifyAuditChainRows(rows).valid, false, "and any edit is detected");

  const coverage = strFromU8(files["period-coverage.csv"]).split("\n");
  assert.equal(coverage[0], "unified_control,executable_control,evaluations_in_period,failures,healthy_days,failing_days,days_without_evidence,longest_gap_days");
  assert.ok(coverage.some((line) => line.startsWith("UC-OPS-05,CTL-AWS-005,")));

  const events = await (await db()).scope(admin.tenantId).all<{ kind: string; reference_json: string }>("SELECT kind, reference_json FROM audit_events WHERE engagement_id = ? AND kind = 'download'", engagementId);
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].reference_json).fingerprint, manifestFingerprint);
});

test("the pack never reads outside the vault, and a file that no longer matches its hash is not embedded", async () => {
  const { buildEvidencePack } = await pack();
  const database = (await db()).scope(admin.tenantId);
  const evidence = (await database.get<{ vault_document_id: string }>("SELECT vault_document_id FROM control_evidence WHERE tenant_id = ? AND status = 'accepted' LIMIT 1", admin.tenantId))!;

  await database.run("UPDATE vault_documents SET storage_uri = ? WHERE id = ?", `local-vault://${admin.tenantId}/../../../../etc/passwd`, evidence.vault_document_id);
  let files = unzipSync((await buildEvidencePack(admin, engagementId)).bytes);
  assert.ok(!Object.keys(files).some((name) => name.startsWith("evidence/")), "a traversal path is refused");
  assert.match(strFromU8(files["manifest.json"]), /file not embedded/);

  await database.run("UPDATE vault_documents SET storage_uri = ? WHERE id = ?", `local-vault://other_tenant/x/y.pdf`, evidence.vault_document_id);
  files = unzipSync((await buildEvidencePack(admin, engagementId)).bytes);
  assert.ok(!Object.keys(files).some((name) => name.startsWith("evidence/")), "another tenant's vault is refused");
});

test("an auditor without access cannot download, and closing the engagement revokes access and freezes it", async () => {
  const { buildEvidencePack } = await pack();
  const { setEngagementStatus, createRequest, respond, comment, listEngagements } = await ws();
  const stranger = asExternal("usr_stranger");
  await (await db()).system().run("INSERT INTO users (id,tenant_id,email,name,role,created_at,status,external) VALUES (?,?,?,?,?,?,?,?)", "usr_stranger", admin.tenantId, "stranger@firm.example", "Stranger", "auditor", new Date().toISOString(), "active", 1);
  await assert.rejects(buildEvidencePack(stranger, engagementId), (error: Error & { status?: number }) => error.status === 404);

  await setEngagementStatus(admin, { id: engagementId, status: "review" });
  await setEngagementStatus(admin, { id: engagementId, status: "closed" });
  assert.deepEqual(await listEngagements(auditor), [], "closing revokes every grant");
  await assert.rejects(createRequest(admin, { engagementId, title: "Too late" }), /closed/);
  await assert.rejects(setEngagementStatus(admin, { id: engagementId, status: "review" }), /closed/);
  const request = (await (await db()).scope(admin.tenantId).get<{ id: string }>("SELECT id FROM audit_requests WHERE engagement_id = ? LIMIT 1", engagementId))!;
  await assert.rejects(respond(admin, { requestId: request.id, note: "late" }), /closed/);
  await assert.rejects(comment(admin, { requestId: request.id, body: "late comment" }), /closed/);
});

test("the workspace is chained in the audit log", async () => {
  const { verifyAuditChain } = await import("../src/lib/core/integrity");
  assert.equal((await verifyAuditChain(admin.tenantId)).valid, true);
  const actions = new Set((await (await db()).scope(admin.tenantId).all<{ action: string }>("SELECT DISTINCT action FROM audit_log WHERE tenant_id = ? AND action LIKE 'audit.%'", admin.tenantId)).map((row) => row.action));
  for (const expected of ["audit.engagement_created", "audit.access_granted", "audit.access_revoked", "audit.request_created", "audit.response_provided", "audit.request_status", "audit.engagement_status", "audit.pack_downloaded"]) assert.ok(actions.has(expected), `missing ${expected}`);
});
