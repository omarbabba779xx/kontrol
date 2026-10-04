import { DescribeTrailsCommand, GetTrailStatusCommand } from "@aws-sdk/client-cloudtrail";
import { GetComplianceSummaryByConfigRuleCommand } from "@aws-sdk/client-config-service";
import { GetAccountPasswordPolicyCommand, GetAccountSummaryCommand } from "@aws-sdk/client-iam";
import { GetPublicAccessBlockCommand, ListBucketsCommand } from "@aws-sdk/client-s3";

/**
 * Collectors turn live API responses into the flat facts that control policies evaluate.
 * They are written against injected clients so they can be tested with recorded API responses.
 * A fact that cannot be read (missing permission, service not enabled) is `null`, never a guess:
 * the control pack skips controls whose facts are unavailable instead of failing them.
 */

export type JsonResponse = { status: number; body: unknown; link?: string | null };
export type Facts = Record<string, unknown>;
type Json = Record<string, unknown>;

const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const text = (value: unknown) => (typeof value === "string" ? value : null);
const DAY = 86_400_000;

// ---------------------------------------------------------------- GitHub ------------------------------------------------

export type GitHubApi = (path: string) => Promise<JsonResponse>;

export async function collectGitHub(api: GitHubApi, owner: string, repository: string): Promise<Facts> {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const repo = await api(base);
  if (repo.status !== 200) throw new Error(`GitHub API ${repo.status} reading ${owner}/${repository}`);
  const data = record(repo.body);
  const defaultBranch = text(data.default_branch) ?? "main";
  const analysis = record(data.security_and_analysis);
  const status = (key: string) => text(record(analysis[key]).status);

  // Classic branch protection. 404 with "Branch not protected" means none; any other failure means we could not tell.
  let protection: Facts | null = null;
  const response = await api(`${base}/branches/${encodeURIComponent(defaultBranch)}/protection`);
  if (response.status === 200) {
    const body = record(response.body);
    const reviews = record(body.required_pull_request_reviews);
    protection = {
      enabled: true,
      source: "branch_protection",
      requiredReviews: Number(reviews.required_approving_review_count ?? 0),
      enforceAdmins: record(body.enforce_admins).enabled === true,
      dismissStaleReviews: reviews.dismiss_stale_reviews === true,
      requireCodeOwnerReviews: reviews.require_code_owner_reviews === true,
      requireSignedCommits: record(body.required_signatures).enabled === true,
    };
  } else if (response.status === 404 && /not protected/i.test(text(record(response.body).message) ?? "")) {
    // No classic protection: repository rulesets can protect the branch instead, so they must be read before concluding it is open.
    const rules = await api(`${base}/rules/branches/${encodeURIComponent(defaultBranch)}`);
    if (rules.status === 200 && Array.isArray(rules.body)) {
      const list = (rules.body as unknown[]).map(record);
      const pull = list.find((rule) => rule.type === "pull_request");
      if (pull) {
        const parameters = record(pull.parameters);
        protection = {
          enabled: true,
          source: "ruleset",
          requiredReviews: Number(parameters.required_approving_review_count ?? 0),
          // Who may bypass a ruleset is not exposed by this endpoint, so whether administrators are bound is unknown, not false.
          enforceAdmins: null,
          dismissStaleReviews: parameters.dismiss_stale_reviews_on_push === true,
          requireCodeOwnerReviews: parameters.require_code_owner_review === true,
          requireSignedCommits: list.some((rule) => rule.type === "required_signatures"),
        };
      } else {
        protection = {
          enabled: false,
          source: "none",
          requiredReviews: 0,
          enforceAdmins: false,
          dismissStaleReviews: false,
          requireCodeOwnerReviews: false,
          requireSignedCommits: false,
        };
      }
    }
    // Rulesets unreadable: protection stays unknown (null) rather than being reported as absent.
  }

  // 204 = enabled. GitHub also answers 404 when the caller may not see the setting, so 404 only means
  // "disabled" when the message says so; every other answer (401, 403, plain 404) is unknown.
  const alerts = await api(`${base}/vulnerability-alerts`);
  const vulnerabilityAlertsEnabled =
    alerts.status === 204
      ? true
      : alerts.status === 404 && /alerts are disabled/i.test(text(record(alerts.body).message) ?? "")
        ? false
        : null;

  // Dependabot security updates are reported in `security_and_analysis` only on some plans (it is null on a private repository of a
  // personal account, for instance). The dedicated endpoint answers everywhere the caller administers the repository.
  let dependabotSecurityUpdates = status("dependabot_security_updates");
  if (dependabotSecurityUpdates === null) {
    const fixes = await api(`${base}/automated-security-fixes`);
    const body = record(fixes.body);
    if (fixes.status === 200 && typeof body.enabled === "boolean") dependabotSecurityUpdates = body.enabled && body.paused !== true ? "enabled" : "disabled";
    // GitHub answers 404 here when the feature is off for the repository: that is a readable "disabled", not an unknown.
    else if (fixes.status === 404 && vulnerabilityAlertsEnabled === false) dependabotSecurityUpdates = "disabled";
  }

  // Secret scanning is absent from the repository summary on plans that do not include it, but its alerts endpoint says plainly when
  // it is off. Push protection cannot be on without it.
  let secretScanning = status("secret_scanning");
  let pushProtection = status("secret_scanning_push_protection");
  let openSecretAlerts: number | null = null;
  const secrets = await api(`${base}/secret-scanning/alerts?state=open&per_page=100`);
  if (secrets.status === 200 && Array.isArray(secrets.body)) {
    secretScanning ??= "enabled";
    openSecretAlerts = secrets.body.length;
  } else if (secrets.status === 404 && /secret scanning is disabled/i.test(text(record(secrets.body).message) ?? "")) {
    secretScanning ??= "disabled";
    pushProtection ??= "disabled";
  }

  // Open Dependabot alerts of high or critical severity. "Disabled" is not zero alerts: it is unknown.
  let openHighVulnerabilities: number | null = null;
  const vulnerabilities = await api(`${base}/dependabot/alerts?state=open&severity=critical,high&per_page=100`);
  if (vulnerabilities.status === 200 && Array.isArray(vulnerabilities.body)) openHighVulnerabilities = vulnerabilities.body.length;

  // Code scanning: 200 on the alerts endpoint means an analysis is configured; the "not enabled" refusal is a readable no.
  let codeScanning: boolean | null = null;
  let openHighCodeAlerts: number | null = null;
  const code = await api(`${base}/code-scanning/alerts?state=open&per_page=100`);
  if (code.status === 200 && Array.isArray(code.body)) {
    codeScanning = true;
    openHighCodeAlerts = (code.body as unknown[]).map(record).filter((alert) => ["critical", "high"].includes(text(record(alert.rule).security_severity_level) ?? "")).length;
  } else if ((code.status === 403 || code.status === 404) && /not enabled|no analysis found/i.test(text(record(code.body).message) ?? "")) codeScanning = false;

  // What the token of a workflow may do when the workflow does not say: "read" is the safe default.
  const workflow = await api(`${base}/actions/permissions/workflow`);
  const workflowBody = record(workflow.body);
  const actions = workflow.status === 200 ? { defaultWorkflowPermissions: text(workflowBody.default_workflow_permissions), canApprovePullRequests: workflowBody.can_approve_pull_request_reviews === true } : { defaultWorkflowPermissions: null, canApprovePullRequests: null };

  // People outside the organisation and deploy keys that can write. On a personal repository every collaborator is "outside".
  const outside = await api(`${base}/collaborators?affiliation=outside&per_page=100`);
  const outsideAdmins = outside.status === 200 && Array.isArray(outside.body) ? (outside.body as unknown[]).map(record).filter((user) => record(user.permissions).admin === true).length : null;
  const keys = await api(`${base}/keys?per_page=100`);
  const writableDeployKeys = keys.status === 200 && Array.isArray(keys.body) ? (keys.body as unknown[]).map(record).filter((key) => key.read_only === false).length : null;

  // Webhooks that skip certificate verification. Needs a scope many tokens lack, in which case it stays unknown.
  const hooks = await api(`${base}/hooks?per_page=100`);
  const insecureWebhooks = hooks.status === 200 && Array.isArray(hooks.body) ? (hooks.body as unknown[]).map(record).filter((hook) => hook.active !== false && String(record(hook.config).insecure_ssl ?? "0") !== "0").length : null;

  // A published way to report a vulnerability, and owners for review. Either file may live in the root, .github/ or docs/.
  const exists = async (name: string) => {
    let unknown = false;
    for (const folder of ["", ".github/", "docs/"]) {
      const file = await api(`${base}/contents/${folder}${name}`);
      if (file.status === 200) return true;
      if (file.status !== 404) unknown = true;
    }
    return unknown ? null : false;
  };
  const files = { securityPolicy: await exists("SECURITY.md"), codeOwners: await exists("CODEOWNERS") };

  let twoFactorRequired: boolean | null = null;
  const isOrganization = record(data.owner).type === "Organization";
  if (isOrganization) {
    const org = await api(`/orgs/${encodeURIComponent(owner)}`);
    const flag = record(org.body).two_factor_requirement_enabled;
    if (org.status === 200 && typeof flag === "boolean") twoFactorRequired = flag;
  }

  return {
    production: true,
    repository: text(data.full_name) ?? `${owner}/${repository}`,
    defaultBranch,
    visibility: text(data.visibility),
    archived: data.archived === true,
    branchProtection: protection,
    security: {
      secretScanning,
      pushProtection,
      dependabotSecurityUpdates,
    },
    vulnerabilityAlertsEnabled,
    alerts: { openSecrets: openSecretAlerts, openHighVulnerabilities, openHighCode: openHighCodeAlerts },
    codeScanning: { enabled: codeScanning },
    actions,
    access: { outsideAdmins, writableDeployKeys, insecureWebhooks },
    files,
    org: { isOrganization, twoFactorRequired },
  };
}

