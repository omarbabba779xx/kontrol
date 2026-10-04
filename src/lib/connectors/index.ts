import "server-only";

import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { IAMClient } from "@aws-sdk/client-iam";
import { S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { Actor } from "@/lib/core/auth";
import { loadCredentials, type CredentialKind } from "@/lib/core/credentials";
import { userError } from "@/lib/core/errors";
import { getDb } from "@/lib/db";
import { appendAudit, canonicalJson, sha256 } from "@/lib/core/integrity";
import { assertPublicHttpsUrl, safeFetch } from "@/lib/core/net-guard";
import { evaluateControl } from "@/lib/core/policy-engine";
import {
  collectAws,
  collectGitHub,
  collectOkta,
  type AwsClients,
  type Facts,
  type GitHubApi,
  type JsonResponse,
  type OktaApi,
} from "@/lib/connectors/collectors";
import { collectEntra, collectGitLab, collectGoogleWorkspace, type Api } from "@/lib/connectors/collectors-identity";
import { entraAccessToken, googleAccessToken } from "@/lib/connectors/oauth";
import { COLLECTOR_REVISIONS, PACK, collectionLimits, decidedFailure, missingFacts, type ConnectorKind } from "@/lib/connectors/pack";
import { randomUUID } from "node:crypto";

type Evaluation = Awaited<ReturnType<typeof evaluateControl>>;

export type ConnectorSyncResult = {
  connector: ConnectorKind;
  mode: "live" | "demo";
  collectedAt: string;
  facts: Facts;
  /** First evaluation, kept for callers written before the control pack existed. */
  evaluation?: Evaluation;
  evaluations: Array<{ controlCode: string; passed: boolean; finding: Evaluation["finding"] }>;
  /** Controls not evaluated because a required fact could not be read, with the missing paths. */
  skipped: Array<{ controlCode: string; missing: string[] }>;
  /** Controls with no object for this target (for example an organisation control on a personal account): not a gap, not a failure. */
  notApplicable?: Array<{ controlCode: string; reason: string }>;
};

type Asset = { id: string; type: string; name: string };
const ASSETS: Record<Exclude<ConnectorKind, "github" | "gitlab">, Asset> = {
  people: { id: "asset_workforce", type: "workforce", name: "Workforce" },
  aws: { id: "asset_aws_account", type: "cloud_account", name: "AWS account" },
  okta: { id: "asset_okta_org", type: "identity_provider", name: "Okta organisation" },
  google_workspace: { id: "asset_google_workspace", type: "identity_provider", name: "Google Workspace domain" },
  entra: { id: "asset_entra_tenant", type: "identity_provider", name: "Microsoft Entra ID tenant" },
};

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);

/** Inserts the executable controls of the pack that this tenant does not have yet. Idempotent. */
export async function installControlPack(actor: Actor, connector?: ConnectorKind) {
  const db = (await getDb()).scope(actor.tenantId);
  const now = new Date().toISOString();
  const installed: string[] = [];
  await db.transaction(async (tx) => {
    for (const control of PACK.filter((item) => !connector || item.connector === connector)) {
      const existing = await tx.get("SELECT id FROM controls WHERE tenant_id = ? AND code = ?", actor.tenantId, control.code);
      if (existing) continue;
      await tx.run(
        `INSERT INTO controls (id,tenant_id,code,title,objective,owner_id,automation,frequency,policy_json,status,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        `control_${control.code.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        actor.tenantId,
        control.code,
        control.title,
        control.objective,
        null,
        "automated",
        control.frequency,
        JSON.stringify(control.policy),
        "unverified",
        now,
        now,
      );
      installed.push(control.code);
    }
    if (installed.length)
      await appendAudit(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "controls.pack_installed",
          objectType: "tenant",
          objectId: actor.tenantId,
          payload: { controls: installed },
        },
        tx,
      );
  });
  return { installed };
}

async function ensureAsset(actor: Actor, asset: Asset) {
  const db = (await getDb()).scope(actor.tenantId);
  if (await db.get("SELECT id FROM assets WHERE tenant_id = ? AND id = ?", actor.tenantId, asset.id)) return;
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO assets (id,tenant_id,type,name,criticality,owner_id,attributes_json,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    asset.id,
    actor.tenantId,
    asset.type,
    asset.name,
    "high",
    null,
    JSON.stringify({ managedBy: "kontrol-connector" }),
    now,
    now,
  );
}

