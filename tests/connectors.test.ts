import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { collectAws, collectGitHub, collectOkta, nextLink, type AwsClients, type JsonResponse } from "../src/lib/connectors/collectors";
import { PACK, missingFacts } from "../src/lib/connectors/pack";
import { evaluatePolicy } from "../src/lib/core/policy-engine";
import { admin, isolateDatabase } from "./setup";

isolateDatabase();

const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "github", name), "utf8")) as Record<string, unknown>;

// Responses recorded from api.github.com for a public repository, called without a token.
const realRepo = fixture("real-public-repo.json");
const realOrg = fixture("real-org-public.json");
const realUnauthenticated = fixture("real-protection-unauthenticated.json");

type Route = JsonResponse | ((path: string) => JsonResponse);
const router = (routes: Record<string, Route>) => async (path: string): Promise<JsonResponse> => {
  const route = routes[path];
  if (!route) return { status: 404, body: { message: "Not Found" } };
  return typeof route === "function" ? route(path) : route;
};

const OPA = "/repos/open-policy-agent/opa";

test("GitHub: what an unauthenticated caller can see never turns into a failed control", async () => {
  const facts = await collectGitHub(router({
    [OPA]: { status: 200, body: realRepo },
    [`${OPA}/branches/main/protection`]: { status: 401, body: realUnauthenticated },
    [`${OPA}/vulnerability-alerts`]: { status: 401, body: realUnauthenticated },
    "/orgs/open-policy-agent": { status: 200, body: realOrg },
  }), "open-policy-agent", "opa");

  assert.equal(facts.repository, "open-policy-agent/opa");
  assert.equal(facts.defaultBranch, "main");
  assert.equal(facts.visibility, "public");
  assert.equal(facts.branchProtection, null, "401 means unknown, not unprotected");
  assert.equal(facts.vulnerabilityAlertsEnabled, null);
  assert.equal((facts.org as { twoFactorRequired: unknown }).twoFactorRequired, null, "the public org view does not expose the 2FA requirement");
  for (const control of PACK.filter((item) => item.connector === "github")) assert.ok(missingFacts(control, facts).length > 0, `${control.code} must be skipped, not failed`);
});

const protectionDocs = {
  url: "https://api.github.com/repos/o/r/branches/main/protection",
  required_pull_request_reviews: { dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 2 },
  enforce_admins: { url: "https://api.github.com/repos/o/r/branches/main/protection/enforce_admins", enabled: true },
  required_signatures: { enabled: false },
};
const adminRepo = { ...realRepo, security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" }, dependabot_security_updates: { status: "enabled" } } };

test("GitHub: an administrator token yields complete facts and every GitHub control passes", async () => {
  const facts = await collectGitHub(router({
    [OPA]: { status: 200, body: adminRepo },
    [`${OPA}/branches/main/protection`]: { status: 200, body: protectionDocs },
    [`${OPA}/vulnerability-alerts`]: { status: 204, body: null },
    "/orgs/open-policy-agent": { status: 200, body: { ...realOrg, two_factor_requirement_enabled: true } },
  }), "open-policy-agent", "opa");

  assert.deepEqual(facts.branchProtection, { enabled: true, requiredReviews: 2, enforceAdmins: true, dismissStaleReviews: true, requireCodeOwnerReviews: true, requireSignedCommits: false });
  for (const control of PACK.filter((item) => item.connector === "github")) {
    assert.deepEqual(missingFacts(control, facts), [], `${control.code} facts available`);
    assert.equal(evaluatePolicy(control.policy, facts).passed, true, `${control.code} should pass`);
  }
});

test("GitHub: documented 404 answers distinguish an unprotected branch and disabled alerts from missing access", async () => {
  const facts = await collectGitHub(router({
    [OPA]: { status: 200, body: adminRepo },
    [`${OPA}/branches/main/protection`]: { status: 404, body: { message: "Branch not protected" } },
    [`${OPA}/vulnerability-alerts`]: { status: 404, body: { message: "Vulnerability alerts are disabled." } },
  }), "open-policy-agent", "opa");
  assert.equal((facts.branchProtection as { enabled: boolean }).enabled, false);
  assert.equal(facts.vulnerabilityAlertsEnabled, false);
  const sdlc = PACK.find((control) => control.code === "CTL-SDLC-004")!;
  assert.equal(evaluatePolicy(sdlc.policy, facts).passed, false);

  const ambiguous = await collectGitHub(router({ [OPA]: { status: 200, body: adminRepo }, [`${OPA}/branches/main/protection`]: { status: 404, body: { message: "Not Found" } }, [`${OPA}/vulnerability-alerts`]: { status: 404, body: { message: "Not Found" } } }), "open-policy-agent", "opa");
  assert.equal(ambiguous.branchProtection, null);
  assert.equal(ambiguous.vulnerabilityAlertsEnabled, null);
});

test("GitHub: an unreadable repository is an error, not a verdict", async () => {
  await assert.rejects(collectGitHub(router({ [OPA]: { status: 404, body: { message: "Not Found" } } }), "open-policy-agent", "opa"), /GitHub API 404/);
});

// ---- AWS --------------------------------------------------------------------------------------------------------------
class AwsError extends Error { constructor(name: string) { super(name); this.name = name; } }

function awsClients(handlers: Record<string, (input: Record<string, unknown>) => unknown>): AwsClients {
  const client = { send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw new AwsError("AccessDenied");
    const result = handler(command.input);
    if (result instanceof Error) throw result;
    return result;
  } };
  return { iam: client, s3: client, config: client, cloudtrail: client } as unknown as AwsClients;
}

