import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const connectors = () => import("../src/lib/connectors");
const trail = () => import("../src/lib/core/evidence-trail");
const db = async () => (await import("../src/lib/db")).getDb();

type Route = { status: number; body: unknown };
const api = (routes: Record<string, Route>) => async (path: string): Promise<Route> => routes[path] ?? { status: 404, body: { message: "Not Found" } };
const BASE = "/repos/jane/repo";
const repo = (extra: Record<string, unknown> = {}) => ({ full_name: "jane/repo", default_branch: "main", visibility: "private", archived: false, owner: { type: "User" }, ...extra });
const protectedBranch = { status: 200, body: { required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true }, enforce_admins: { enabled: true } } };
const readable = { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" }, dependabot_security_updates: { status: "enabled" } };

test("evidence carries its provenance inside the hashed content: collector, rule, scope, period, expiry and what could not be read", async () => {
  const { syncGitHub } = await connectors();
  const { COLLECTOR_REVISIONS } = await import("../src/lib/connectors/pack");
  const { canonicalJson, sha256 } = await import("../src/lib/core/integrity");
  await syncGitHub(admin, { owner: "jane", repository: "repo", demo: false }, api({ [BASE]: { status: 200, body: repo({ security_and_analysis: undefined }) }, [`${BASE}/branches/main/protection`]: protectedBranch, [`${BASE}/vulnerability-alerts`]: { status: 204, body: null } }));
  const sys = (await db()).system();
  const row = (await sys.get<{ id: string; content_json: string; content_hash: string; expires_at: string }>("SELECT e.* FROM evidence e JOIN controls c ON c.id = e.control_id WHERE c.code = 'CTL-SDLC-004' ORDER BY e.collected_at DESC LIMIT 1"))!;
  const content = JSON.parse(row.content_json) as { provenance: { tenantId: string; source: string; collector: unknown; rule: { policySha256: string }; scope: { repository: string }; asset: { id: string }; collectedAt: string; expiresAt: string; limits: string[] } };
  const policy = JSON.parse((await sys.get<{ policy_json: string }>("SELECT policy_json FROM controls WHERE code = 'CTL-SDLC-004'"))!.policy_json);
  assert.equal(content.provenance.tenantId, admin.tenantId);
  assert.equal(content.provenance.source, "github:api");
  assert.deepEqual(content.provenance.collector, { name: "github", version: COLLECTOR_REVISIONS.github });
  assert.equal(content.provenance.rule.policySha256, sha256(canonicalJson(policy)), "the exact rule that was evaluated is identified");
  assert.equal(content.provenance.scope.repository, "jane/repo");
  assert.equal(content.provenance.asset.id, "asset_repo_jane_repo");
  assert.equal(content.provenance.collectedAt <= content.provenance.expiresAt, true);
  assert.equal(content.provenance.expiresAt, row.expires_at);
  assert.ok(content.provenance.limits.includes("could not read security.secretScanning"), "the limits of the collection are part of the evidence");
  assert.equal(sha256(row.content_json), row.content_hash);
});

test("a control that could not be evaluated is unknown, with the reason; reading it later clears the gap", async () => {
  const { syncGitHub } = await connectors();
  const { evidenceTrail } = await trail();
  const first = await evidenceTrail(admin.tenantId, { controlCode: "CTL-GH-002" });
  assert.equal(first.records.length, 0, "nothing was evidenced");
  assert.equal(first.current[0].outcome, "unknown");
  assert.match(first.current[0].reason, /could not read security\.secretScanning/);
  assert.equal(first.gaps[0].kind, "skipped");

  const twoFactor = await evidenceTrail(admin.tenantId, { controlCode: "CTL-GH-005" });
  assert.equal(twoFactor.current[0].outcome, "not_applicable");
  assert.match(twoFactor.current[0].reason, /personal account/);

  await syncGitHub(admin, { owner: "jane", repository: "repo", demo: false }, api({ [BASE]: { status: 200, body: repo({ security_and_analysis: readable }) }, [`${BASE}/branches/main/protection`]: protectedBranch, [`${BASE}/vulnerability-alerts`]: { status: 204, body: null } }));
  const after = await evidenceTrail(admin.tenantId, { controlCode: "CTL-GH-002" });
  assert.equal(after.gaps.length, 0);
  assert.equal(after.current[0].outcome, "compliant");
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].integrity, "verified");
  assert.equal(after.records[0].provenanceRecorded, true);
  assert.equal(after.records[0].collector?.name, "github");
});

