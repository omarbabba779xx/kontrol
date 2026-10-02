import type { Policy } from "@/lib/core/policy-engine";

export type ConnectorKind = "github" | "aws" | "okta" | "people" | "google_workspace" | "entra" | "gitlab";

/** An executable control shipped with Kontrol. It is evaluated against facts collected from a live system. */
export type PackControl = {
  code: string;
  title: string;
  objective: string;
  connector: ConnectorKind;
  frequency: "hourly" | "daily" | "monthly";
  /** How long a result stays current as evidence (default 1 day). Monthly feeds from HR and learning systems need longer. */
  validForDays?: number;
  policy: Policy;
  /**
   * Fact paths that must be available for the verdict to mean anything. When a collector could not read one
   * (missing permission, service not enabled) the control is skipped rather than failed, so a gap in access
   * never masquerades as a gap in compliance.
   */
  requires: string[];
};

export const PACK: PackControl[] = [
  {
    code: "CTL-SDLC-004", title: "Production branch protection", objective: "Prevent unreviewed changes to production code.", connector: "github", frequency: "hourly",
    policy: { all: [{ path: "production", op: "eq", value: true }, { path: "branchProtection.enabled", op: "eq", value: true }, { path: "branchProtection.requiredReviews", op: "gte", value: 1 }] },
    requires: ["branchProtection.enabled"],
  },
  {
    code: "CTL-GH-002", title: "Secret scanning with push protection", objective: "Detect and block credentials committed to source control.", connector: "github", frequency: "daily",
    policy: { all: [{ path: "security.secretScanning", op: "eq", value: "enabled" }, { path: "security.pushProtection", op: "eq", value: "enabled" }] },
    requires: ["security.secretScanning", "security.pushProtection"],
  },
  {
    code: "CTL-GH-003", title: "Automated dependency vulnerability handling", objective: "Known-vulnerable dependencies are alerted and fixed by pull request.", connector: "github", frequency: "daily",
    policy: { all: [{ path: "vulnerabilityAlertsEnabled", op: "eq", value: true }, { path: "security.dependabotSecurityUpdates", op: "eq", value: "enabled" }] },
    requires: ["vulnerabilityAlertsEnabled", "security.dependabotSecurityUpdates"],
  },
  {
    code: "CTL-GH-004", title: "Branch protection applies to administrators", objective: "Reviews cannot be bypassed by privileged accounts and stale approvals are dismissed.", connector: "github", frequency: "daily",
    policy: { all: [{ path: "branchProtection.enforceAdmins", op: "eq", value: true }, { path: "branchProtection.dismissStaleReviews", op: "eq", value: true }] },
    requires: ["branchProtection.enforceAdmins"],
  },
  {
    code: "CTL-GH-005", title: "Organisation requires two-factor authentication", objective: "Every member of the source-control organisation authenticates with a second factor.", connector: "github", frequency: "daily",
    policy: { all: [{ path: "org.twoFactorRequired", op: "eq", value: true }] },
    requires: ["org.twoFactorRequired"],
  },
  {
    code: "CTL-AWS-001", title: "Root account protected", objective: "The AWS root user has MFA and no access keys.", connector: "aws", frequency: "daily",
    policy: { all: [{ path: "root.mfaEnabled", op: "eq", value: true }, { path: "root.accessKeysPresent", op: "eq", value: 0 }] },
    requires: ["root.mfaEnabled", "root.accessKeysPresent"],
  },
  {
    code: "CTL-AWS-002", title: "IAM password policy", objective: "Passwords are at least 14 characters and cannot be recycled quickly (CIS AWS Foundations).", connector: "aws", frequency: "daily",
    policy: { all: [{ path: "passwordPolicy.exists", op: "eq", value: true }, { path: "passwordPolicy.minimumLength", op: "gte", value: 14 }, { path: "passwordPolicy.reusePrevention", op: "gte", value: 24 }] },
    requires: ["passwordPolicy.exists"],
  },
  {
    code: "CTL-AWS-003", title: "S3 public access blocked", objective: "Every bucket has the four S3 Block Public Access settings enabled.", connector: "aws", frequency: "daily",
    policy: { all: [{ path: "s3.withoutPublicAccessBlock", op: "eq", value: 0 }] },
    requires: ["s3.withoutPublicAccessBlock"],
  },
  {
    code: "CTL-AWS-004", title: "AWS Config resources compliant", objective: "No resource is non-compliant with the enabled AWS Config rules.", connector: "aws", frequency: "daily",
    policy: { all: [{ path: "config.nonCompliantResources", op: "eq", value: 0 }] },
    requires: ["config.nonCompliantResources"],
  },
  {
    code: "CTL-AWS-005", title: "CloudTrail multi-region logging", objective: "A multi-region trail is logging with log file validation enabled.", connector: "aws", frequency: "daily",
    policy: { all: [{ path: "cloudTrail.multiRegionTrails", op: "gte", value: 1 }, { path: "cloudTrail.logging", op: "eq", value: true }, { path: "cloudTrail.logValidation", op: "eq", value: true }] },
    requires: ["cloudTrail.multiRegionTrails"],
  },
  {
    code: "CTL-OKTA-001", title: "Administrators enrolled in MFA", objective: "Every identity with an administrator role has an active second factor.", connector: "okta", frequency: "daily",
    policy: { all: [{ path: "privileged.mfaCoverage", op: "eq", value: 1 }] },
    requires: ["privileged.mfaCoverage"],
  },
  {
    code: "CTL-OKTA-002", title: "No dormant accounts", objective: "Active accounts without a sign-in for 90 days are disabled.", connector: "okta", frequency: "daily",
    policy: { all: [{ path: "users.inactiveOver90Days", op: "eq", value: 0 }] },
    requires: ["users.inactiveOver90Days"],
  },
  {
    code: "CTL-OKTA-003", title: "Password policy strength", objective: "Every active Okta password policy requires at least 12 characters.", connector: "okta", frequency: "daily",
    policy: { all: [{ path: "passwordPolicy.minLength", op: "gte", value: 12 }] },
    requires: ["passwordPolicy.minLength"],
  },
  {
    code: "CTL-HR-001", title: "Security awareness training completed", objective: "At least 95% of the workforce has completed security awareness training, as reported by the learning system.", connector: "people", frequency: "monthly", validForDays: 35,
    policy: { all: [{ path: "training.completionRate", op: "gte", value: 0.95 }] },
    requires: ["training.completionRate"],
  },
  {
    code: "CTL-HR-002", title: "Leavers deprovisioned on time", objective: "No departed employee or contractor still holds access beyond the allowed delay, as reported by the HR system.", connector: "people", frequency: "monthly", validForDays: 35,
    policy: { all: [{ path: "hr.overdueDeprovisioning", op: "eq", value: 0 }] },
    requires: ["hr.overdueDeprovisioning"],
  },
  {
    code: "CTL-HR-003", title: "Screening completed before start", objective: "Every active starter completed background screening before their start date, as reported by the HR system.", connector: "people", frequency: "monthly", validForDays: 35,
    policy: { all: [{ path: "hr.unscreenedActiveStarters", op: "eq", value: 0 }] },
    requires: ["hr.unscreenedActiveStarters"],
  },
  {
    code: "CTL-GWS-001", title: "2-Step Verification enrolled for every active user", objective: "Every active Google Workspace account is enrolled in 2-Step Verification.", connector: "google_workspace", frequency: "daily", validForDays: 2,
    policy: { all: [{ path: "users.twoStepCoverage", op: "eq", value: 1 }] },
    requires: ["users.twoStepCoverage"],
  },
  {
    code: "CTL-GWS-002", title: "Super administrators use 2-Step Verification", objective: "No Google Workspace super administrator is without 2-Step Verification.", connector: "google_workspace", frequency: "daily", validForDays: 2,
    policy: { all: [{ path: "admins.superAdminsWithout2Sv", op: "eq", value: 0 }] },
    requires: ["admins.superAdminsWithout2Sv"],
  },
  {
    code: "CTL-GWS-003", title: "No dormant Google Workspace accounts", objective: "Active accounts without a sign-in for 90 days are suspended.", connector: "google_workspace", frequency: "daily", validForDays: 2,
    policy: { all: [{ path: "users.inactiveOver90Days", op: "eq", value: 0 }] },
    requires: ["users.inactiveOver90Days"],
  },
  {
    code: "CTL-GWS-004", title: "Few super administrators", objective: "Between two and five super administrators: enough for continuity, few enough to control.", connector: "google_workspace", frequency: "daily", validForDays: 2,
    policy: { all: [{ path: "admins.superAdmins", op: "between", value: [2, 5] }] },
    requires: ["admins.superAdmins"],
  },
  {
    code: "CTL-ENTRA-001", title: "Entra ID administrators registered for MFA", objective: "Every Entra ID administrator has registered a multi-factor method.", connector: "entra", frequency: "daily", validForDays: 2,
    policy: { all: [{ path: "mfa.adminsWithoutMfa", op: "eq", value: 0 }] },
    requires: ["mfa.adminsWithoutMfa"],
  },
  {
    code: "CTL-ENTRA-002", title: "Conditional Access requires MFA for all users", objective: "An enabled Conditional Access policy requires MFA for all users and all applications.", connector: "entra", frequency: "daily", validForDays: 2,
    policy: { all: [{ path: "conditionalAccess.mfaForAllUsers", op: "eq", value: true }] },
    requires: ["conditionalAccess.mfaForAllUsers"],
  },
  {
    code: "CTL-ENTRA-003", title: "Legacy authentication blocked", objective: "An enabled Conditional Access policy blocks legacy authentication protocols for all users.", connector: "entra", frequency: "daily", validForDays: 2,
    policy: { all: [{ path: "conditionalAccess.legacyAuthBlocked", op: "eq", value: true }] },
    requires: ["conditionalAccess.legacyAuthBlocked"],
  },
  {
    code: "CTL-ENTRA-004", title: "No dormant Entra ID accounts", objective: "Enabled member accounts without a successful sign-in for 90 days are disabled.", connector: "entra", frequency: "daily", validForDays: 2,
    policy: { all: [{ path: "users.inactiveOver90Days", op: "eq", value: 0 }] },
    requires: ["users.inactiveOver90Days"],
  },
  {
    code: "CTL-GL-001", title: "GitLab default branch protected", objective: "The default branch accepts no direct pushes and no force pushes.", connector: "gitlab", frequency: "hourly",
    policy: { all: [{ path: "branchProtection.enabled", op: "eq", value: true }, { path: "branchProtection.developersCanPush", op: "eq", value: false }, { path: "branchProtection.forcePushAllowed", op: "eq", value: false }] },
    requires: ["branchProtection.enabled"],
  },
  {
    code: "CTL-GL-002", title: "GitLab merge request approvals required", objective: "At least one approval is required before merging to the default branch.", connector: "gitlab", frequency: "daily",
    policy: { all: [{ path: "branchProtection.requiredReviews", op: "gte", value: 1 }] },
    requires: ["branchProtection.requiredReviews"],
  },
  {
    code: "CTL-GL-003", title: "GitLab group requires two-factor authentication", objective: "Every member of the GitLab group must use two-factor authentication.", connector: "gitlab", frequency: "daily",
    policy: { all: [{ path: "group.twoFactorRequired", op: "eq", value: true }] },
    requires: ["group.twoFactorRequired"],
  },
];

