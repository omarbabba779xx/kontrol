# Security policy

Kontrol handles evidence, control results and approval records. Treat deployments as security-sensitive systems of record.

## Supported configuration

- Disable `KONTROL_AUTH_MODE=demo` outside isolated evaluation environments.
- Supply unique high-entropy authentication, signing and cron secrets through a secret manager.
- Use least-privilege GitHub, AWS and Okta service identities; never expose connector tokens to the browser.
- Put evidence objects in versioned, retention-locked object storage and encrypt data in transit and at rest.
- Run `KONTROL_DB_DRIVER=postgres` for multi-tenant production deployments and connect with a role that is not a superuser. The application drops to a non-bypass role and every tenant table is under forced row-level security.
- Set `KONTROL_SEED=false` so the demonstration tenant is never created.

## Built-in protections

- Production startup fails closed on missing, short, placeholder or duplicated signing and session secrets.
- Session tokens are pinned to HS256 with issuer, audience and role validation; cookie sessions reject cross-origin mutations.
- Decision signatures are compared in constant time; the cron bearer token likewise.
- Approvals enforce separation of duties: the requester of a workflow cannot approve it.
- Outbound regulatory fetches are HTTPS-only, refuse credentials, private and internal addresses, and do not follow redirects.
- The audit log is append-only (triggers; the runtime role has no `UPDATE`/`DELETE` privilege on PostgreSQL) and chains cannot fork under concurrent writers.
- Tenant isolation is enforced by the database on PostgreSQL, not only by query filters.
- Requests are rate limited per actor (`KONTROL_RATE_LIMIT_PER_MINUTE`).
- OIDC-provisioned users default to `viewer` unless `OIDC_TRUST_ROLE_CLAIM=true`.

## Threat model

Who has an interest in falsifying the record, what stops them and what is still open: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Trust boundaries

AI analysis is advisory and read-only. It cannot approve decisions, change mappings or close findings. Human approval and a signed decision record are required for material actions. External evidence is untrusted until hashed, normalized and evaluated.

## Reporting

Do not open a public issue for a suspected vulnerability. Send a minimal reproduction, affected version and impact to the private security contact configured by the deploying organization.

## Webhook ingest and imported content

- `/api/ingest/*` is authenticated only by an HMAC-SHA-256 signature over `timestamp.body` with a per-tenant derived secret. Requests outside a five-minute window are refused, each accepted signature is stored and cannot be replayed, bodies are capped at 256 KB, and an unknown tenant and a bad signature are indistinguishable. Without `KONTROL_INGEST_SECRET` (32+ characters) the endpoint answers 503.
- Licensed-content imports are administrator-only, require an explicit licence acknowledgement that is recorded with a content hash, are size-limited, validated completely before any write, rendered as plain text, and removable at any time.
- Regular expressions in control policies are length-bounded and reject back-references and nested quantifiers.

## Documents, keys and retention

- **Local vault documents are encrypted at rest** with AES-256-GCM, using a key derived from `KONTROL_SECRETS_KEY`. The tenant and document id are authenticated, so a file copied to another document or tenant does not open. Files written before encryption existed are still read (their hash is verified) and are encrypted by the next key rotation.
- **Every read verifies the document** against the SHA-256 recorded at upload. A document that fails authentication or the hash is refused with an explicit integrity error and is never served or placed in an audit pack.
- **Key rotation** keeps data readable throughout: previous keys are listed in `KONTROL_SECRETS_KEY_PREVIOUS`, and the rotation action re-seals credentials and documents under the current key and reports anything it could not re-seal.
- **Retention and deletion.** A document is kept at least until its retention date (one year by default). After that an administrator can delete it; its record, hash and the fact of deletion remain in the audit chain, and the content and extracted text are removed. A document that is still evidence for a control cannot be deleted. Deletion applies to the local vault; documents in S3 follow the bucket Object Lock and lifecycle rules, which the application cannot override.
- **Text extracted from documents is encrypted in the database** (AES-256-GCM, bound to the row, same key and rotation as the vault; read through an audited endpoint). **What is not encrypted by the application:** the rest of the database (evidence results, findings, names, audit entries) relies on the disk or managed-database encryption of the deployment; evidence JSON must stay readable because its hash is chained. Use an encrypted volume or managed database encryption.
- **Empty production start.** Demonstration data is never loaded in production unless `KONTROL_SEED=true`. The first administrator is created from `KONTROL_BOOTSTRAP_ADMIN_EMAIL` on an empty database and signs in through the identity provider; no password or secret is created.