async function runPack(actor: Actor, connector: ConnectorKind, facts: Facts, assetId: string, source: string) {
  await installControlPack(actor, connector);
  const evaluations: ConnectorSyncResult["evaluations"] = [];
  const skipped: ConnectorSyncResult["skipped"] = [];
  const notApplicable: NonNullable<ConnectorSyncResult["notApplicable"]> = [];
  let first: Evaluation | undefined;
  const provenance = {
    collector: { name: connector, version: COLLECTOR_REVISIONS[connector] ?? "unversioned" },
    scope: {
      target: assetId,
      repository: typeof facts.repository === "string" ? facts.repository : undefined,
      visibility: typeof facts.visibility === "string" ? facts.visibility : undefined,
    },
    limits: collectionLimits(connector, facts),
  };
  for (const control of PACK.filter((item) => item.connector === connector)) {
    const reason = control.notApplicable?.(facts) ?? null;
    if (reason) {
      notApplicable.push({ controlCode: control.code, reason });
      continue;
    }
    const missing = missingFacts(control, facts);
    // Unreadable is not failed, but a known failing condition already settles an `all` policy.
    if (missing.length && !decidedFailure(control, facts)) {
      skipped.push({ controlCode: control.code, missing });
      continue;
    }
    const result = await evaluateControl(actor, {
      controlCode: control.code,
      assetId,
      facts,
      source,
      validForDays: control.validForDays,
      provenance,
    });
    first ??= result;
    evaluations.push({ controlCode: control.code, passed: result.passed, finding: result.finding });
  }
  await recordGaps(
    actor,
    connector,
    assetId,
    source,
    skipped,
    notApplicable,
    evaluations.map((item) => item.controlCode),
  );
  if (!source.endsWith(":demo")) await supersedeSampleFindings(actor, connector, assetId);
  return { evaluations, skipped, notApplicable, first };
}

/**
 * Keeps what a collection could not do visible: a control skipped for lack of access is neither compliant nor failing, it is unknown,
 * and the reason has to be somewhere an auditor can find it. A control that is evaluated later clears its gap.
 */
async function recordGaps(
  actor: Actor,
  connector: ConnectorKind,
  assetId: string,
  source: string,
  skipped: ConnectorSyncResult["skipped"],
  notApplicable: NonNullable<ConnectorSyncResult["notApplicable"]>,
  evaluated: string[],
) {
  const db = (await getDb()).scope(actor.tenantId);
  const at = new Date().toISOString();
  const gaps = [
    ...skipped.map((item) => ({ code: item.controlCode, kind: "skipped", detail: { missing: item.missing } })),
    ...notApplicable.map((item) => ({ code: item.controlCode, kind: "not_applicable", detail: { reason: item.reason } })),
  ];
  await db.transaction(async (tx) => {
    for (const code of [...evaluated, ...gaps.map((gap) => gap.code)])
      await tx.run("DELETE FROM evidence_gaps WHERE tenant_id = ? AND asset_id = ? AND control_code = ?", actor.tenantId, assetId, code);
    for (const gap of gaps)
      await tx.run(
        "INSERT INTO evidence_gaps (id,tenant_id,connector,asset_id,control_code,kind,detail_json,source,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
        `gap_${randomUUID()}`,
        actor.tenantId,
        connector,
        assetId,
        gap.code,
        gap.kind,
        JSON.stringify(gap.detail),
        source,
        at,
      );
  });
}