const goodAws = {
  GetAccountSummaryCommand: () => ({ SummaryMap: { AccountMFAEnabled: 1, AccountAccessKeysPresent: 0, Users: 18, MFADevices: 16 } }),
  GetAccountPasswordPolicyCommand: () => ({ PasswordPolicy: { MinimumPasswordLength: 14, PasswordReusePrevention: 24, RequireSymbols: true, RequireNumbers: true, MaxPasswordAge: 90 } }),
  ListBucketsCommand: () => ({ Buckets: [{ Name: "logs" }, { Name: "data" }] }),
  GetPublicAccessBlockCommand: () => ({ PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }),
  GetComplianceSummaryByConfigRuleCommand: () => ({ ComplianceSummary: { CompliantResourceCount: { CappedCount: 40 }, NonCompliantResourceCount: { CappedCount: 0 } } }),
  DescribeTrailsCommand: () => ({ trailList: [{ Name: "org-trail", TrailARN: "arn:aws:cloudtrail:eu-west-1:123456789012:trail/org-trail", IsMultiRegionTrail: true, LogFileValidationEnabled: true }] }),
  GetTrailStatusCommand: () => ({ IsLogging: true }),
};

test("AWS: a compliant account passes all five AWS controls", async () => {
  const facts = await collectAws(awsClients(goodAws), "eu-west-1");
  for (const control of PACK.filter((item) => item.connector === "aws")) {
    assert.deepEqual(missingFacts(control, facts), [], control.code);
    assert.equal(evaluatePolicy(control.policy, facts).passed, true, `${control.code} should pass`);
  }
});

test("AWS: weaknesses are detected from the API answers", async () => {
  const facts = await collectAws(awsClients({
    ...goodAws,
    GetAccountSummaryCommand: () => ({ SummaryMap: { AccountMFAEnabled: 0, AccountAccessKeysPresent: 2 } }),
    GetAccountPasswordPolicyCommand: () => new AwsError("NoSuchEntityException"),
    GetPublicAccessBlockCommand: (input: Record<string, unknown>) => input.Bucket === "logs" ? new AwsError("NoSuchPublicAccessBlockConfiguration") : { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: false, RestrictPublicBuckets: true } },
    GetComplianceSummaryByConfigRuleCommand: () => ({ ComplianceSummary: { CompliantResourceCount: { CappedCount: 40 }, NonCompliantResourceCount: { CappedCount: 3 } } }),
    GetTrailStatusCommand: () => ({ IsLogging: false }),
  }), "eu-west-1");
  const failing = PACK.filter((item) => item.connector === "aws").filter((control) => !evaluatePolicy(control.policy, facts).passed).map((control) => control.code);
  assert.deepEqual(failing, ["CTL-AWS-001", "CTL-AWS-002", "CTL-AWS-003", "CTL-AWS-004", "CTL-AWS-005"]);
  assert.equal((facts.s3 as { withoutPublicAccessBlock: number }).withoutPublicAccessBlock, 2);
});

