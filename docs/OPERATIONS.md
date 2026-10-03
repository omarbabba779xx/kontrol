# Installing and operating Kontrol

## Supported versions

| Component | Version |
|---|---|
| Node.js | 24 (see `.nvmrc`; `engines` enforces `>=24 <25`) |
| npm | 11 |
| PostgreSQL (production profile) | 15 or later with row-level security |
| SQLite (evaluation and single-node profile) | embedded through better-sqlite3 |
| OPA (policy parity tests and Rego checks) | 1.4.2 (CI installs it) |

## Install

```bash
nvm use                 # Node 24
npm ci                  # exact versions from package-lock.json
npm run verify          # lint, types, tests on both databases, build; reports passed, failed and NOT RUN
```

On **Windows** `npm ci` may try to compile `better-sqlite3` from source and fail without the Visual Studio build tools, although the package ships a prebuilt binary. Use `npm run setup` instead: it installs exactly the locked versions without running install scripts, then runs the two that matter (`esbuild`, `unrs-resolver`).

`npm ci --dry-run` fails if `package.json` and `package-lock.json` disagree; `npm run verify` includes it as its first step.

## Reading the verification report

`npm run verify` prints one line per step, and each is one of:

- **PASSED**: it ran and succeeded. For tests the line also gives passed, failed and skipped counts, and the reason each skipped test was skipped (for example live-account tests that need your tokens).
- **FAILED**: it ran and failed, or a test run executed nothing.
- **NOT RUN**: it could not run here, with the reason (for example OPA without its binary). A step that did not run is never shown as green. `npm run verify:strict` also exits non-zero for a required step that did not run and includes the end-to-end suite; that is what CI should use.

## Merging only when checks pass

CI (`.github/workflows/ci.yml`) has two required jobs: `check` (lint, types, Rego, SQLite and PostgreSQL tests, build, audit) and `e2e`. To make them block a merge, protect `main` in the repository settings and require both status checks (Settings, Branches, "Require status checks to pass before merging"). Branch protection on a private repository needs a plan that supports it. Kontrol itself reads this setting from GitHub and reports it (control CTL-SDLC-004).

## Configuration for production

Set these before the first start; the application refuses to start in production without valid secrets.

| Variable | Purpose |
|---|---|
| `KONTROL_AUTH_SECRET`, `KONTROL_SIGNING_SECRET`, `KONTROL_SECRETS_KEY` | Three distinct random values of at least 32 characters |
| `KONTROL_DB_DRIVER=postgres`, `POSTGRES_URL` | The unprivileged login the application connects as |
| `POSTGRES_MIGRATION_URL`, `KONTROL_RUNTIME_LOGIN` | Owner connection used only for migrations, and the runtime login to grant the application role to |
| `KONTROL_BOOTSTRAP_ADMIN_EMAIL`, `OIDC_*` | First administrator and single sign-on |
| `KONTROL_METRICS_TOKEN` | Enables `/api/metrics` (24+ characters); without it the endpoint does not exist |
| `KONTROL_SCHEDULER=true` | Run scheduled collections in this process |
| `KONTROL_LOG_LEVEL` | `debug`, `info` (default), `warn` or `error` |

An empty production database starts with **no data**. Demonstration data loads only with `KONTROL_SEED=true`.

### PostgreSQL roles

`infra/postgres/roles.sql` creates `kontrol_owner` (owns the schema; migrations only) and `kontrol_login` (the application; unprivileged). In production the application refuses to start if its connection is a superuser, has BYPASSRLS or owns the tables, because any of those can read across tenants (set `KONTROL_ALLOW_PRIVILEGED_DB=true` only to accept that risk knowingly). Inside every transaction the application further drops to the `kontrol_app` role, which has no table ownership and cannot update or delete the audit log.

## Backup and restore

What must be backed up: the database, the document vault, and the keys, each kept apart from the others.

| What | SQLite profile | PostgreSQL profile |
|---|---|---|
| Database | `npm run backup -- create <folder>` (consistent online snapshot) | `pg_dump` or the platform's snapshot |
| Documents | included in the same folder (files are already encrypted) | copy `KONTROL_VAULT_DIR`, or rely on the bucket's replication when S3 is used |
| Keys | **not included**: `KONTROL_SECRETS_KEY` and anything in `KONTROL_SECRETS_KEY_PREVIOUS`, plus the two signing secrets | same |

```bash
npm run backup -- create  /backups/2026-10-03
npm run backup -- verify  /backups/2026-10-03     # hashes, vault files, audit chains end where they did
npm run backup -- restore /backups/2026-10-03 /new/kontrol.db /new/vault   # only into empty locations
```

A restore is useful only with the original keys: credentials and documents do not open without them, and the application says which key is missing. Restoring never overwrites a live database; restore elsewhere, check, then switch. The suite restores a backup and verifies the audit chain, a document and a credential from the restored copy (`tests/backup.test.ts`); run a real restore drill on your own infrastructure at least once.

## Rotating the encryption key

1. Generate a new key. Set `KONTROL_SECRETS_KEY` to it and put the old value in `KONTROL_SECRETS_KEY_PREVIOUS`. Restart. Everything still opens.
2. As an administrator, run the rotation (`POST /api/admin` with `{"action":"rotate_keys"}`). Credentials and documents are re-sealed under the new key; the response lists anything that could not be.
3. When it reports `complete: true`, remove the old key from `KONTROL_SECRETS_KEY_PREVIOUS`.

The signing secrets are separate (see below).

## Signatures: what HMAC does and does not give

Decision manifests, evidence-pack manifests, webhook reports and vault records are signed with HMAC-SHA-256 under a server-held secret.

- It proves that **someone holding the secret** produced or approved the content, and that it has not changed since. An auditor cannot verify it alone: they need the organisation to confirm it or recompute it with the key.
- It is **not a non-repudiable signature**: anyone with the secret can forge one, including the operator. The tamper evidence that does not depend on the secret is the hash-chained audit log and the SHA-256 of each document, which anyone can recompute.
- Rotating `KONTROL_SIGNING_SECRET` makes earlier signatures unverifiable by the application; keep the old secret to verify history, or record the manifest fingerprints in an external system.
- For non-repudiation use asymmetric signatures (a KMS or HSM key) in front of the manifest fingerprint; that is not built in.

## Logs, metrics and alerts

- Logs are JSON, one object per line (`time`, `level`, `event`, fields). Secrets are redacted by field name and by value. Events to alert on: `collection.failed`, `vault.integrity_failure`.
- `/api/metrics` (Prometheus text, bearer token) exposes failing collections, the age of the oldest success, workflows waiting for approval, undelivered notifications and open findings. It serves counts, never contents.
- In the application, repeated collection failures, a workflow waiting more than three days for approval, expiring attestations and risk acceptances, and overdue requests raise notifications to the configured channels.

## Several instances

Safe today: schedule execution (an atomic claim per schedule with an expiring lease), the notification outbox, database migrations (advisory lock) and the webhook replay table all coordinate through the database.

**Not shared yet:** the request rate limiter is per process, so the effective limit is the configured one multiplied by the number of instances. Behind several instances apply rate limiting at the edge (gateway or WAF). Local vault files live on one node's disk, so use S3 (or a shared volume) when running more than one instance.
