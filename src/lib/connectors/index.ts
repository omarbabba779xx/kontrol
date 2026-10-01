import "server-only";

import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { IAMClient } from "@aws-sdk/client-iam";
import { S3Client } from "@aws-sdk/client-s3";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/db";
import { appendAudit, canonicalJson, sha256 } from "@/lib/core/integrity";
import { assertPublicHttpsUrl } from "@/lib/core/net-guard";
import { evaluateControl } from "@/lib/core/policy-engine";
import { collectAws, collectGitHub, collectOkta, type AwsClients, type Facts, type GitHubApi, type JsonResponse, type OktaApi } from "@/lib/connectors/collectors";
import { PACK, missingFacts, type ConnectorKind } from "@/lib/connectors/pack";

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
};

const ASSETS: Record<Exclude<ConnectorKind, "github">, { id: string; type: string; name: string }> = {
  aws: { id: "asset_aws_account", type: "cloud_account", name: "AWS account" },
  okta: { id: "asset_okta_org", type: "identity_provider", name: "Okta organisation" },
};

/** Inserts the executable controls of the pack that this tenant does not have yet. Idempotent. */
export async function installControlPack(actor: Actor, connector?: ConnectorKind) {
  const db = (await getDb()).scope(actor.tenantId);
  const now = new Date().toISOString();
  const installed: string[] = [];
  await db.transaction(async (tx) => {
    for (const control of PACK.filter((item) => !connector || item.connector === connector)) {
      const existing = await tx.get("SELECT id FROM controls WHERE tenant_id = ? AND code = ?", actor.tenantId, control.code);
      if (existing) continue;
      await tx.run(`INSERT INTO controls (id,tenant_id,code,title,objective,owner_id,automation,frequency,policy_json,status,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        `control_${control.code.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, actor.tenantId, control.code, control.title, control.objective, null, "automated", control.frequency, JSON.stringify(control.policy), "unverified", now, now);
      installed.push(control.code);
    }
    if (installed.length) await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "controls.pack_installed", objectType: "tenant", objectId: actor.tenantId, payload: { controls: installed } }, tx);
  });
  return { installed };
}

async function ensureAsset(actor: Actor, asset: { id: string; type: string; name: string }) {
  const db = (await getDb()).scope(actor.tenantId);
  if (await db.get("SELECT id FROM assets WHERE tenant_id = ? AND id = ?", actor.tenantId, asset.id)) return;
  const now = new Date().toISOString();
  await db.run(`INSERT INTO assets (id,tenant_id,type,name,criticality,owner_id,attributes_json,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`, asset.id, actor.tenantId, asset.type, asset.name, "high", null, JSON.stringify({ managedBy: "kontrol-connector" }), now, now);
}

async function runPack(actor: Actor, connector: ConnectorKind, facts: Facts, assetId: string, source: string) {
  await installControlPack(actor, connector);
  const evaluations: ConnectorSyncResult["evaluations"] = [];
  const skipped: ConnectorSyncResult["skipped"] = [];
  let first: Evaluation | undefined;
  for (const control of PACK.filter((item) => item.connector === connector)) {
    const missing = missingFacts(control, facts);
    if (missing.length) { skipped.push({ controlCode: control.code, missing }); continue; }
    const result = await evaluateControl(actor, { controlCode: control.code, assetId, facts, source });
    first ??= result;
    evaluations.push({ controlCode: control.code, passed: result.passed, finding: result.finding });
  }
  return { evaluations, skipped, first };
}

// ---------------------------------------------------------------- GitHub ------------------------------------------------

function githubApi(token: string): GitHubApi {
  return async (path) => {
    const response = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body };
  };
}

function demoGitHubFacts(owner: string, repository: string): Facts {
  return { production: true, repository: `${owner}/${repository}`, defaultBranch: "main", visibility: "private", archived: false, branchProtection: { enabled: false, requiredReviews: 0, enforceAdmins: false, dismissStaleReviews: false, requireCodeOwnerReviews: false, requireSignedCommits: false }, security: { secretScanning: "enabled", pushProtection: "disabled", dependabotSecurityUpdates: "enabled" }, vulnerabilityAlertsEnabled: true, org: { twoFactorRequired: true } };
}