test("AWS: services that cannot be read are skipped, not failed", async () => {
  const facts = await collectAws(awsClients({ GetAccountSummaryCommand: goodAws.GetAccountSummaryCommand }), "eu-west-1");
  const skipped = PACK.filter((item) => item.connector === "aws").filter((control) => missingFacts(control, facts).length > 0).map((control) => control.code);
  assert.deepEqual(skipped, ["CTL-AWS-002", "CTL-AWS-003", "CTL-AWS-004", "CTL-AWS-005"]);

  // A bucket that cannot be inspected makes the whole S3 verdict unknown rather than optimistic.
  const partial = await collectAws(awsClients({ ...goodAws, GetPublicAccessBlockCommand: (input: Record<string, unknown>) => input.Bucket === "data" ? new AwsError("AccessDenied") : goodAws.GetPublicAccessBlockCommand() }), "eu-west-1");
  assert.equal((partial.s3 as { withoutPublicAccessBlock: unknown }).withoutPublicAccessBlock, null);
});

// ---- Okta -------------------------------------------------------------------------------------------------------------
const NOW = Date.parse("2026-03-01T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function oktaRouter(overrides: Record<string, Route> = {}) {
  const calls: string[] = [];
  const routes: Record<string, Route> = {
    "/api/v1/users?limit=200&filter=status%20eq%20%22ACTIVE%22": { status: 200, body: [{ id: "u1", lastLogin: ago(2) }, { id: "u2", lastLogin: ago(120) }], link: '<https://acme.okta.com/api/v1/users?after=abc&limit=200>; rel="next"' },
    "https://acme.okta.com/api/v1/users?after=abc&limit=200": { status: 200, body: [{ id: "u3", lastLogin: null, created: ago(200) }, { id: "u4", lastLogin: ago(10) }] },
    "/api/v1/iam/assignees/users?limit=200": { status: 200, body: { value: [{ id: "a1" }, { id: "a2" }] } },
    "/api/v1/users/a1/factors": { status: 200, body: [{ factorType: "token:software:totp", status: "ACTIVE" }] },
    "/api/v1/users/a2/factors": { status: 200, body: [{ factorType: "sms", status: "PENDING_ACTIVATION" }] },
    "/api/v1/policies?type=PASSWORD": { status: 200, body: [{ status: "ACTIVE", settings: { password: { complexity: { minLength: 12 } } } }, { status: "ACTIVE", settings: { password: { complexity: { minLength: 8 } } } }, { status: "INACTIVE", settings: { password: { complexity: { minLength: 4 } } } }] },
    ...overrides,
  };
  const api = async (path: string): Promise<JsonResponse> => { calls.push(path); const route = routes[path]; if (!route) return { status: 404, body: null }; return typeof route === "function" ? route(path) : route; };
  return { api, calls };
}

test("Okta: pagination, dormant accounts, administrator MFA coverage and the weakest active password policy", async () => {
  const { api, calls } = oktaRouter();
  const facts = await collectOkta(api, "acme.okta.com", NOW);
  assert.deepEqual(facts.users, { active: 4, inactiveOver90Days: 2, truncated: false }, "u2 (120d) and u3 (never signed in, created 200d ago) are dormant");
  assert.deepEqual(facts.privileged, { total: 2, mfaEnrolled: 1, mfaCoverage: 0.5 });
  assert.deepEqual(facts.passwordPolicy, { minLength: 8, policies: 2 }, "the weakest ACTIVE policy decides");
  assert.ok(calls.includes("https://acme.okta.com/api/v1/users?after=abc&limit=200"));
  const failing = PACK.filter((item) => item.connector === "okta").filter((control) => !evaluatePolicy(control.policy, facts).passed).map((control) => control.code);
  assert.deepEqual(failing, ["CTL-OKTA-001", "CTL-OKTA-002", "CTL-OKTA-003"]);
});

