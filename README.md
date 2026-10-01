# Kontrol

**Continuous decision assurance.** Kontrol turns regulatory obligations and live operational facts into executable controls, traceable findings, quantified risk and cryptographically signed decisions.

[![CI](https://github.com/omarbabba779xx/kontrol/actions/workflows/ci.yml/badge.svg)](https://github.com/omarbabba779xx/kontrol/actions/workflows/ci.yml)
![Next.js 16](https://img.shields.io/badge/Next.js-16-black)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Storage](https://img.shields.io/badge/storage-SQLite%20%7C%20PostgreSQL%20RLS-2f6f4f)

![Control plane](docs/screenshots/control-plane.png)

Most GRC tools stop at a checklist. Kontrol connects the whole chain and keeps it verifiable:

```mermaid
flowchart LR
    O[Obligation] -->|satisfied by| C[Executable control]
    C -->|evaluated on| F[Live facts<br/>GitHub · AWS · Okta]
    F --> E[Hashed evidence]
    E --> X{Policy result}
    X -->|fail| N[Finding]
    X -->|pass| K[Closed finding]
    N --> R[Quantified risk<br/>P50 / P90 / P95]
    R --> D[Signed decision]
    D --> A[(Append-only<br/>hash-chained audit log)]
    E --> A
    N --> A
```

## Highlights

- **Executable controls.** Policies are data: conditions over facts with explained failures (`all` / `any`, typed operators that fail closed). Every evaluation produces SHA-256 hashed evidence and opens, updates or closes a finding atomically.
- **Tamper-evident ledger.** Every material event joins a per-tenant hash chain. Rows are append-only (triggers on both drivers, privileges on PostgreSQL), chains cannot fork under concurrency, and verification is one call.
- **Signed decisions.** Decisions seal their evidence manifest, conditions and rationale with an HMAC signature that is verified in constant time.
- **Real multi-tenancy.** On PostgreSQL every tenant table is under *forced* row-level security; a query that forgets its `WHERE` still cannot cross tenants. This is tested against a real PostgreSQL engine.
- **Human accountability.** Workflows pause for approval; the requester cannot approve their own request and an approval can only happen once. Agents are read-only and advisory.
- **Standards.** OSCAL 1.1.3 assessment-results export, OIDC with PKCE, FAIR-inspired Monte Carlo risk quantification with reproducible seeds.
- **Honest about what is real.** Unconfigured services show as *standby*, demo-sourced evidence is tagged and scored lower, benchmark cohorts are labelled synthetic.

## What is inside

| Area | Status | Notes |
| --- | --- | --- |
| Domain model, policy engine, evidence hashing, findings | Implemented | Bitemporal obligation, asset and control records with a relationship graph |
| Audit hash chain, signed decisions | Implemented | Append-only, fork-proof, covered by tamper tests |
| RBAC, JWT sessions, OIDC (PKCE), rate limiting | Implemented | Fails closed in production without strong secrets |
| Durable workflows with approval gates | Implemented | Retries with back-off, separation of duties |
| GitHub / AWS / Okta collectors | Live with credentials, demo otherwise | Demo evidence is tagged and trust-scored lower |
| Evidence trust, drift, contradictions, digital twin, third-party concentration | Implemented | Assurance Studio at `/assurance` |
| Regulatory feeds and diff, policy compiler (NL → Rego + tests) | Implemented | HTTPS-only, SSRF-guarded; mappings require human review |
| Evidence vault, case management, continuous authorization, attack paths, benchmarks | Implemented | Enterprise workspace at `/enterprise`; S3 Object Lock when configured |
| **PostgreSQL with forced RLS** | **Implemented** | `KONTROL_DB_DRIVER=postgres`; migration tool from SQLite included |
| OPA, S3 Object Lock | Probed, optional | Reported as standby unless reachable |
| Specialist agents | Deterministic by default | Optional model gateway; read-only tools |

![Enterprise platform](docs/screenshots/enterprise-platform.png)

## Quick start

```bash
npm install
cp .env.example .env.local      # on Windows: copy .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. Development uses embedded SQLite, the seeded *Acme* tenant and demo authentication. Nothing else is required.

```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/connectors/github/sync \
  -H "Content-Type: application/json" \
  -d '{"owner":"acme","repository":"lending-decision-service","assetId":"asset_repo_lending","demo":true}'
curl http://localhost:3000/api/oscal/export -o assessment-results.json
```

## Run on PostgreSQL

```bash
docker compose up -d postgres minio minio-init opa
POSTGRES_URL=postgres://kontrol:kontrol@localhost:5432/kontrol KONTROL_DB_DRIVER=postgres npm run dev
```

Or run the whole stack, with the application on PostgreSQL:

```bash
export KONTROL_AUTH_SECRET=$(openssl rand -hex 32) KONTROL_SIGNING_SECRET=$(openssl rand -hex 32)
docker compose --profile app up -d --build
```

Already have data in SQLite? Move it, with row counts and audit chains re-verified on the target:

```bash
POSTGRES_URL=postgres://… npm run db:migrate
```

## Configuration

Every setting is documented in [`.env.example`](.env.example). The ones that matter most:

| Variable | Purpose |
| --- | --- |
| `KONTROL_AUTH_SECRET`, `KONTROL_SIGNING_SECRET` | Session and decision signing. **Required in production**, distinct, 32+ characters |
| `KONTROL_DB_DRIVER`, `POSTGRES_URL` | Storage driver (`sqlite` default, `postgres` for production) |
| `KONTROL_SEED` | Seed the demo tenant into an empty database (`false` in production) |
| `KONTROL_AUTH_MODE` | `demo` is honoured only outside production |
| `OIDC_*`, `OIDC_TRUST_ROLE_CLAIM` | Single sign-on; new users are `viewer` unless the IdP is trusted for roles |
| `GITHUB_TOKEN`, `AWS_*`, `OKTA_*` | Live collectors (demo data when absent) |
| `AI_GATEWAY_API_KEY`, `KONTROL_AGENT_MODEL` | Optional model-backed agents |
| `KONTROL_RATE_LIMIT_PER_MINUTE` | Per-actor request budget |

## API

An [OpenAPI description](docs/openapi.yaml) covers every endpoint and the permission it requires. Roles: `admin`, `risk_owner`, `control_owner`, `auditor`, `viewer`.

## Quality gates

```bash
npm run check           # lint, typecheck, tests on SQLite, tests on PostgreSQL, production build
npm test                # SQLite
npm run test:postgres   # in-process PostgreSQL (PGlite) over a socket: real driver, real RLS, migration
```

The suite covers the audit chain (tampering, deletion, concurrent writers, append-only enforcement), decision signatures, policy semantics, authentication and RBAC, CSRF, workflow separation of duties, SSRF protection, OSCAL output, tenant isolation, the SQLite → PostgreSQL migration and the HTTP handlers.

## Project layout

```
src/app/            Next.js routes (UI pages and /api handlers)
src/components/     Interface components
src/lib/core/       Policy, risk, workflow, assurance and enterprise engines; auth; integrity
src/lib/db/         Storage layer: SQLite and PostgreSQL drivers, schema, RLS, seed, migration
src/lib/connectors/ GitHub, AWS and Okta collectors
src/lib/agents/     Read-only specialist agents
infra/opa/          Rego policies
docs/               Architecture and OpenAPI
tests/              Test suite (runs on both drivers)
```

See [architecture](docs/ARCHITECTURE.md) and the [security policy](SECURITY.md).

## Known limits

- The rate limiter and workflow scheduler are per process; run a shared limiter at the edge and a single scheduler (or an external cron hitting `/api/jobs/run`) when scaling out.
- Evidence objects go to S3 with Object Lock when configured; otherwise a local folder is used and flagged as a fallback.
- Benchmarking uses a disclosed synthetic cohort; connect an approved aggregation service before making peer claims.

> Kontrol supports governance work; it does not provide legal advice or issue certification opinions.