// ---------------------------------------------------------------- AWS ---------------------------------------------------

type Sender = { send(command: never): Promise<unknown> };
export type AwsClients = { iam: Sender; s3: Sender; config: Sender; cloudtrail: Sender };

const errorName = (error: unknown) =>
  error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
const call = <T>(client: Sender, command: unknown) => client.send(command as never) as Promise<T>;
const MAX_BUCKETS = 300;

export async function collectAws(clients: AwsClients, region: string): Promise<Facts> {
  const facts: Facts = { region, root: null, passwordPolicy: null, s3: null, config: null, cloudTrail: null };

  try {
    const summary = await call<{ SummaryMap?: Record<string, number> }>(clients.iam, new GetAccountSummaryCommand({}));
    const map = summary.SummaryMap ?? {};
    if (typeof map.AccountMFAEnabled === "number")
      facts.root = {
        mfaEnabled: map.AccountMFAEnabled === 1,
        accessKeysPresent: map.AccountAccessKeysPresent ?? 0,
        users: map.Users ?? null,
        mfaDevices: map.MFADevices ?? null,
      };
  } catch {
    /* leave null */
  }

  try {
    const policy =
      (await call<{ PasswordPolicy?: Record<string, unknown> }>(clients.iam, new GetAccountPasswordPolicyCommand({}))).PasswordPolicy ?? {};
    facts.passwordPolicy = {
      exists: true,
      minimumLength: Number(policy.MinimumPasswordLength ?? 0),
      reusePrevention: Number(policy.PasswordReusePrevention ?? 0),
      maxPasswordAge: Number(policy.MaxPasswordAge ?? 0),
      requireSymbols: policy.RequireSymbols === true,
      requireNumbers: policy.RequireNumbers === true,
    };
  } catch (error) {
    if (errorName(error) === "NoSuchEntityException")
      facts.passwordPolicy = {
        exists: false,
        minimumLength: 0,
        reusePrevention: 0,
        maxPasswordAge: 0,
        requireSymbols: false,
        requireNumbers: false,
      };
  }

  try {
    const buckets = ((await call<{ Buckets?: Array<{ Name?: string }> }>(clients.s3, new ListBucketsCommand({}))).Buckets ?? []).slice(
      0,
      MAX_BUCKETS,
    );
    let without = 0,
      unchecked = 0;
    for (const bucket of buckets) {
      try {
        const block =
          (
            await call<{ PublicAccessBlockConfiguration?: Record<string, boolean> }>(
              clients.s3,
              new GetPublicAccessBlockCommand({ Bucket: bucket.Name }),
            )
          ).PublicAccessBlockConfiguration ?? {};
        if (!(block.BlockPublicAcls && block.IgnorePublicAcls && block.BlockPublicPolicy && block.RestrictPublicBuckets)) without += 1;
      } catch (error) {
        if (errorName(error) === "NoSuchPublicAccessBlockConfiguration") without += 1;
        else unchecked += 1;
      }
    }
    facts.s3 = { buckets: buckets.length, withoutPublicAccessBlock: unchecked === 0 ? without : null, unchecked };
  } catch {
    /* leave null */
  }

  try {
    const summary = (
      await call<{
        ComplianceSummary?: { CompliantResourceCount?: { CappedCount?: number }; NonCompliantResourceCount?: { CappedCount?: number } };
      }>(clients.config, new GetComplianceSummaryByConfigRuleCommand({}))
    ).ComplianceSummary;
    if (summary)
      facts.config = {
        compliantResources: summary.CompliantResourceCount?.CappedCount ?? 0,
        nonCompliantResources: summary.NonCompliantResourceCount?.CappedCount ?? 0,
      };
  } catch {
    /* AWS Config not enabled or not permitted */
  }

  try {
    const trails =
      (
        await call<{
          trailList?: Array<{ Name?: string; TrailARN?: string; IsMultiRegionTrail?: boolean; LogFileValidationEnabled?: boolean }>;
        }>(clients.cloudtrail, new DescribeTrailsCommand({}))
      ).trailList ?? [];
    const multi = trails.filter((trail) => trail.IsMultiRegionTrail);
    let logging = false;
    for (const trail of multi) {
      try {
        if (
          (await call<{ IsLogging?: boolean }>(clients.cloudtrail, new GetTrailStatusCommand({ Name: trail.TrailARN ?? trail.Name })))
            .IsLogging
        )
          logging = true;
      } catch {
        /* status unreadable */
      }
    }
    facts.cloudTrail = {
      trails: trails.length,
      multiRegionTrails: multi.length,
      logging,
      logValidation: multi.length > 0 && multi.every((trail) => trail.LogFileValidationEnabled === true),
    };
  } catch {
    /* leave null */
  }

  return facts;
}

