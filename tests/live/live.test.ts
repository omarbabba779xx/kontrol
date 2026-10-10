import assert from "node:assert/strict";
import { test } from "node:test";
import { collectAws, collectGitHub, collectOkta, type JsonResponse } from "../../src/lib/connectors/collectors";
import { PACK, missingFacts } from "../../src/lib/connectors/pack";
import { evaluatePolicy } from "../../src/lib/core/policy-engine";

/**
 * Live checks against your own accounts. They never run in CI and never run unless you provide credentials in the
 * environment (see docs/LIVE_TESTING.md). They are read-only, and they assert structure and honesty (facts are either
 * present or reported as unavailable), never a particular compliance verdict, because that depends on your account.
 */
const report = (connector: string, facts: Record<string, unknown>) => {
  const controls = PACK.filter((control) => control.connector === connector);
  const lines = controls.map((control) => {
    if (control.notApplicable?.(facts)) return `  n/a      ${control.code}  (not applicable: ${control.title})`;
    const missing = missingFacts(control, facts);
    return missing.length ? `  skipped  ${control.code}  (unreadable: ${missing.join(", ")})` : `  ${evaluatePolicy(control.policy, facts).passed ? "pass   " : "FAIL   "}  ${control.code}  ${control.title}`;
  });
  console.log(`\n${connector} live results\n${lines.join("\n")}\n`);
  return controls;
};

const githubToken = process.env.KONTROL_LIVE_GITHUB_TOKEN;
const githubRepo = process.env.KONTROL_LIVE_GITHUB_REPO; // owner/name

test("GitHub: collect facts from a real repository", { skip: githubToken && githubRepo ? false : "set KONTROL_LIVE_GITHUB_TOKEN and KONTROL_LIVE_GITHUB_REPO" }, async () => {
  const [owner, repository] = githubRepo!.split("/");
  const api = async (path: string): Promise<JsonResponse> => {
    const response = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
    return { status: response.status, body: response.status === 204 ? null : await response.json().catch(() => null) };
  };
  const facts = await collectGitHub(api, owner, repository);
  assert.equal(typeof facts.repository, "string");
  assert.ok("branchProtection" in facts && "vulnerabilityAlertsEnabled" in facts && "security" in facts);
  report("github", facts);
});

const oktaUrl = process.env.KONTROL_LIVE_OKTA_URL;
const oktaToken = process.env.KONTROL_LIVE_OKTA_TOKEN;

test("Okta: collect facts from a real organisation", { skip: oktaUrl && oktaToken ? false : "set KONTROL_LIVE_OKTA_URL and KONTROL_LIVE_OKTA_TOKEN" }, async () => {
  const origin = new URL(oktaUrl!).origin;
  const api = async (path: string): Promise<JsonResponse> => {
    const url = path.startsWith("http") ? new URL(path) : new URL(path, origin);
    assert.equal(url.origin, origin, "pagination must stay on the organisation's origin");
    const response = await fetch(url, { headers: { Authorization: `SSWS ${oktaToken}`, Accept: "application/json" } });
    return { status: response.status, body: await response.json().catch(() => null), link: response.headers.get("link") };
  };
  const facts = await collectOkta(api, new URL(oktaUrl!).hostname);
  assert.ok("users" in facts && "privileged" in facts && "passwordPolicy" in facts);
  report("okta", facts);
});

test("AWS: collect facts from the account behind your default credentials", { skip: process.env.KONTROL_LIVE_AWS === "1" ? false : "set KONTROL_LIVE_AWS=1 (uses your default AWS credentials, read-only calls)" }, async () => {
  const { CloudTrailClient } = await import("@aws-sdk/client-cloudtrail");
  const { ConfigServiceClient } = await import("@aws-sdk/client-config-service");
  const { IAMClient } = await import("@aws-sdk/client-iam");
  const { S3Client } = await import("@aws-sdk/client-s3");
  const region = process.env.AWS_REGION ?? "eu-west-1";
  const facts = await collectAws({ iam: new IAMClient({ region }), s3: new S3Client({ region }), config: new ConfigServiceClient({ region }), cloudtrail: new CloudTrailClient({ region }) }, region);
  assert.equal(facts.region, region);
  report("aws", facts);
});