test("Okta: missing privileges are skipped, and a pagination cap makes the dormant-account count unknown", async () => {
  const forbidden = oktaRouter({ "/api/v1/iam/assignees/users?limit=200": { status: 403, body: null }, "/api/v1/policies?type=PASSWORD": { status: 403, body: null } });
  const facts = await collectOkta(forbidden.api, "acme.okta.com", NOW);
  assert.equal(facts.privileged, null);
  assert.equal(facts.passwordPolicy, null);
  assert.deepEqual(PACK.filter((item) => item.connector === "okta").filter((control) => missingFacts(control, facts).length > 0).map((control) => control.code), ["CTL-OKTA-001", "CTL-OKTA-003"]);

  let page = 0;
  const endless = oktaRouter({ "/api/v1/users?limit=200&filter=status%20eq%20%22ACTIVE%22": () => ({ status: 200, body: [{ id: "x", lastLogin: ago(1) }], link: `<https://acme.okta.com/p${++page}>; rel="next"` }) });
  const routes = endless.api;
  const capped = await collectOkta(async (path) => path.startsWith("https://acme.okta.com/p") ? { status: 200, body: [{ id: "y", lastLogin: ago(1) }], link: `<https://acme.okta.com/p${++page}>; rel="next"` } : routes(path), "acme.okta.com", NOW);
  assert.equal((capped.users as { truncated: boolean }).truncated, true);
  assert.equal((capped.users as { inactiveOver90Days: unknown }).inactiveOver90Days, null);
});

test("Okta Link header parsing", () => {
  assert.equal(nextLink('<https://a/b?after=1>; rel="next", <https://a/b>; rel="self"'), "https://a/b?after=1");
  assert.equal(nextLink('<https://a/b>; rel="self"'), null);
  assert.equal(nextLink(null), null);
});

// ---- End to end through the sync functions -----------------------------------------------------------------------------
test("a sync installs the control pack, opens findings for failures and records skipped controls", async () => {
  const { syncGitHub, syncAws, syncOkta } = await import("../src/lib/connectors");
  const { getDb } = await import("../src/lib/db");

  const github = await syncGitHub(admin, { owner: "open-policy-agent", repository: "opa", assetId: "asset_repo_lending", demo: false }, router({
    [OPA]: { status: 200, body: adminRepo },
    [`${OPA}/branches/main/protection`]: { status: 404, body: { message: "Branch not protected" } },
    [`${OPA}/vulnerability-alerts`]: { status: 204, body: null },
  }));
  assert.equal(github.mode, "live");
  assert.ok(github.evaluations.find((item) => item.controlCode === "CTL-SDLC-004" && !item.passed));
  assert.deepEqual(github.skipped.map((item) => item.controlCode), ["CTL-GH-005"], "org 2FA is unreadable with this token");

  const aws = await syncAws(admin, "eu-west-1", awsClients(goodAws));
  assert.equal(aws.mode, "live");
  assert.equal(aws.evaluations.length, 5);
  assert.ok(aws.evaluations.every((item) => item.passed));

  const okta = await syncOkta(admin, oktaRouter().api);
  assert.equal(okta.evaluations.length, 3);

  const db = (await getDb()).scope(admin.tenantId);
  const codes = (await db.all<{ code: string }>("SELECT code FROM controls WHERE tenant_id = ? AND code LIKE 'CTL-%' ORDER BY code", admin.tenantId)).map((row) => row.code);
  for (const control of PACK) assert.ok(codes.includes(control.code), `${control.code} installed`);
  const open = await db.all<{ title: string }>("SELECT title FROM findings WHERE tenant_id = ? AND status = 'open'", admin.tenantId);
  assert.ok(open.some((finding) => finding.title.includes("Production branch protection")));
  assert.ok(open.some((finding) => finding.title.includes("Administrators enrolled in MFA")));
  assert.ok(!open.some((finding) => finding.title.includes("CloudTrail")));

  const { installControlPack } = await import("../src/lib/connectors");
  assert.deepEqual((await installControlPack(admin)).installed, [], "installing the pack twice changes nothing");
});

test("demo mode is clearly tagged and uses facts that satisfy the same pack", async () => {
  const { syncAws, syncOkta, syncGitHub } = await import("../src/lib/connectors");
  const { getDb } = await import("../src/lib/db");
  const github = await syncGitHub(admin, { owner: "acme", repository: "lending", assetId: "asset_repo_lending", demo: true });
  const aws = await syncAws(admin);
  const okta = await syncOkta(admin);
  assert.deepEqual([github.mode, aws.mode, okta.mode], ["demo", "demo", "demo"]);
  assert.equal(github.skipped.length, 0);
  const sources = (await (await getDb()).scope(admin.tenantId).all<{ source: string }>("SELECT DISTINCT source FROM evidence WHERE tenant_id = ?", admin.tenantId)).map((row) => row.source);
  assert.ok(sources.includes("github:demo") && sources.includes("aws:demo") && sources.includes("okta:demo"));
});
