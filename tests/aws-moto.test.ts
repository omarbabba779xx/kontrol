import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { after, before, test } from "node:test";
import { CloudTrailClient, CreateTrailCommand, StartLoggingCommand } from "@aws-sdk/client-cloudtrail";
import { ConfigServiceClient } from "@aws-sdk/client-config-service";
import { IAMClient, UpdateAccountPasswordPolicyCommand } from "@aws-sdk/client-iam";
import { CreateBucketCommand, PutPublicAccessBlockCommand, S3Client } from "@aws-sdk/client-s3";
import { collectAws, type AwsClients } from "../src/lib/connectors/collectors";
import { PACK } from "../src/lib/connectors/pack";
import { evaluatePolicy } from "../src/lib/core/policy-engine";
import { admin, isolateDatabase } from "./setup";

isolateDatabase();

/**
 * These tests run the real AWS SDK against Moto, a server that speaks the AWS wire protocols (query/XML for IAM,
 * REST/XML for S3, JSON for CloudTrail), so the collectors are exercised on real requests, real error codes and real
 * response parsing rather than on hand-written objects. They run when `moto_server` is available
 * (`pip install "moto[server]"`, or set KONTROL_MOTO_BIN); CI installs it.
 */
const binary = process.env.KONTROL_MOTO_BIN ?? "moto_server";
const available = spawnSync(binary, ["--help"], { encoding: "utf8" }).status === 0;
const skip = available ? false : "moto_server not available (pip install \"moto[server]\")";

let server: ChildProcess | undefined;
let endpoint = "";
let clients: AwsClients;
let raw: { iam: IAMClient; s3: S3Client; cloudtrail: CloudTrailClient };

before(async () => {
  if (!available) return;
  const port = 19_000 + Math.floor(Math.random() * 900);
  endpoint = `http://127.0.0.1:${port}`;
  server = spawn(binary, ["-H", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${endpoint}/moto-api/`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const common = { region: "eu-west-1", endpoint, credentials: { accessKeyId: "test", secretAccessKey: "test" } };
  raw = { iam: new IAMClient(common), s3: new S3Client({ ...common, forcePathStyle: true }), cloudtrail: new CloudTrailClient(common) };
  clients = { iam: raw.iam, s3: raw.s3, config: new ConfigServiceClient(common), cloudtrail: raw.cloudtrail } as unknown as AwsClients;
});

after(() => { server?.kill(); });

const verdicts = (facts: Record<string, unknown>) => Object.fromEntries(PACK.filter((control) => control.connector === "aws").map((control) => [control.code, evaluatePolicy(control.policy, facts).passed]));

test("a fresh AWS account fails the controls it should fail, using real error codes", { skip }, async () => {
  const facts = await collectAws(clients, "eu-west-1");
  assert.equal((facts.root as { mfaEnabled: boolean }).mfaEnabled, false);
  assert.equal((facts.passwordPolicy as { exists: boolean }).exists, false, "NoSuchEntity from the IAM wire protocol is understood");
  assert.equal((facts.s3 as { buckets: number }).buckets, 0);
  assert.equal((facts.cloudTrail as { multiRegionTrails: number }).multiRegionTrails, 0);
  const result = verdicts(facts);
  assert.equal(result["CTL-AWS-001"], false);
  assert.equal(result["CTL-AWS-002"], false);
  assert.equal(result["CTL-AWS-005"], false);
});

test("hardening the account is detected end to end", { skip }, async () => {
  await raw.iam.send(new UpdateAccountPasswordPolicyCommand({ MinimumPasswordLength: 16, PasswordReusePrevention: 24, RequireSymbols: true, RequireNumbers: true, MaxPasswordAge: 90 }));
  for (const name of ["kontrol-logs", "kontrol-data", "kontrol-open"]) await raw.s3.send(new CreateBucketCommand({ Bucket: name, CreateBucketConfiguration: { LocationConstraint: "eu-west-1" } }));
  const block = { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true };
  await raw.s3.send(new PutPublicAccessBlockCommand({ Bucket: "kontrol-logs", PublicAccessBlockConfiguration: block }));
  await raw.s3.send(new PutPublicAccessBlockCommand({ Bucket: "kontrol-data", PublicAccessBlockConfiguration: block }));
  await raw.cloudtrail.send(new CreateTrailCommand({ Name: "org-trail", S3BucketName: "kontrol-logs", IsMultiRegionTrail: true, EnableLogFileValidation: true }));
  await raw.cloudtrail.send(new StartLoggingCommand({ Name: "org-trail" }));

  const facts = await collectAws(clients, "eu-west-1");
  assert.deepEqual(facts.passwordPolicy, { exists: true, minimumLength: 16, reusePrevention: 24, maxPasswordAge: 90, requireSymbols: true, requireNumbers: true });
  const s3 = facts.s3 as { buckets: number; withoutPublicAccessBlock: number; unchecked: number };
  assert.equal(s3.buckets, 3);
  assert.equal(s3.withoutPublicAccessBlock, 1, "NoSuchPublicAccessBlockConfiguration marks the open bucket");
  assert.equal(s3.unchecked, 0);
  const trail = facts.cloudTrail as { multiRegionTrails: number; logging: boolean; logValidation: boolean };
  assert.deepEqual(trail, { trails: 1, multiRegionTrails: 1, logging: true, logValidation: true });

  const result = verdicts(facts);
  assert.equal(result["CTL-AWS-002"], true);
  assert.equal(result["CTL-AWS-005"], true);
  assert.equal(result["CTL-AWS-003"], false, "one bucket still allows public access");
});

test("a full sync through the real SDK stores evidence and opens a finding for the open bucket", { skip }, async () => {
  const { syncAws } = await import("../src/lib/connectors");
  const { getDb } = await import("../src/lib/db");
  const result = await syncAws(admin, "eu-west-1", clients);
  assert.equal(result.mode, "live");
  const failed = result.evaluations.filter((item) => !item.passed).map((item) => item.controlCode);
  assert.ok(failed.includes("CTL-AWS-003"));
  assert.ok(!failed.includes("CTL-AWS-005"));
  const findings = await (await getDb()).scope(admin.tenantId).all<{ title: string }>("SELECT title FROM findings WHERE tenant_id = ? AND status = 'open'", admin.tenantId);
  assert.ok(findings.some((finding) => finding.title.includes("S3 public access blocked")));
});
