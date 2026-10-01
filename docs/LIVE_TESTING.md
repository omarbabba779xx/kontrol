# Testing the collectors against real accounts

The collectors are tested in three layers. Only the last one needs your accounts.

| Layer | What it proves | Needs |
| --- | --- | --- |
| Recorded and documented responses (`tests/connectors.test.ts`, `tests/fixtures/github`) | Parsing, "unreadable is not failed", pagination | nothing |
| AWS wire protocols against Moto (`tests/aws-moto.test.ts`) | The real AWS SDK, real error codes, real XML and JSON parsing | `pip install "moto[server]"` |
| **Live accounts** (`tests/live/live.test.ts`) | The above holds against *your* GitHub, Okta and AWS | credentials you provide |

## Running the live checks

The live tests are read-only, never run in CI, and are skipped unless the variables below are set. They print a verdict
per control but assert only structure, because whether your account passes is not a test failure. Put the values in your
shell or in an untracked `.env.local`; never commit them. Kontrol never asks you to paste credentials into the application or into a chat.

```bash
# GitHub: a fine-grained token with read access to Administration and Metadata on a test repository
export KONTROL_LIVE_GITHUB_TOKEN=...
export KONTROL_LIVE_GITHUB_REPO=your-org/your-test-repo

# Okta: a free developer organisation is enough. Token with okta.users.read, okta.roles.read, okta.policies.read
export KONTROL_LIVE_OKTA_URL=https://your-org.okta.com
export KONTROL_LIVE_OKTA_TOKEN=...

# AWS: uses your default credential chain. Use a sandbox account; the calls are read-only
export KONTROL_LIVE_AWS=1
export AWS_REGION=eu-west-1

npm run test:live
```

Minimum permissions: GitHub `Administration: read` (branch protection, security settings) and `Metadata: read`; AWS
`iam:GetAccountSummary`, `iam:GetAccountPasswordPolicy`, `s3:ListAllMyBuckets`, `s3:GetBucketPublicAccessBlock`,
`config:GetComplianceSummaryByConfigRule`, `cloudtrail:DescribeTrails`, `cloudtrail:GetTrailStatus`; Okta the read scopes above.

A control the token is not allowed to read is reported as `skipped (unreadable: ...)`, not as a failure. If you see a
control skipped that you expected to run, that is the permission to add.

## Webhook reports from HR and learning systems

HR and learning systems post signed reports instead of being polled. Set `KONTROL_INGEST_SECRET` (32+ characters), then derive
each tenant's secret:

```bash
KONTROL_INGEST_SECRET=... npm run ingest:secret -- tenant_acme
```

Sign `${timestamp}.${body}` with HMAC-SHA-256 and send it as `X-Kontrol-Signature: sha256=<hex>` together with
`X-Kontrol-Tenant` and `X-Kontrol-Timestamp` (unix seconds). Sources: `POST /api/ingest/lms` with
`{ "asOf": "<ISO date>", "training": { "enrolled": 120, "completed": 117 } }` and `POST /api/ingest/hris` with
`{ "asOf": "<ISO date>", "hr": { "overdueDeprovisioning": 0, "unscreenedActiveStarters": 0 } }`. Reports must be at most 35 days old,
cannot be replayed, and are evaluated by the same executable controls as the other connectors.