export async function syncGitHub(actor: Actor, input: { owner: string; repository: string; assetId: string; demo: boolean }, api?: GitHubApi): Promise<ConnectorSyncResult> {
  const token = process.env.GITHUB_TOKEN;
  const useDemo = !api && (input.demo || !token);
  const facts = useDemo ? demoGitHubFacts(input.owner, input.repository) : await collectGitHub(api ?? githubApi(token!), input.owner, input.repository);
  const { evaluations, skipped, first } = await runPack(actor, "github", facts, input.assetId, useDemo ? "github:demo" : "github:api");
  await updateConnector(actor, "github", useDemo ? "demo" : "healthy", facts);
  return { connector: "github", mode: useDemo ? "demo" : "live", collectedAt: new Date().toISOString(), facts, evaluation: first, evaluations, skipped };
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

export async function syncAws(actor: Actor, region = process.env.AWS_REGION ?? "eu-west-1", clients?: AwsClients): Promise<ConnectorSyncResult> {
  const demo = !clients && !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE;
  const facts = demo ? demoAwsFacts(region) : await collectAws(clients ?? { iam: new IAMClient({ region }), s3: new S3Client({ region }), config: new ConfigServiceClient({ region }), cloudtrail: new CloudTrailClient({ region }) }, region);
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
    const response = await fetch(url, { headers: { Authorization: `SSWS ${token}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json().catch(() => null), link: response.headers.get("link") };
  };
}

function demoOktaFacts(): Facts {
  return { organization: "demo", users: { active: 126, inactiveOver90Days: 2, truncated: false }, privileged: { total: 9, mfaEnrolled: 8, mfaCoverage: 8 / 9 }, passwordPolicy: { minLength: 12, policies: 1 } };
}

export async function syncOkta(actor: Actor, api?: OktaApi): Promise<ConnectorSyncResult> {
  const baseUrl = process.env.OKTA_BASE_URL;
  const token = process.env.OKTA_API_TOKEN;
  const demo = !api && (!baseUrl || !token);
  const facts = demo ? demoOktaFacts() : await collectOkta(api ?? oktaApi(baseUrl!, token!), baseUrl ? new URL(baseUrl).hostname : "okta");
  await ensureAsset(actor, ASSETS.okta);
  const { evaluations, skipped } = await runPack(actor, "okta", facts, ASSETS.okta.id, demo ? "okta:demo" : "okta:api");
  await persistConnectorEvidence(actor, "okta", "Okta identity posture", facts, demo);
  await updateConnector(actor, "okta", demo ? "demo" : "healthy", facts);
  return { connector: "okta", mode: demo ? "demo" : "live", collectedAt: new Date().toISOString(), facts, evaluations, skipped };
}

// ---------------------------------------------------------------- Persistence -------------------------------------------

async function persistConnectorEvidence(actor: Actor, source: string, name: string, facts: Facts, demo: boolean) {
  const now = new Date().toISOString();
  const content = canonicalJson(facts);
  const id = `evidence_${source}_${Date.now()}`;
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run(`INSERT INTO evidence (id,tenant_id,name,source,collection_method,content_type,content_json,content_hash,collected_at,expires_at,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, actor.tenantId, name, `${source}:${demo ? "demo" : "api"}`, "automated connector", "application/json", content, sha256(content), now, new Date(Date.now() + 86_400_000).toISOString(), "healthy", actor.userId);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "connector.evidence_collected", objectType: "evidence", objectId: id, payload: { source, demo, hash: sha256(content) } }, tx);
  });
}

async function updateConnector(actor: Actor, kind: string, status: string, facts: Facts) {
  const now = new Date().toISOString();
  const config = JSON.stringify({ lastFactHash: sha256(canonicalJson(facts)) });
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    const existing = await tx.get<{ id: string }>("SELECT id FROM connectors WHERE tenant_id = ? AND kind = ? LIMIT 1", actor.tenantId, kind);
    if (existing) await tx.run("UPDATE connectors SET status = ?, last_sync_at = ?, config_json = ? WHERE id = ?", status, now, config, existing.id);
    else await tx.run("INSERT INTO connectors (id,tenant_id,kind,name,config_json,status,last_sync_at) VALUES (?,?,?,?,?,?,?)", `connector_${kind}`, actor.tenantId, kind, `${kind.toUpperCase()} connector`, config, status, now);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "connector.synced", objectType: "connector", objectId: existing?.id ?? `connector_${kind}`, payload: { kind, status } }, tx);
  });
}