test("expired evidence is stale, not compliant; a later failed collection is an error that keeps the older evidence in view", async () => {
  const { evidenceTrail, outcomeOf } = await trail();
  const sys = (await db()).system();
  assert.equal(outcomeOf("healthy", new Date(Date.now() + 1000).toISOString()), "compliant");
  assert.equal(outcomeOf("healthy", new Date(Date.now() - 1000).toISOString()), "stale");
  assert.equal(outcomeOf("failed", new Date(Date.now() - 1000).toISOString()), "stale", "an expired failure says nothing about today either");
  assert.equal(outcomeOf("failed", new Date(Date.now() + 1000).toISOString()), "non_compliant");

  await sys.run("UPDATE evidence SET expires_at = ? WHERE control_id = (SELECT id FROM controls WHERE code = 'CTL-SDLC-004')", new Date(Date.now() - 60_000).toISOString());
  assert.equal((await evidenceTrail(admin.tenantId, { controlCode: "CTL-SDLC-004" })).current[0].outcome, "stale");
  await sys.run("UPDATE evidence SET expires_at = ? WHERE control_id = (SELECT id FROM controls WHERE code = 'CTL-SDLC-004')", new Date(Date.now() + 86_400_000).toISOString());
  assert.equal((await evidenceTrail(admin.tenantId, { controlCode: "CTL-SDLC-004" })).current[0].outcome, "compliant");

  await sys.run("INSERT INTO job_runs (id,tenant_id,schedule_id,kind,target,trigger,started_at,finished_at,status,summary_json,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)", "run_err", admin.tenantId, "sched_x", "github", "jane/repo", "schedule", new Date(Date.now() + 1000).toISOString(), new Date(Date.now() + 2000).toISOString(), "failed", "{}", "GitHub API 401 reading jane/repo");
  const errored = await evidenceTrail(admin.tenantId, { controlCode: "CTL-SDLC-004" });
  assert.equal(errored.current[0].outcome, "error");
  assert.match(errored.current[0].reason, /401/);
  assert.ok(errored.records.length > 0, "the older evidence is still shown");
});

test("evidence altered after collection is reported as altered and its content is withheld", async () => {
  const { evidenceTrail, evidenceRecord } = await trail();
  const sys = (await db()).system();
  const before = await evidenceTrail(admin.tenantId, { controlCode: "CTL-GH-004" });
  assert.equal(before.integrity.altered, 0);
  const id = before.records[0].id;
  assert.equal((await evidenceRecord(admin.tenantId, id)).integrity, "verified");
  const full = await evidenceRecord(admin.tenantId, id);
  assert.ok(full.content && full.control?.code === "CTL-GH-004");

  const row = (await sys.get<{ content_json: string }>("SELECT content_json FROM evidence WHERE id = ?", id))!;
  await sys.run("UPDATE evidence SET content_json = ? WHERE id = ?", row.content_json.replace('"passed":true', '"passed":false').replace("true", "false"), id);
  const after = await evidenceTrail(admin.tenantId, { controlCode: "CTL-GH-004" });
  assert.equal(after.integrity.altered, 1);
  assert.equal(after.records.find((record) => record.id === id)?.integrity, "altered");
  const record = await evidenceRecord(admin.tenantId, id);
  assert.equal(record.content, null);
  assert.match(record.warning ?? "", /must not be relied on/);
});

test("sample evidence is labelled, a finding links back to its evidence, and other tenants see nothing", async () => {
  const { syncGitHub } = await connectors();
  const { evidenceTrail, evidenceRecord } = await trail();
  await syncGitHub(admin, { owner: "acme", repository: "demo", demo: true });
  const sample = await evidenceTrail(admin.tenantId, { controlCode: "CTL-SDLC-004" });
  assert.ok(sample.records.some((record) => record.sample));
  const failing = sample.records.find((record) => record.outcome === "non_compliant");
  if (failing) assert.ok((await evidenceRecord(admin.tenantId, failing.id)).findings.length >= 1, "the finding points at the evidence that opened it");
  await assert.rejects(evidenceTrail("tenant_other", { controlCode: "CTL-NOPE-1" }), /not found/);
  await assert.rejects(evidenceRecord("tenant_other", sample.records[0].id), /not found/);
  const other = await evidenceTrail("tenant_other", { controlCode: "CTL-SDLC-004" }).catch(() => null);
  assert.ok(other === null || other.records.length === 0);
});

test("the API serves the trail to readers of evidence and rejects a malformed control code", async () => {
  const { GET } = await import("../src/app/api/evidence-trail/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const call = async (path: string, token?: string) => GET(new Request(`http://localhost${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  const viewer = await issueSessionToken({ ...admin, role: "viewer" });
  assert.equal((await call("/api/evidence-trail?control=CTL-GH-004", viewer)).status, 200);
  assert.equal((await call("/api/evidence-trail?control=;drop", viewer)).status, 400);
});
