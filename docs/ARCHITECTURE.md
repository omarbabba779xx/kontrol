# Kontrol architecture

Kontrol is a decision-assurance control plane, not a checklist manager. Its core object graph connects obligations → controls → assets → evidence → findings → risks → decisions.

## Runtime flow

1. A connector collects facts from GitHub, AWS or Okta and records source, time window, method and SHA-256 hash.
2. The policy engine evaluates the facts against an executable control and opens, updates or closes a finding, in one transaction together with the evidence row and its audit entry.
3. A durable workflow advances one idempotent step at a time, retries failures with back-off and pauses for human approval. The requester cannot approve their own workflow, and a workflow can only be approved once.
4. Risk scenarios use a seeded FAIR-inspired Monte Carlo model, so results are reproducible and comparable.
5. Decisions seal their evidence manifest, rationale and conditions with an HMAC signature.
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

## Testing

`npm test` runs the suite on SQLite; `npm run test:postgres` runs the same suite on an in-process PostgreSQL (PGlite) served over a socket, so the real PostgreSQL driver, row-level security and migration path are exercised without external services. Tamper scenarios (edited or deleted audit rows, altered decisions) are simulated through owner-level access that bypasses the application guards.