/** Which executable controls provide machine evidence for which unified control. Suggestions, applied on request. */
export const SUGGESTED_LINKS: Record<string, string[]> = {
  "UC-SDL-01": ["CTL-SDLC-004", "CTL-GH-002", "CTL-GH-004", "CTL-GL-001", "CTL-GL-002"],
  "UC-OPS-02": ["CTL-GH-003"],
  "UC-OPS-01": ["CTL-AWS-004"],
  "UC-OPS-04": ["CTL-AWS-003"],
  "UC-DAT-04": ["CTL-AWS-003"],
  "UC-OPS-05": ["CTL-AWS-005"],
  "UC-IAM-01": ["CTL-OKTA-002", "CTL-HR-002", "CTL-GWS-003", "CTL-ENTRA-004"],
  "UC-HR-01": ["CTL-HR-003"],
  "UC-HR-02": ["CTL-HR-001"],
  "UC-IAM-02": ["CTL-AWS-001", "CTL-AWS-002", "CTL-OKTA-001", "CTL-OKTA-003", "CTL-GH-005", "CTL-GL-003", "CTL-GWS-001", "CTL-ENTRA-002", "CTL-ENTRA-003"],
  "UC-IAM-03": ["CTL-AWS-001", "CTL-OKTA-001", "CTL-GWS-002", "CTL-GWS-004", "CTL-ENTRA-001"],
};

/** Fact path lookup shared by the pack and the policy engine. */
export function factAt(facts: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => (current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined), facts);
}

/** Paths a control needs that the collector could not provide. */
export function missingFacts(control: PackControl, facts: Record<string, unknown>) {
  return control.requires.filter((path) => { const value = factAt(facts, path); return value === undefined || value === null; });
}
