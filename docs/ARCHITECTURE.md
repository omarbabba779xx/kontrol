# Kontrol architecture

Kontrol is a decision-assurance control plane, not a checklist manager. Its core object graph connects obligations → controls → assets → evidence → findings → risks → decisions.

## Runtime flow

1. A connector collects facts from GitHub, AWS or Okta and records source, time window, method and SHA-256 hash.
2. The policy engine evaluates the facts against an executable control and opens, updates or closes a finding, in one transaction together with the evidence row and its audit entry.
3. A durable workflow advances one idempotent step at a time, retries failures with back-off and pauses for human approval. The requester cannot approve their own workflow, and a workflow can only be approved once.
4. Risk scenarios use a seeded FAIR-inspired Monte Carlo model, so results are reproducible and comparable.
5. Decisions seal their evidence manifest, rationale and conditions with an Ed25519 signature (`src/lib/core/signing.ts`); verification needs only the public key.
6. Every material event is chained to the previous audit hash; the control plane recomputes the chain on demand.

## Storage

All persistence goes through `src/lib/db`, an asynchronous, dialect-portable layer with two drivers that share one schema and one SQL dialect (`?` placeholders, no vendor functions):

| | SQLite (default) | PostgreSQL |
| --- | --- | --- |
| Select | nothing to configure | `KONTROL_DB_DRIVER=postgres`, `POSTGRES_URL` |
| Use | development, evaluation, single node | production, multi-tenant |
| Isolation | application-level `tenant_id` filters | **forced row-level security** on every tenant table |
| Transactions | `BEGIN IMMEDIATE`, serialised | pooled connections, per-transaction role and tenant |

Callers obtain a **scope**: `db.scope(tenantId)` for tenant work and `db.system()` for the few operations that have no tenant yet (bootstrap, authentication lookups, health, migration). On PostgreSQL each statement runs in a transaction that switches to the non-bypass role `kontrol_app` and sets `app.tenant_id`; the policy on every table is `tenant_id = current_setting('app.tenant_id')`, `FORCE`d so even table owners are subject to it. A query that forgets its `WHERE tenant_id = ?` still cannot read or write another tenant's rows, and this is covered by tests that run against a real PostgreSQL engine.

The schema is created on start-up by the driver (`CREATE … IF NOT EXISTS`, plus the row-level security statements on PostgreSQL). The demonstration tenant is seeded only into an empty database; set `KONTROL_SEED=false` for production.

### Ledger guarantees

- `audit_log` is append-only: database triggers reject `UPDATE` and `DELETE` on both drivers, and on PostgreSQL the runtime role is granted only `SELECT` and `INSERT` on it.
- A tenant's chain cannot fork: writers are serialised per tenant (advisory lock on PostgreSQL, `BEGIN IMMEDIATE` on SQLite) and unique indexes on `(tenant_id, previous_hash)` are the backstop.
- Hash chain verification is independent of the storage layer (`verifyAuditChainRows`), so it also runs after a migration.

### Migrating from SQLite to PostgreSQL

```bash
POSTGRES_URL=postgres://… KONTROL_DATABASE_PATH=.data/kontrol.db npm run db:migrate
```

The tool copies every table in dependency order, preserves audit sequence numbers, advances the identity sequence, compares row counts and re-verifies each tenant's hash chain on the target. It refuses to run against a non-empty target. Afterwards set `KONTROL_DB_DRIVER=postgres`.

## Supporting services

`docker compose up -d postgres minio minio-init opa` starts PostgreSQL, S3-compatible object storage with object lock and Open Policy Agent. `docker compose --profile app up -d --build` also runs the application on PostgreSQL. The readiness probe reports what is really reachable (and, on PostgreSQL, how many tables have row-level security forced); unconfigured services are shown as standby, never healthy.

## AI safety model

Six role-specific agents query scoped facts and graph relations. Without `AI_GATEWAY_API_KEY` and `KONTROL_AGENT_MODEL` they return deterministic local analysis. With both set, the model call is routed through the configured gateway. Responses include provenance and assumptions. Agent tools are read-only; mutations remain authenticated API operations with RBAC and approval gates.

## Enterprise control plane

