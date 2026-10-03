import type { Facts, JsonResponse } from "@/lib/connectors/collectors";

/**
 * Collectors for identity providers and a second source-control platform. Like the first three they are written
 * against an injected `api` function, return `null` for any fact that could not be read, and never guess.
 */
type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const DAY = 86_400_000;
const MAX_PAGES = 40;

export type Api = (path: string) => Promise<JsonResponse>;

// ------------------------------------------------------------------ Google Workspace ------------------------------------

/** Admin SDK Directory API. `path` is relative to https://admin.googleapis.com/admin/directory/v1 or an absolute next-page URL. */
export async function collectGoogleWorkspace(api: Api, domain: string, now = Date.now()): Promise<Facts> {
  const facts: Facts = { domain, users: null, admins: null };
  const users: Json[] = [];
  let pageToken: string | null = null;
  let truncated = false;
  try {
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) {
        truncated = true;
        break;
      }
      const response: JsonResponse = await api(
        `/users?customer=my_customer&maxResults=500&projection=basic${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      );
      if (response.status !== 200) throw new Error(`Google Directory API ${response.status}`);
      const body = record(response.body);
      users.push(...list(body.users).map(record));
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
      if (!pageToken) break;
    }
  } catch {
    return facts;
  }

  const active = users.filter((user) => user.suspended !== true && user.archived !== true);
  const enrolled = active.filter((user) => user.isEnrolledIn2Sv === true).length;
  const lastActivity = (user: Json) => {
    const login = Date.parse(String(user.lastLoginTime ?? ""));
    // Google reports 1970-01-01 for an account that never signed in; fall back to when it was created.
    const reference = Number.isNaN(login) || login < Date.parse("2000-01-01") ? Date.parse(String(user.creationTime ?? "")) : login;
    return reference;
  };
  const inactive = active.filter((user) => {
    const at = lastActivity(user);
    return !Number.isNaN(at) && now - at > 90 * DAY;
  }).length;
  const superAdmins = active.filter((user) => user.isAdmin === true);

  facts.users = {
    total: users.length,
    active: active.length,
    enrolledIn2Sv: truncated ? null : enrolled,
    twoStepCoverage: truncated || active.length === 0 ? null : enrolled / active.length,
    inactiveOver90Days: truncated ? null : inactive,
    truncated,
  };
  facts.admins = truncated
    ? null
    : {
        superAdmins: superAdmins.length,
        superAdminsWithout2Sv: superAdmins.filter((user) => user.isEnrolledIn2Sv !== true).length,
        delegatedAdmins: active.filter((user) => user.isDelegatedAdmin === true).length,
      };
  return facts;
}

// ------------------------------------------------------------------ Microsoft Entra ID ----------------------------------

/** Microsoft Graph v1.0. `path` is relative to https://graph.microsoft.com/v1.0 or an absolute @odata.nextLink. */
async function graphPages(api: Api, first: string) {
  const items: Json[] = [];
  let next: string | null = first;
  let truncated = false;
  for (let page = 0; next; page++) {
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    const response: JsonResponse = await api(next);
    if (response.status !== 200) throw new Error(`Graph API ${response.status}`);
    const body = record(response.body);
    items.push(...list(body.value).map(record));
    next = typeof body["@odata.nextLink"] === "string" ? (body["@odata.nextLink"] as string) : null;
  }
  return { items, truncated };
}

const includes = (value: unknown, wanted: string) => list(value).some((item) => String(item).toLowerCase() === wanted.toLowerCase());

export async function collectEntra(api: Api, tenant: string, now = Date.now()): Promise<Facts> {
  const facts: Facts = { tenant, mfa: null, conditionalAccess: null, users: null };

  try {
    const { items, truncated } = await graphPages(api, "/reports/authenticationMethods/userRegistrationDetails?$top=999");
    const members = items.filter((item) => item.userType !== "guest");
    const admins = members.filter((item) => item.isAdmin === true);
    facts.mfa = truncated
      ? null
      : {
          members: members.length,
          mfaRegistered: members.filter((item) => item.isMfaRegistered === true).length,
          mfaCoverage: members.length ? members.filter((item) => item.isMfaRegistered === true).length / members.length : null,
          admins: admins.length,
          adminsWithoutMfa: admins.filter((item) => item.isMfaRegistered !== true).length,
        };
  } catch {
    /* Reports.Read.All missing or Entra ID P1 not available */
  }

  try {
    const { items } = await graphPages(api, "/identity/conditionalAccess/policies");
    const enabled = items.filter((policy) => policy.state === "enabled");
    const forAllUsers = (policy: Json) => includes(record(record(policy.conditions).users).includeUsers, "All");
    const forAllApps = (policy: Json) => includes(record(record(policy.conditions).applications).includeApplications, "All");
    const grants = (policy: Json) => record(policy.grantControls);
    facts.conditionalAccess = {
      policies: items.length,
      enabledPolicies: enabled.length,
      mfaForAllUsers: enabled.some(
        (policy) =>
          forAllUsers(policy) &&
          forAllApps(policy) &&
          (includes(grants(policy).builtInControls, "mfa") || Boolean(record(grants(policy).authenticationStrength).id)),
      ),
      legacyAuthBlocked: enabled.some(
        (policy) =>
          forAllUsers(policy) &&
          includes(record(policy.conditions).clientAppTypes, "exchangeActiveSync") &&
          includes(record(policy.conditions).clientAppTypes, "other") &&
          includes(grants(policy).builtInControls, "block"),
      ),
    };
  } catch {
    /* Policy.Read.All missing */
  }

  try {
    const { items, truncated } = await graphPages(api, "/users?$select=id,accountEnabled,userType,createdDateTime,signInActivity&$top=999");
    const members = items.filter((user) => user.accountEnabled === true && user.userType !== "Guest" && user.userType !== "guest");
    const hasActivityData = members.some(
      (user) =>
        record(user.signInActivity).lastSuccessfulSignInDateTime !== undefined ||
        record(user.signInActivity).lastSignInDateTime !== undefined,
    );
    const inactive = members.filter((user) => {
      const activity = record(user.signInActivity);
      const reference = Date.parse(
        String(activity.lastSuccessfulSignInDateTime ?? activity.lastSignInDateTime ?? user.createdDateTime ?? ""),
      );
      return !Number.isNaN(reference) && now - reference > 90 * DAY;
    }).length;
    // Without AuditLog.Read.All the signInActivity property is absent: that is "unknown", not "nobody is dormant".
    facts.users = { enabled: members.length, inactiveOver90Days: truncated || !hasActivityData ? null : inactive, truncated };
  } catch {
    /* AuditLog.Read.All missing */
  }

  return facts;
}

// ------------------------------------------------------------------ GitLab ---------------------------------------------

/** GitLab REST v4. `path` is relative to {baseUrl}/api/v4. */
export async function collectGitLab(api: Api, projectPath: string, group?: string): Promise<Facts> {
  const base = `/projects/${encodeURIComponent(projectPath)}`;
  const project = await api(base);
  if (project.status !== 200) throw new Error(`GitLab API ${project.status} reading ${projectPath}`);
  const data = record(project.body);
  const id = data.id;
  const defaultBranch = typeof data.default_branch === "string" ? data.default_branch : "main";

  let branchProtection: Facts | null = null;
  const protectedBranch = await api(`/projects/${String(id)}/protected_branches/${encodeURIComponent(defaultBranch)}`);
  if (protectedBranch.status === 200) {
    const body = record(protectedBranch.body);
    const noOne = (levels: unknown) => list(levels).every((level) => record(level).access_level === 0);
    branchProtection = {
      enabled: true,
      developersCanPush: !noOne(body.push_access_levels),
      forcePushAllowed: body.allow_force_push === true,
      codeOwnerApprovalRequired: body.code_owner_approval_required === true,
      requiredReviews: null,
    };
  } else if (protectedBranch.status === 404) {
    // The project itself was readable, so a 404 here means the default branch is not protected.
    branchProtection = {
      enabled: false,
      developersCanPush: true,
      forcePushAllowed: true,
      codeOwnerApprovalRequired: false,
      requiredReviews: 0,
    };
  }

  // Approval rules are a paid feature: unavailable means unknown, never zero.
  const approvals = await api(`/projects/${String(id)}/approvals`);
  if (approvals.status === 200 && branchProtection) {
    const required = Number(record(approvals.body).approvals_before_merge ?? NaN);
    if (Number.isFinite(required)) branchProtection.requiredReviews = required;
  }

  let twoFactorRequired: boolean | null = null;
  const groupPath =
    group ??
    (typeof record(data.namespace).full_path === "string" && record(data.namespace).kind === "group"
      ? String(record(data.namespace).full_path)
      : undefined);
  if (groupPath) {
    const response = await api(`/groups/${encodeURIComponent(groupPath)}`);
    const flag = record(response.body).require_two_factor_authentication;
    if (response.status === 200 && typeof flag === "boolean") twoFactorRequired = flag;
  }

  return {
    production: true,
    repository: typeof data.path_with_namespace === "string" ? data.path_with_namespace : projectPath,
    defaultBranch,
    visibility: typeof data.visibility === "string" ? data.visibility : null,
    archived: data.archived === true,
    branchProtection,
    group: { twoFactorRequired },
  };
}