/** A live collection replaces sample findings for the same asset: they described invented facts and must not stay open beside real ones. */
async function supersedeSampleFindings(actor: Actor, connector: ConnectorKind, assetId: string) {
  const db = (await getDb()).scope(actor.tenantId);
  const stale = await db.all<{ id: string }>(
    "SELECT id FROM findings WHERE tenant_id = ? AND asset_id = ? AND status IN ('open','remediating') AND evidence_id IN (SELECT id FROM evidence WHERE tenant_id = ? AND source = ?)",
    actor.tenantId,
    assetId,
    actor.tenantId,
    `${connector}:demo`,
  );
  if (!stale.length) return;
  await db.transaction(async (tx) => {
    const at = new Date().toISOString();
    for (const item of stale)
      await tx.run("UPDATE findings SET status = 'closed', closed_at = ? WHERE tenant_id = ? AND id = ?", at, actor.tenantId, item.id);
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "findings.sample_superseded",
        objectType: "asset",
        objectId: assetId,
        payload: { connector, closed: stale.length },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------- GitHub ------------------------------------------------

/** Exported for tests of the transport itself (quota handling). */
export const githubApiFor = (token: string) => githubApi(token);

function githubApi(token: string): GitHubApi {
  return async (path) => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    // An exhausted quota is not "the setting is unreadable": stop the collection and say when it can run again, so nothing is
    // recorded as unknown or failing because of it.
    if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      throw new Error(`GitHub API rate limit reached${Number.isFinite(reset) && reset > 0 ? `; it resets at ${new Date(reset * 1000).toISOString()}` : ""}`);
    }
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body };
  };
}

function demoGitHubFacts(owner: string, repository: string): Facts {
  return {
    production: true,
    repository: `${owner}/${repository}`,
    defaultBranch: "main",
    visibility: "private",
    archived: false,
    branchProtection: {
      enabled: false,
      requiredReviews: 0,
      enforceAdmins: false,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      requireSignedCommits: false,
    },
    security: { secretScanning: "enabled", pushProtection: "disabled", dependabotSecurityUpdates: "enabled" },
    vulnerabilityAlertsEnabled: true,
    alerts: { openSecrets: 0, openHighVulnerabilities: 2, openHighCode: 0 },
    codeScanning: { enabled: true },
    actions: { defaultWorkflowPermissions: "write", canApprovePullRequests: false },
    access: { outsideAdmins: 0, writableDeployKeys: 1, insecureWebhooks: 0 },
    files: { securityPolicy: true, codeOwners: false },
    org: { twoFactorRequired: true },
  };
}

export async function syncGitHub(
  actor: Actor,
  input: { owner: string; repository: string; assetId?: string; demo: boolean },
  api?: GitHubApi,
): Promise<ConnectorSyncResult> {
  const token = (await loadCredentials(actor.tenantId, "github"))?.token ?? process.env.GITHUB_TOKEN;
  const useDemo = !api && (input.demo || !token);
  const assetId = input.assetId ?? `asset_repo_${slug(`${input.owner}_${input.repository}`)}`;
  await ensureAsset(actor, { id: assetId, type: "repository", name: `${input.owner}/${input.repository}` });
  const facts = useDemo
    ? demoGitHubFacts(input.owner, input.repository)
    : await collectGitHub(api ?? githubApi(token!), input.owner, input.repository);
  const { evaluations, skipped, notApplicable, first } = await runPack(
    actor,
    "github",
    facts,
    assetId,
    useDemo ? "github:demo" : "github:api",
  );
  await updateConnector(actor, "github", useDemo ? "demo" : "healthy", facts);
  return {
    connector: "github",
    mode: useDemo ? "demo" : "live",
    collectedAt: new Date().toISOString(),
    facts,
    evaluation: first,
    evaluations,
    skipped,
    notApplicable,
  };
}

// ---------------------------------------------------------------- GitLab ------------------------------------------------