PostgreSQL, OPA and S3 are probed rather than assumed. Regulatory monitoring stores source hashes (outbound fetches are HTTPS-only and SSRF-guarded), the policy compiler emits both Rego and deterministic tests, the evidence vault maintains signed version chains, and continuous authorization can revoke a grant when evidence trust or findings violate its conditions.

Attack paths connect technical entry points to business assets, obligations and financial exposure. Case management and workflow definitions preserve human accountability. Executive metrics and benchmarks are derived from tenant records; the included reference cohort is labelled synthetic and must be replaced with an approved privacy-preserving aggregation service before making peer claims.

## Compliance hub

`src/lib/frameworks` is pure data and arithmetic (no I/O, shared by tests and server): the framework catalogues (`catalog.ts`, `data/`), the unified-control library (`unified.ts`), the crosswalk resolver (`mapping.ts`: group inheritance, hand refinements, NIST-published derivation, link basis) and scoring (`scoring.ts`: `scoreFramework`, `buildRoadmap`, `crosswalk`, `overlapMatrix`, all taking optional per-tenant mapping overrides). `src/lib/core/compliance-engine.ts` adds persistence: tenants store only their own state (`framework_adoptions`, `control_implementations`, `requirement_scope`, `compliance_exceptions`, `policy_register`, `compliance_snapshots`, `mapping_reviews`), all under forced row-level security. The catalogue itself is versioned in code, not per tenant; `mapping.ts` also resolves official crosswalk data (`data/csf-data.ts`, `data/enisa-data.ts`, generated by scripts) into link sources and suggestions. Rows created by the sample posture carry `source = 'demo'` (or `attested` once a person edits them), which is what the purge keys on.

A unified control can be linked to several executable controls (comma-separated codes). The engine reads the latest evidence of each: all healthy marks the control *verified*, any failed caps its weight at 0.5 and surfaces a contradiction, expired evidence marks it *stale*. Trend points are written only when a score moves.

`src/lib/core/report.ts` renders the PDF audit-readiness report with `pdf-lib`, fingerprints the canonical report data, signs it and anchors the fingerprint in the audit chain.

## Evidence, attestations and licensed content

A unified control's `verification` combines three sources, in this order: failing machine evidence, healthy machine evidence, then a valid accepted document; anything weaker is *stale* (it existed and lapsed) or *unverified*. Attestations carry a review date; a lapsed attestation that nothing backs, or an unconfirmed one when countersignature is required, caps the control at partial. `control_evidence` rows are filed through the vault (`storeVaultDocument`), start `pending`, and are decided once by someone other than the uploader.

`src/lib/core/ingest.ts` accepts signed reports from HR and learning systems. Each tenant has a derived secret (`HMAC(master, "ingest:" + tenantId)`), requests are signed over `timestamp.body`, replay is prevented by a unique `(tenant, signature)` row, and unknown tenants and bad signatures return the same answer. Reports are evaluated by the people controls of the pack with a 35-day evidence validity.

`src/lib/core/licensed-content.ts` imports an organisation's licensed text and sub-requirements. They live in `custom_requirements`, `licensed_content` and `content_imports` under row-level security, are validated completely before anything is written, and replace the framework's previous import atomically. `MappingOverrides.custom` carries them into scoring: a sub-requirement inherits its parent's controls (walking up through imported parents) and replaces the parent in the score.

## Executable controls and policy engines

`src/lib/connectors/pack.ts` defines the control pack: each control has a policy and the fact paths it `requires`. `collectors.ts` turns API responses into facts and is written against injected clients. A fact a collector could not read is `null`; a control with a missing required fact is skipped and reported, so lack of access is never recorded as non-compliance. `index.ts` installs the pack, evaluates it on every sync and stores raw facts as hashed evidence.

`policy-engine.ts` evaluates `all` / `any` / `none` condition groups with fail-closed operators. `infra/opa/policy.rego` implements the same semantics and `opa.ts` cross-checks each evaluation when `OPA_URL` is set; the TypeScript verdict is authoritative and a disagreement opens a `policy_engine_divergence` drift event.

## Testing

`npm test` runs the suite on SQLite; `npm run test:postgres` runs the same suite on an in-process PostgreSQL (PGlite) served over a socket, so the real PostgreSQL driver, row-level security and migration path are exercised without external services. Tamper scenarios (edited or deleted audit rows, altered decisions) are simulated through owner-level access that bypasses the application guards.
