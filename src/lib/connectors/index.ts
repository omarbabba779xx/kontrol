import "server-only";

import { ConfigServiceClient, GetComplianceSummaryByConfigRuleCommand } from "@aws-sdk/client-config-service";
import { GetAccountSummaryCommand, IAMClient } from "@aws-sdk/client-iam";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/core/database";
import { appendAudit, canonicalJson, sha256 } from "@/lib/core/integrity";
import { evaluateControl } from "@/lib/core/policy-engine";

export type ConnectorSyncResult = {
  connector: "github" | "aws" | "okta";
  mode: "live" | "demo";
  collectedAt: string;
  facts: Record<string, unknown>;
  evaluation?: ReturnType<typeof evaluateControl>;
};

async function githubRequest(path: string, token: string) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json() as Promise<Record<string, unknown>>;
}

export async function syncGitHub(actor: Actor, input: { owner: string; repository: string; assetId: string; demo: boolean }): Promise<ConnectorSyncResult> {
  const token = process.env.GITHUB_TOKEN;
  const useDemo = input.demo || !token;
  let facts: Record<string, unknown>;

  if (useDemo) {
    facts = { production: true, repository: `${input.owner}/${input.repository}`, defaultBranch: "main", branchProtection: { enabled: false, requiredReviews: 0, enforceAdmins: false }, secretScanning: true, visibility: "private" };
  } else {
    const repository = await githubRequest(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`, token);
    const defaultBranch = String(repository.default_branch ?? "main");
    let protection: Record<string, unknown> | null = null;
    try { protection = await githubRequest(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/branches/${encodeURIComponent(defaultBranch)}/protection`, token); } catch { protection = null; }
    const reviews = protection?.required_pull_request_reviews as Record<string, unknown> | undefined;
    facts = {
      production: true,
      repository: repository.full_name,
      defaultBranch,
      visibility: repository.visibility,
      archived: repository.archived,
      branchProtection: { enabled: Boolean(protection), requiredReviews: Number(reviews?.required_approving_review_count ?? 0), enforceAdmins: Boolean((protection?.enforce_admins as Record<string, unknown> | undefined)?.enabled) },
      security: repository.security_and_analysis ?? null,
    };
  }

  const evaluation = evaluateControl(actor, { controlCode: "CTL-SDLC-004", assetId: input.assetId, facts, source: useDemo ? "github:demo" : "github:api" });
  updateConnector(actor, "github", useDemo ? "demo" : "healthy", facts);
  return { connector: "github", mode: useDemo ? "demo" : "live", collectedAt: new Date().toISOString(), facts, evaluation };
}

export async function syncAws(actor: Actor, region = process.env.AWS_REGION ?? "eu-west-1"): Promise<ConnectorSyncResult> {
  const demo = !process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE;
  let facts: Record<string, unknown>;
  if (demo) {
    facts = { region, account: "demo", configRules: { compliant: 42, nonCompliant: 3 }, iam: { users: 18, mfaDevices: 16, accessKeys: 7 }, encryption: { s3: .96, rds: 1 } };
  } else {
    const [configSummary, iamSummary] = await Promise.all([
      new ConfigServiceClient({ region }).send(new GetComplianceSummaryByConfigRuleCommand({})),
      new IAMClient({ region }).send(new GetAccountSummaryCommand({})),
    ]);
    facts = { region, configRules: configSummary.ComplianceSummary, iam: iamSummary.SummaryMap };
  }
  persistConnectorEvidence(actor, "aws", "AWS configuration and IAM posture", facts, demo);
  updateConnector(actor, "aws", demo ? "demo" : "healthy", facts);
  return { connector: "aws", mode: demo ? "demo" : "live", collectedAt: new Date().toISOString(), facts };
}

export async function syncOkta(actor: Actor): Promise<ConnectorSyncResult> {
  const baseUrl = process.env.OKTA_BASE_URL;
  const token = process.env.OKTA_API_TOKEN;
  const demo = !baseUrl || !token;
  let facts: Record<string, unknown>;
  if (demo) {
    facts = { organization: "demo", users: { active: 126, suspended: 4, deprovisioned: 11 }, privileged: { total: 9, mfaEnrolled: 8, inactiveOver30Days: 1 } };
  } else {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/users?limit=200`, { headers: { Authorization: `SSWS ${token}`, Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Okta API ${response.status}: ${await response.text()}`);
    const users = await response.json() as Array<{ status?: string }>;
    facts = { organization: new URL(baseUrl).hostname, users: { total: users.length, active: users.filter((user) => user.status === "ACTIVE").length, suspended: users.filter((user) => user.status === "SUSPENDED").length, deprovisioned: users.filter((user) => user.status === "DEPROVISIONED").length } };
  }
  persistConnectorEvidence(actor, "okta", "Okta identity posture", facts, demo);
  updateConnector(actor, "okta", demo ? "demo" : "healthy", facts);
  return { connector: "okta", mode: demo ? "demo" : "live", collectedAt: new Date().toISOString(), facts };
}

function persistConnectorEvidence(actor: Actor, source: string, name: string, facts: Record<string, unknown>, demo: boolean) {
  const now = new Date().toISOString();
  const content = canonicalJson(facts);
  const id = `evidence_${source}_${Date.now()}`;
  getDb().prepare(`INSERT INTO evidence (id,tenant_id,name,source,collection_method,content_type,content_json,content_hash,collected_at,expires_at,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, actor.tenantId, name, `${source}:${demo ? "demo" : "api"}`, "automated connector", "application/json", content, sha256(content), now, new Date(Date.now() + 86_400_000).toISOString(), "healthy", actor.userId,
  );
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "connector.evidence_collected", objectType: "evidence", objectId: id, payload: { source, demo, hash: sha256(content) } });
}

function updateConnector(actor: Actor, kind: string, status: string, facts: Record<string, unknown>) {
  const now = new Date().toISOString();
  const db = getDb();
  const existing = db.prepare("SELECT id FROM connectors WHERE tenant_id = ? AND kind = ? LIMIT 1").get(actor.tenantId, kind) as { id: string } | undefined;
  if (existing) db.prepare("UPDATE connectors SET status = ?, last_sync_at = ?, config_json = ? WHERE id = ?").run(status, now, JSON.stringify({ lastFactHash: sha256(canonicalJson(facts)) }), existing.id);
  else db.prepare("INSERT INTO connectors (id,tenant_id,kind,name,config_json,status,last_sync_at) VALUES (?,?,?,?,?,?,?)").run(`connector_${kind}`, actor.tenantId, kind, `${kind.toUpperCase()} connector`, JSON.stringify({ lastFactHash: sha256(canonicalJson(facts)) }), status, now);
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "connector.synced", objectType: "connector", objectId: existing?.id ?? `connector_${kind}`, payload: { kind, status } });
}