function gitlabApi(baseUrl: string, token: string): Api {
  const origin = assertPublicHttpsUrl(baseUrl).origin;
  return async (path) => {
    const response = await safeFetch(`${origin}/api/v4${path}`, {
      headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

function demoGitLabFacts(project: string): Facts {
  return {
    production: true,
    repository: project,
    defaultBranch: "main",
    visibility: "private",
    archived: false,
    branchProtection: {
      enabled: true,
      developersCanPush: false,
      forcePushAllowed: false,
      codeOwnerApprovalRequired: false,
      requiredReviews: 0,
    },
    group: { twoFactorRequired: true },
  };
}

export async function syncGitLab(
  actor: Actor,
  input: { project: string; assetId?: string; demo: boolean },
  api?: Api,
): Promise<ConnectorSyncResult> {
  const stored = await loadCredentials(actor.tenantId, "gitlab");
  const useDemo = !api && (input.demo || !stored);
  const assetId = input.assetId ?? `asset_repo_${slug(input.project)}`;
  await ensureAsset(actor, { id: assetId, type: "repository", name: input.project });
  const facts = useDemo
    ? demoGitLabFacts(input.project)
    : await collectGitLab(api ?? gitlabApi(stored!.baseUrl, stored!.token), input.project, stored?.group);
  const { evaluations, skipped, notApplicable } = await runPack(actor, "gitlab", facts, assetId, useDemo ? "gitlab:demo" : "gitlab:api");
  await persistConnectorEvidence(actor, "gitlab", `GitLab project posture (${input.project})`, facts, useDemo);
  await updateConnector(actor, "gitlab", useDemo ? "demo" : "healthy", facts);
  return {
    connector: "gitlab",
    mode: useDemo ? "demo" : "live",
    collectedAt: new Date().toISOString(),
    facts,
    evaluations,
    skipped,
    notApplicable,
  };
}

// ---------------------------------------------------------------- AWS ---------------------------------------------------

function demoAwsFacts(region: string): Facts {
  return {
    region,
    root: { mfaEnabled: true, accessKeysPresent: 0, users: 18, mfaDevices: 16 },
    passwordPolicy: { exists: true, minimumLength: 14, reusePrevention: 24, maxPasswordAge: 0, requireSymbols: true, requireNumbers: true },
    s3: { buckets: 12, withoutPublicAccessBlock: 1, unchecked: 0 },
    config: { compliantResources: 42, nonCompliantResources: 3 },
    cloudTrail: { trails: 1, multiRegionTrails: 1, logging: true, logValidation: true },
  };
}

type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

function awsClients(region: string, credentials?: AwsCredentials): AwsClients {
  const common = credentials ? { region, credentials } : { region };
  return {
    iam: new IAMClient(common),
    s3: new S3Client(common),
    config: new ConfigServiceClient(common),
    cloudtrail: new CloudTrailClient(common),
  } as unknown as AwsClients;
}

export async function syncAws(
  actor: Actor,
  region = process.env.AWS_REGION ?? "eu-west-1",
  clients?: AwsClients,
): Promise<ConnectorSyncResult> {
  const stored = await loadCredentials(actor.tenantId, "aws");
  const demo = !clients && !stored && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE;
  const effectiveRegion = stored?.region ?? region;
  const facts = demo
    ? demoAwsFacts(effectiveRegion)
    : await collectAws(clients ?? awsClients(effectiveRegion, stored ?? undefined), effectiveRegion);
  await ensureAsset(actor, ASSETS.aws);
  const { evaluations, skipped } = await runPack(actor, "aws", facts, ASSETS.aws.id, demo ? "aws:demo" : "aws:api");
  await persistConnectorEvidence(actor, "aws", "AWS configuration and IAM posture", facts, demo);
  await updateConnector(actor, "aws", demo ? "demo" : "healthy", facts);
  return { connector: "aws", mode: demo ? "demo" : "live", collectedAt: new Date().toISOString(), facts, evaluations, skipped };
}

// ---------------------------------------------------------------- Okta --------------------------------------------------

function oktaApi(baseUrl: string, token: string): OktaApi {
  const origin = assertPublicHttpsUrl(baseUrl).origin;
  return async (path): Promise<JsonResponse> => {
    // Pagination links come from the API response; they must stay on the same origin as the configured base URL.
    const url = path.startsWith("http") ? new URL(path) : new URL(path, origin);
    if (url.origin !== origin) throw new Error("Okta pagination link points to a different origin");
    const response = await safeFetch(url, {
      headers: { Authorization: `SSWS ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json().catch(() => null), link: response.headers.get("link") };
  };
}

function demoOktaFacts(): Facts {
  return {
    organization: "demo",
    users: { active: 126, inactiveOver90Days: 2, truncated: false },
    privileged: { total: 9, mfaEnrolled: 8, mfaCoverage: 8 / 9 },
    passwordPolicy: { minLength: 12, policies: 1 },
  };
}

async function oktaTarget(tenantId: string) {
  const stored = await loadCredentials(tenantId, "okta");
  const baseUrl = stored?.baseUrl ?? process.env.OKTA_BASE_URL;
  const token = stored?.token ?? process.env.OKTA_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

export async function syncOkta(actor: Actor, api?: OktaApi): Promise<ConnectorSyncResult> {
  const target = await oktaTarget(actor.tenantId);
  const demo = !api && !target;
  const facts = demo
    ? demoOktaFacts()
    : await collectOkta(api ?? oktaApi(target!.baseUrl, target!.token), target ? new URL(target.baseUrl).hostname : "okta");
  await ensureAsset(actor, ASSETS.okta);
  const { evaluations, skipped } = await runPack(actor, "okta", facts, ASSETS.okta.id, demo ? "okta:demo" : "okta:api");
  await persistConnectorEvidence(actor, "okta", "Okta identity posture", facts, demo);
  await updateConnector(actor, "okta", demo ? "demo" : "healthy", facts);
  return { connector: "okta", mode: demo ? "demo" : "live", collectedAt: new Date().toISOString(), facts, evaluations, skipped };
}

// ---------------------------------------------------------------- Google Workspace --------------------------------------

function googleApi(accessToken: string): Api {
  return async (path) => {
    const response = await fetch(`https://admin.googleapis.com/admin/directory/v1${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

function demoGoogleFacts(): Facts {
  return {
    domain: "demo.example",
    users: { total: 84, active: 80, enrolledIn2Sv: 77, twoStepCoverage: 77 / 80, inactiveOver90Days: 3, truncated: false },
    admins: { superAdmins: 3, superAdminsWithout2Sv: 0, delegatedAdmins: 4 },
  };
}

export async function syncGoogleWorkspace(actor: Actor, api?: Api): Promise<ConnectorSyncResult> {
  const stored = await loadCredentials(actor.tenantId, "google_workspace");
  const demo = !api && !stored;
  const facts = demo
    ? demoGoogleFacts()
    : await collectGoogleWorkspace(
        api ?? googleApi(await googleAccessToken(stored!)),
        stored ? stored.adminEmail.split("@")[1] : "workspace",
      );
  await ensureAsset(actor, ASSETS.google_workspace);
  const { evaluations, skipped } = await runPack(
    actor,
    "google_workspace",
    facts,
    ASSETS.google_workspace.id,
    demo ? "google_workspace:demo" : "google_workspace:api",
  );
  await persistConnectorEvidence(actor, "google_workspace", "Google Workspace identity posture", facts, demo);
  await updateConnector(actor, "google_workspace", demo ? "demo" : "healthy", facts);
  return {
    connector: "google_workspace",
    mode: demo ? "demo" : "live",
    collectedAt: new Date().toISOString(),
    facts,
    evaluations,
    skipped,
  };
}

// ---------------------------------------------------------------- Microsoft Entra ID ------------------------------------

function graphApi(accessToken: string): Api {
  return async (path) => {
    const url = path.startsWith("https://graph.microsoft.com/") ? path : `https://graph.microsoft.com/v1.0${path}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

function demoEntraFacts(): Facts {
  return {
    tenant: "demo",
    mfa: { members: 210, mfaRegistered: 198, mfaCoverage: 198 / 210, admins: 8, adminsWithoutMfa: 0 },
    conditionalAccess: { policies: 6, enabledPolicies: 5, mfaForAllUsers: true, legacyAuthBlocked: false },
    users: { enabled: 205, inactiveOver90Days: 6, truncated: false },
  };
}

export async function syncEntra(actor: Actor, api?: Api): Promise<ConnectorSyncResult> {
  const stored = await loadCredentials(actor.tenantId, "entra");
  const demo = !api && !stored;
  const facts = demo ? demoEntraFacts() : await collectEntra(api ?? graphApi(await entraAccessToken(stored!)), stored?.tenantId ?? "entra");
  await ensureAsset(actor, ASSETS.entra);
  const { evaluations, skipped } = await runPack(actor, "entra", facts, ASSETS.entra.id, demo ? "entra:demo" : "entra:api");
  await persistConnectorEvidence(actor, "entra", "Microsoft Entra ID posture", facts, demo);
  await updateConnector(actor, "entra", demo ? "demo" : "healthy", facts);
  return { connector: "entra", mode: demo ? "demo" : "live", collectedAt: new Date().toISOString(), facts, evaluations, skipped };
}

// ---------------------------------------------------------------- People systems ------------------------------------------

/** Facts reported by HR and learning systems through the signed ingest endpoint. Evaluated by the same control pack. */
export async function syncPeople(actor: Actor, facts: Facts, source: string): Promise<ConnectorSyncResult> {
  await ensureAsset(actor, ASSETS.people);
  const { evaluations, skipped } = await runPack(actor, "people", facts, ASSETS.people.id, source);
  await persistConnectorEvidence(actor, source.split(":")[0], `People system report (${source})`, facts, false);
  await updateConnector(actor, "people", "healthy", facts);
  return { connector: "people", mode: "live", collectedAt: new Date().toISOString(), facts, evaluations, skipped };
}

// ---------------------------------------------------------------- Dispatch and connection tests --------------------------

export type SyncParams = { owner?: string; repository?: string; project?: string; assetId?: string; demo?: boolean };
export const POLLED_CONNECTORS = ["github", "gitlab", "aws", "okta", "google_workspace", "entra"] as const;
export type PolledConnector = (typeof POLLED_CONNECTORS)[number];

/** One entry point for the sync endpoint, the scheduler and workflows. */
/**
 * Scheduled and manual-from-schedule collections must be live. Without stored credentials the individual sync functions fall back to
 * clearly tagged sample data, which is right for a demonstration but wrong for a recurring job: it would record sample facts under
 * the real repository or account name. This refuses instead, so a missing credential shows as a failed collection.
 */
export async function assertLiveCredentials(actor: Actor, kind: PolledConnector, params: SyncParams = {}) {
  // A demonstration deployment may opt in to scheduled sample collections explicitly; the default is to refuse.
  if (process.env.KONTROL_ALLOW_SAMPLE_COLLECTION === "true") return;
  if (params.demo) throw userError("A scheduled collection cannot run in sample mode");
  const stored = await loadCredentials(actor.tenantId, kind as never);
  const available =
    kind === "github"
      ? !!(stored as { token?: string } | null)?.token || !!process.env.GITHUB_TOKEN
      : kind === "okta"
        ? !!(await oktaTarget(actor.tenantId))
        : kind === "aws"
          ? !!stored || !!process.env.AWS_ACCESS_KEY_ID || !!process.env.AWS_PROFILE
          : !!stored;
  if (!available)
    throw userError(
      `No ${kind.replace("_", " ")} credentials are stored. A collection never falls back to sample data: add the connection in Administration.`,
    );
}

export async function syncConnector(actor: Actor, kind: PolledConnector, params: SyncParams = {}): Promise<ConnectorSyncResult> {
  switch (kind) {
    case "github":
      if (!params.owner || !params.repository) throw userError("GitHub needs an owner and a repository");
      return syncGitHub(actor, { owner: params.owner, repository: params.repository, assetId: params.assetId, demo: params.demo ?? false });
    case "gitlab":
      if (!params.project) throw userError("GitLab needs a project path (group/project)");
      return syncGitLab(actor, { project: params.project, assetId: params.assetId, demo: params.demo ?? false });
    case "aws":
      return syncAws(actor);
    case "okta":
      return syncOkta(actor);
    case "google_workspace":
      return syncGoogleWorkspace(actor);
    case "entra":
      return syncEntra(actor);
  }
}

export type ConnectionTest = { ok: boolean; detail: string; durationMs: number };

/** A cheap read-only call that proves the stored credentials work, with a message that never contains a secret. */
export async function testConnection(actor: Actor, kind: CredentialKind): Promise<ConnectionTest> {
  const started = Date.now();
  const done = (ok: boolean, detail: string): ConnectionTest => ({ ok, detail: detail.slice(0, 300), durationMs: Date.now() - started });
  try {
    switch (kind) {
      case "github": {
        const token = (await loadCredentials(actor.tenantId, "github"))?.token ?? process.env.GITHUB_TOKEN;
        if (!token) return done(false, "No GitHub token is stored.");
        const response = await githubApi(token)("/user");
        const login = (response.body as { login?: string } | null)?.login;
        return response.status === 200
          ? done(true, `Authenticated as ${login ?? "GitHub user"}. Repository permissions are checked when you sync.`)
          : done(false, `GitHub answered ${response.status}${response.status === 401 ? ": the token is invalid or expired" : ""}.`);
      }
      case "gitlab": {
        const stored = await loadCredentials(actor.tenantId, "gitlab");
        if (!stored) return done(false, "No GitLab credentials are stored.");
        const response = await gitlabApi(stored.baseUrl, stored.token)("/user");
        return response.status === 200
          ? done(true, `Authenticated as ${(response.body as { username?: string } | null)?.username ?? "GitLab user"}.`)
          : done(false, `GitLab answered ${response.status}.`);
      }
      case "okta": {
        const target = await oktaTarget(actor.tenantId);
        if (!target) return done(false, "No Okta credentials are stored.");
        const response = await oktaApi(target.baseUrl, target.token)("/api/v1/users?limit=1");
        return response.status === 200
          ? done(true, `Connected to ${new URL(target.baseUrl).hostname}.`)
          : done(false, `Okta answered ${response.status}${response.status === 401 ? ": the API token is invalid" : ""}.`);
      }
      case "aws": {
        const stored = await loadCredentials(actor.tenantId, "aws");
        const region = stored?.region ?? process.env.AWS_REGION ?? "eu-west-1";
        if (!stored && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) return done(false, "No AWS credentials are stored.");
        const identity = await new STSClient(stored ? { region, credentials: stored } : { region }).send(new GetCallerIdentityCommand({}));
        return done(true, `Account ${identity.Account}, ${identity.Arn?.split(":").pop()}.`);
      }
      case "google_workspace": {
        const stored = await loadCredentials(actor.tenantId, "google_workspace");
        if (!stored) return done(false, "No Google Workspace credentials are stored.");
        const response = await googleApi(await googleAccessToken(stored))("/users?customer=my_customer&maxResults=1");
        return response.status === 200
          ? done(true, `Connected to the ${stored.adminEmail.split("@")[1]} directory.`)
          : done(
              false,
              `Google Directory answered ${response.status}${response.status === 403 ? ": check the delegated administrator and the API scope" : ""}.`,
            );
      }
      case "entra": {
        const stored = await loadCredentials(actor.tenantId, "entra");
        if (!stored) return done(false, "No Entra ID credentials are stored.");
        const response = await graphApi(await entraAccessToken(stored))("/organization");
        const name = (response.body as { value?: Array<{ displayName?: string }> } | null)?.value?.[0]?.displayName;
        return response.status === 200
          ? done(true, `Connected to ${name ?? "the tenant"}.`)
          : done(false, `Microsoft Graph answered ${response.status}.`);
      }
    }
  } catch (error) {
    return done(false, error instanceof Error ? error.message : "Connection failed");
  }
}

// ---------------------------------------------------------------- Persistence -------------------------------------------

async function persistConnectorEvidence(actor: Actor, source: string, name: string, facts: Facts, demo: boolean) {
  const now = new Date().toISOString();
  const content = canonicalJson(facts);
  const id = `evidence_${source}_${Date.now()}`;
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run(
      `INSERT INTO evidence (id,tenant_id,name,source,collection_method,content_type,content_json,content_hash,collected_at,expires_at,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      actor.tenantId,
      name,
      `${source}:${demo ? "demo" : "api"}`,
      "automated connector",
      "application/json",
      content,
      sha256(content),
      now,
      new Date(Date.now() + 86_400_000).toISOString(),
      "healthy",
      actor.userId,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "connector.evidence_collected",
        objectType: "evidence",
        objectId: id,
        payload: { source, demo, hash: sha256(content) },
      },
      tx,
    );
  });
}

async function updateConnector(actor: Actor, kind: string, status: string, facts: Facts) {
  const now = new Date().toISOString();
  const config = JSON.stringify({ lastFactHash: sha256(canonicalJson(facts)) });
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    const existing = await tx.get<{ id: string }>(
      "SELECT id FROM connectors WHERE tenant_id = ? AND kind = ? LIMIT 1",
      actor.tenantId,
      kind,
    );
    if (existing)
      await tx.run("UPDATE connectors SET status = ?, last_sync_at = ?, config_json = ? WHERE id = ?", status, now, config, existing.id);
    else
      await tx.run(
        "INSERT INTO connectors (id,tenant_id,kind,name,config_json,status,last_sync_at) VALUES (?,?,?,?,?,?,?)",
        `connector_${kind}`,
        actor.tenantId,
        kind,
        `${kind.toUpperCase()} connector`,
        config,
        status,
        now,
      );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "connector.synced",
        objectType: "connector",
        objectId: existing?.id ?? `connector_${kind}`,
        payload: { kind, status },
      },
      tx,
    );
  });
}