// ---------------------------------------------------------------- Okta --------------------------------------------------

/** `path` is either an API path or an absolute `next` link already validated by the caller. */
export type OktaApi = (path: string) => Promise<JsonResponse>;

const MAX_PAGES = 25;
const MAX_ADMINS = 100;

/** Okta paginates with `Link: <url>; rel="next"`. */
export function nextLink(header: string | null | undefined) {
  const match = /<([^>]+)>;\s*rel="next"/i.exec(header ?? "");
  return match ? match[1] : null;
}

async function pages(api: OktaApi, first: string) {
  const items: unknown[] = [];
  let next: string | null = first;
  let truncated = false;
  for (let page = 0; next; page++) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const response: JsonResponse = await api(next);
    if (response.status !== 200) throw new Error(`Okta API ${response.status}`);
    const body = record(response.body);
    items.push(...(Array.isArray(response.body) ? response.body : Array.isArray(body.value) ? (body.value as unknown[]) : []));
    next = nextLink(response.link);
  }
  return { items, truncated };
}

export async function collectOkta(api: OktaApi, organization: string, now = Date.now()): Promise<Facts> {
  const facts: Facts = { organization, users: null, privileged: null, passwordPolicy: null };

  try {
    const { items, truncated } = await pages(api, "/api/v1/users?limit=200&filter=" + encodeURIComponent('status eq "ACTIVE"'));
    const inactive = items.filter((item) => {
      const user = record(item);
      const reference = Date.parse(text(user.lastLogin) ?? text(user.created) ?? "");
      return Number.isNaN(reference) ? false : now - reference > 90 * DAY;
    }).length;
    facts.users = { active: items.length, inactiveOver90Days: truncated ? null : inactive, truncated };
  } catch {
    /* leave null */
  }

  try {
    const { items } = await pages(api, "/api/v1/iam/assignees/users?limit=200");
    const admins = items
      .map((item) => text(record(item).id))
      .filter((id): id is string => id !== null)
      .slice(0, MAX_ADMINS);
    let enrolled = 0;
    for (const id of admins) {
      const factors = await api(`/api/v1/users/${encodeURIComponent(id)}/factors`);
      if (factors.status !== 200) throw new Error(`Okta API ${factors.status} reading factors`);
      if ((Array.isArray(factors.body) ? factors.body : []).some((factor) => record(factor).status === "ACTIVE")) enrolled += 1;
    }
    if (admins.length > 0) facts.privileged = { total: admins.length, mfaEnrolled: enrolled, mfaCoverage: enrolled / admins.length };
  } catch {
    /* leave null */
  }

  try {
    const response = await api("/api/v1/policies?type=PASSWORD");
    if (response.status === 200 && Array.isArray(response.body)) {
      const lengths = response.body
        .filter((policy) => record(policy).status === "ACTIVE")
        .map((policy) => Number(record(record(record(record(policy).settings).password).complexity).minLength))
        .filter((length) => Number.isFinite(length));
      if (lengths.length) facts.passwordPolicy = { minLength: Math.min(...lengths), policies: lengths.length };
    }
  } catch {
    /* leave null */
  }

  return facts;
}
