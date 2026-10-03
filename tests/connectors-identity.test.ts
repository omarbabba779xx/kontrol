import assert from "node:assert/strict";
import { test } from "node:test";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { collectEntra, collectGitLab, collectGoogleWorkspace, type Api } from "../src/lib/connectors/collectors-identity";
import { entraAccessToken, GOOGLE_SCOPES, GOOGLE_TOKEN_URL, googleAccessToken } from "../src/lib/connectors/oauth";
import { PACK, missingFacts } from "../src/lib/connectors/pack";
import { setOutboundTransport } from "../src/lib/core/net-guard";
import { evaluatePolicy } from "../src/lib/core/policy-engine";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

const NOW = Date.parse("2026-03-01T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
type Route = { status: number; body: unknown } | ((path: string) => { status: number; body: unknown });
const router = (routes: Record<string, Route>): Api => async (path) => {
  const route = routes[path];
  if (!route) return { status: 404, body: { message: "404 Not found" } };
  return typeof route === "function" ? route(path) : route;
};
const verdict = (code: string, facts: Record<string, unknown>) => { const control = PACK.find((item) => item.code === code)!; return missingFacts(control, facts).length ? "skipped" : evaluatePolicy(control.policy, facts).passed ? "pass" : "fail"; };

// ---- Google Workspace ---------------------------------------------------------------------------------------------------
const gUser = (email: string, overrides: Record<string, unknown> = {}) => ({ primaryEmail: email, suspended: false, archived: false, isAdmin: false, isDelegatedAdmin: false, isEnrolledIn2Sv: true, isEnforcedIn2Sv: false, lastLoginTime: ago(3), creationTime: ago(400), ...overrides });
const USERS = "/users?customer=my_customer&maxResults=500&projection=basic";

test("Google Workspace: 2-Step Verification coverage, super administrators and dormant accounts from the Directory API", async () => {
  const facts = await collectGoogleWorkspace(router({
    [USERS]: { status: 200, body: { users: [gUser("a@acme.example", { isAdmin: true }), gUser("b@acme.example", { isEnrolledIn2Sv: false }), gUser("c@acme.example", { lastLoginTime: ago(120) })], nextPageToken: "p2" } },
    [`${USERS}&pageToken=p2`]: { status: 200, body: { users: [
      gUser("d@acme.example", { isAdmin: true, isEnrolledIn2Sv: false }),
      gUser("e@acme.example", { suspended: true, isEnrolledIn2Sv: false, lastLoginTime: ago(500) }),
      gUser("f@acme.example", { lastLoginTime: "1970-01-01T00:00:00.000Z", creationTime: ago(200) }),
      gUser("g@acme.example", { lastLoginTime: "1970-01-01T00:00:00.000Z", creationTime: ago(5) }),
    ] } },
  }), "acme.example", NOW);

  assert.deepEqual(facts.users, { total: 7, active: 6, enrolledIn2Sv: 4, twoStepCoverage: 4 / 6, inactiveOver90Days: 2, truncated: false }, "suspended users are out of scope; never-signed-in accounts age from creation");
  assert.deepEqual(facts.admins, { superAdmins: 2, superAdminsWithout2Sv: 1, delegatedAdmins: 0 });
  assert.deepEqual(["CTL-GWS-001", "CTL-GWS-002", "CTL-GWS-003", "CTL-GWS-004"].map((code) => verdict(code, facts)), ["fail", "fail", "fail", "pass"]);
});

test("Google Workspace: a missing privilege or a page cap yields unknown, never a passing verdict", async () => {
  const denied = await collectGoogleWorkspace(router({ [USERS]: { status: 403, body: { error: { message: "Not Authorized to access this resource/api" } } } }), "acme.example", NOW);
  assert.equal(denied.users, null);
  assert.deepEqual(["CTL-GWS-001", "CTL-GWS-002", "CTL-GWS-003", "CTL-GWS-004"].map((code) => verdict(code, denied)), ["skipped", "skipped", "skipped", "skipped"]);

  let page = 0;
  const endless = await collectGoogleWorkspace(async () => ({ status: 200, body: { users: [gUser(`u${page}@acme.example`)], nextPageToken: `p${++page}` } }), "acme.example", NOW);
  assert.equal((endless.users as { truncated: boolean }).truncated, true);
  assert.equal((endless.users as { twoStepCoverage: unknown }).twoStepCoverage, null);
  assert.equal(endless.admins, null);
});

test("Google Workspace: the access token is a signed delegation JWT, and failures leak no key material", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const pem = await exportPKCS8(privateKey);
  const serviceAccountJson = JSON.stringify({ client_email: "kontrol@project.iam.gserviceaccount.com", private_key: pem });
  let sent: { url: string; body: URLSearchParams } | undefined;
  const ok = async (url: string, init: { body: string }) => { sent = { url, body: new URLSearchParams(init.body) }; return { ok: true, status: 200, json: async () => ({ access_token: "ya29.token" }) }; };

  assert.equal(await googleAccessToken({ serviceAccountJson, adminEmail: "admin@acme.example" }, ok, 1_800_000_000), "ya29.token");
  assert.equal(sent?.url, GOOGLE_TOKEN_URL);
  assert.equal(sent?.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const { payload, protectedHeader } = await jwtVerify(sent!.body.get("assertion")!, publicKey, { audience: GOOGLE_TOKEN_URL, currentDate: new Date(1_800_000_100 * 1000) });
  assert.equal(protectedHeader.alg, "RS256");
  assert.equal(payload.iss, "kontrol@project.iam.gserviceaccount.com");
  assert.equal(payload.sub, "admin@acme.example", "impersonates the delegated administrator");
  assert.equal(payload.scope, GOOGLE_SCOPES.join(" "));
  assert.equal(Number(payload.exp) - Number(payload.iat), 3600);

  const denied = async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized_client" }) });
  await assert.rejects(googleAccessToken({ serviceAccountJson, adminEmail: "admin@acme.example" }, denied), (error: Error) => /unauthorized_client/.test(error.message) && /domain-wide delegation/.test(error.message) && !error.message.includes("PRIVATE KEY") && !error.message.includes(pem.slice(40, 80)));
});

// ---- Microsoft Entra ID -----------------------------------------------------------------------------------------------------
const REG = "/reports/authenticationMethods/userRegistrationDetails?$top=999";
const CA = "/identity/conditionalAccess/policies";
const USERS_GRAPH = "/users?$select=id,accountEnabled,userType,createdDateTime,signInActivity&$top=999";
const reg = (upn: string, mfa: boolean, extra: Record<string, unknown> = {}) => ({ userPrincipalName: upn, isMfaRegistered: mfa, isAdmin: false, userType: "member", ...extra });
const policy = (overrides: Record<string, unknown>) => ({ state: "enabled", conditions: { users: { includeUsers: ["All"] }, applications: { includeApplications: ["All"] }, clientAppTypes: ["all"] }, grantControls: { operator: "OR", builtInControls: ["mfa"] }, ...overrides });

test("Entra ID: MFA registration, Conditional Access policies and dormant members from Microsoft Graph", async () => {
  const facts = await collectEntra(router({
    [REG]: { status: 200, body: { value: [reg("a@acme.example", true, { isAdmin: true }), reg("b@acme.example", false), reg("guest@ext.example", false, { userType: "guest" })], "@odata.nextLink": "https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails?$skiptoken=2" } },
    "https://graph.microsoft.com/v1.0/reports/authenticationMethods/userRegistrationDetails?$skiptoken=2": { status: 200, body: { value: [reg("c@acme.example", true), reg("admin2@acme.example", false, { isAdmin: true })] } },
    [CA]: { status: 200, body: { value: [
      policy({}),
      policy({ state: "disabled", conditions: { users: { includeUsers: ["All"] }, applications: { includeApplications: ["All"] }, clientAppTypes: ["exchangeActiveSync", "other"] }, grantControls: { builtInControls: ["block"] } }),
      policy({ state: "enabledForReportingButNotEnforced", conditions: { users: { includeUsers: ["All"] }, applications: { includeApplications: ["All"] }, clientAppTypes: ["exchangeActiveSync", "other"] }, grantControls: { builtInControls: ["block"] } }),
    ] } },
    [USERS_GRAPH]: { status: 200, body: { value: [
      { id: "1", accountEnabled: true, userType: "Member", createdDateTime: ago(500), signInActivity: { lastSuccessfulSignInDateTime: ago(2) } },
      { id: "2", accountEnabled: true, userType: "Member", createdDateTime: ago(500), signInActivity: { lastSuccessfulSignInDateTime: ago(200) } },
      { id: "3", accountEnabled: false, userType: "Member", createdDateTime: ago(500), signInActivity: { lastSuccessfulSignInDateTime: ago(300) } },
      { id: "4", accountEnabled: true, userType: "Guest", createdDateTime: ago(500), signInActivity: { lastSuccessfulSignInDateTime: ago(300) } },
    ] } },
  }), "acme", NOW);

  assert.deepEqual(facts.mfa, { members: 4, mfaRegistered: 2, mfaCoverage: 0.5, admins: 2, adminsWithoutMfa: 1 }, "guests are out of scope");
  assert.deepEqual(facts.conditionalAccess, { policies: 3, enabledPolicies: 1, mfaForAllUsers: true, legacyAuthBlocked: false }, "report-only and disabled policies do not count");
  assert.deepEqual(facts.users, { enabled: 2, inactiveOver90Days: 1, truncated: false });
  assert.deepEqual(["CTL-ENTRA-001", "CTL-ENTRA-002", "CTL-ENTRA-003", "CTL-ENTRA-004"].map((code) => verdict(code, facts)), ["fail", "pass", "fail", "fail"]);
});

test("Entra ID: without AuditLog or Reports permissions the affected facts are unknown", async () => {
  const facts = await collectEntra(router({
    [REG]: { status: 403, body: { error: { code: "Authorization_RequestDenied" } } },
    [CA]: { status: 200, body: { value: [] } },
    [USERS_GRAPH]: { status: 200, body: { value: [{ id: "1", accountEnabled: true, userType: "Member", createdDateTime: ago(900) }] } },
  }), "acme", NOW);
  assert.equal(facts.mfa, null);
  assert.deepEqual(facts.conditionalAccess, { policies: 0, enabledPolicies: 0, mfaForAllUsers: false, legacyAuthBlocked: false });
  assert.equal((facts.users as { inactiveOver90Days: unknown }).inactiveOver90Days, null, "no signInActivity property means unknown, not zero dormant accounts");
  assert.deepEqual(["CTL-ENTRA-001", "CTL-ENTRA-004"].map((code) => verdict(code, facts)), ["skipped", "skipped"]);
  assert.equal(verdict("CTL-ENTRA-002", facts), "fail", "an empty policy list is a real finding");
});

test("Entra ID: the client-credentials request is well formed and errors name the cause without the secret", async () => {
  let sent: { url: string; body: URLSearchParams } | undefined;
  const ok = async (url: string, init: { body: string }) => { sent = { url, body: new URLSearchParams(init.body) }; return { ok: true, status: 200, json: async () => ({ access_token: "eyJ.graph" }) }; };
  const credentials = { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", clientSecret: "super-secret-value-123" };
  assert.equal(await entraAccessToken(credentials, ok), "eyJ.graph");
  assert.equal(sent?.url, "https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/oauth2/v2.0/token");
  assert.equal(sent?.body.get("grant_type"), "client_credentials");
  assert.equal(sent?.body.get("scope"), "https://graph.microsoft.com/.default");
  await assert.rejects(entraAccessToken(credentials, async () => ({ ok: false, status: 401, json: async () => ({ error: "invalid_client" }) })), (error: Error) => /invalid_client/.test(error.message) && !error.message.includes(credentials.clientSecret));
});

// ---- GitLab ---------------------------------------------------------------------------------------------------------------------
const PROJECT = "/projects/acme%2Flending";
const project = { id: 42, path_with_namespace: "acme/lending", default_branch: "main", visibility: "private", archived: false, namespace: { kind: "group", full_path: "acme" } };

test("GitLab: branch protection, approvals and group two-factor requirement", async () => {
  const facts = await collectGitLab(router({
    [PROJECT]: { status: 200, body: project },
    "/projects/42/protected_branches/main": { status: 200, body: { name: "main", push_access_levels: [{ access_level: 0 }], merge_access_levels: [{ access_level: 40 }], allow_force_push: false, code_owner_approval_required: true } },
    "/projects/42/approvals": { status: 200, body: { approvals_before_merge: 2 } },
    "/groups/acme": { status: 200, body: { require_two_factor_authentication: true, two_factor_grace_period: 48 } },
  }), "acme/lending");
  assert.deepEqual(facts.branchProtection, { enabled: true, developersCanPush: false, forcePushAllowed: false, codeOwnerApprovalRequired: true, requiredReviews: 2 });
  assert.deepEqual(facts.group, { twoFactorRequired: true });
  assert.deepEqual(["CTL-GL-001", "CTL-GL-002", "CTL-GL-003"].map((code) => verdict(code, facts)), ["pass", "pass", "pass"]);
});

test("GitLab: an unprotected branch is a finding, but unreadable approvals and group settings are unknown", async () => {
  const facts = await collectGitLab(router({
    [PROJECT]: { status: 200, body: project },
    "/projects/42/protected_branches/main": { status: 404, body: { message: "404 Not found" } },
    "/projects/42/approvals": { status: 403, body: { message: "403 Forbidden" } },
    "/groups/acme": { status: 200, body: { name: "acme" } },
  }), "acme/lending");
  assert.equal((facts.branchProtection as { enabled: boolean }).enabled, false);
  assert.deepEqual(["CTL-GL-001", "CTL-GL-002", "CTL-GL-003"].map((code) => verdict(code, facts)), ["fail", "fail", "skipped"], "no approvals on an unprotected branch counts as zero; the group flag is simply not visible to this token");
  await assert.rejects(collectGitLab(router({ [PROJECT]: { status: 404, body: { message: "404 Project Not Found" } } }), "acme/lending"), /GitLab API 404/);
});

// ---- End to end through the sync functions, with encrypted stored credentials and a stubbed network ---------------------------------
test("a sync with stored credentials uses them, installs the pack and stores evidence; without them it runs in demo mode", async () => {
  const { syncGoogleWorkspace, syncEntra, syncGitLab, syncConnector, installControlPack } = await import("../src/lib/connectors");
  const { saveCredentials } = await import("../src/lib/core/credentials");
  const { getDb } = await import("../src/lib/db");

  const demo = await syncGoogleWorkspace(admin);
  assert.equal(demo.mode, "demo");
  assert.ok(demo.evaluations.length >= 3);
  assert.equal((await syncEntra(admin)).mode, "demo");
  assert.equal((await syncGitLab(admin, { project: "acme/lending", demo: true })).mode, "demo");

  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  await saveCredentials(admin, "google_workspace", { serviceAccountJson: JSON.stringify({ client_email: "k@p.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey) }), adminEmail: "admin@acme.example" });

  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString(); // the sync judges dormancy against the real clock
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  setOutboundTransport((url, init) => globalThis.fetch(url, init as RequestInit));
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === GOOGLE_TOKEN_URL) return new Response(JSON.stringify({ access_token: "ya29.live" }), { status: 200 });
    if (url.startsWith("https://admin.googleapis.com/admin/directory/v1/users")) return new Response(JSON.stringify({ users: [gUser("a@acme.example", { isAdmin: true, lastLoginTime: recent, creationTime: recent }), gUser("b@acme.example", { isAdmin: true, lastLoginTime: recent, creationTime: recent })] }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const live = await syncConnector(admin, "google_workspace");
    assert.equal(live.mode, "live");
    assert.ok(calls[0] === GOOGLE_TOKEN_URL && calls[1].startsWith("https://admin.googleapis.com/"), "token exchange first, then the Directory API");
    assert.deepEqual(live.evaluations.map((item) => [item.controlCode, item.passed]), [["CTL-GWS-001", true], ["CTL-GWS-002", true], ["CTL-GWS-003", true], ["CTL-GWS-004", true]]);
  } finally { globalThis.fetch = realFetch; setOutboundTransport(null); }

  const sources = (await (await getDb()).scope(admin.tenantId).all<{ source: string }>("SELECT DISTINCT source FROM evidence WHERE tenant_id = ?", admin.tenantId)).map((row) => row.source);
  assert.ok(sources.includes("google_workspace:demo") && sources.includes("google_workspace:api"));
  assert.deepEqual((await installControlPack(admin)).installed.filter((code) => code.startsWith("CTL-GWS")), [], "controls were installed by the sync");
});

test("connection tests answer plainly and never echo a secret", async () => {
  const { testConnection } = await import("../src/lib/connectors");
  const { saveCredentials } = await import("../src/lib/core/credentials");
  assert.deepEqual((await testConnection(admin, "gitlab")).ok, false);
  const token = "glpat-" + "S".repeat(24);
  await saveCredentials(admin, "gitlab", { baseUrl: "https://gitlab.example.com", token });

  const realFetch = globalThis.fetch;
  try {
    setOutboundTransport((url, init) => globalThis.fetch(url, init as RequestInit));
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { assert.equal((init?.headers as Record<string, string>)["PRIVATE-TOKEN"], token); return new Response(JSON.stringify({ username: "kontrol-bot" }), { status: 200 }); }) as typeof fetch;
    const ok = await testConnection(admin, "gitlab");
    assert.equal(ok.ok, true);
    assert.match(ok.detail, /kontrol-bot/);

    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const bad = await testConnection(admin, "gitlab");
    assert.equal(bad.ok, false);
    assert.ok(!JSON.stringify(bad).includes(token));
  } finally { globalThis.fetch = realFetch; setOutboundTransport(null); }
});
