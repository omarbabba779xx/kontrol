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
- **Multi-framework compliance hub.** ISO/IEC 27001:2022 (clauses 4-10 and all 93 Annex A controls), NIST CSF 2.0 (all 106 subcategories), SOC 2, GDPR (42 articles), NIS2, DORA, EU AI Act, ISO/IEC 42001 (clauses and all 38 controls), PCI DSS 4.0 and CIS Controls v8 (all 153 safeguards), mapped through 56 framework-neutral *unified controls*: implement once, score everywhere. Scores are capped when live evidence contradicts an attested control.
- **Evidence that is actually collected.** 13 executable controls for GitHub, AWS and Okta verify what people attest. A fact that cannot be read is skipped, never failed.
- **Two policy engines that must agree.** Control policies run in TypeScript and are cross-checked by Open Policy Agent; a parity suite compares both on thousands of cases and a disagreement in production raises a drift event.
- **Honest about what is real.** Unconfigured services show as *standby*, demo-sourced evidence is tagged and scored lower, benchmark cohorts are labelled synthetic.

## What is inside

| Area | Status | Notes |
| --- | --- | --- |
| Domain model, policy engine, evidence hashing, findings | Implemented | Bitemporal obligation, asset and control records with a relationship graph |
| Audit hash chain, signed decisions | Implemented | Append-only, fork-proof, covered by tamper tests |
| RBAC, JWT sessions, OIDC (PKCE), rate limiting | Implemented | Fails closed in production without strong secrets |
| Durable workflows with approval gates | Implemented | Retries with back-off, separation of duties |
| GitHub / AWS / Okta collectors and control pack | Live with credentials, demo otherwise | 13 executable controls; demo evidence is tagged and trust-scored lower; unreadable facts are skipped, not failed |
| Evidence trust, drift, contradictions, digital twin, third-party concentration | Implemented | Assurance Studio at `/assurance` |
| Regulatory feeds and diff, policy compiler (NL → Rego + tests) | Implemented | HTTPS-only, SSRF-guarded; mappings require human review |
| Evidence vault, case management, continuous authorization, attack paths, benchmarks | Implemented | Enterprise workspace at `/enterprise`; S3 Object Lock when configured |
| **Compliance hub** (`/compliance`) | **Implemented** | 10 complete catalogues, 56 unified controls, crosswalk with a published basis for NIST CSF and per-tenant review (validate, reject, add), scoring, Statement of Applicability export, signed PDF audit-readiness report, gap roadmap, risk-acceptance exceptions with separation of duties, policy register, score trend |
| **PostgreSQL with forced RLS** | **Implemented** | `KONTROL_DB_DRIVER=postgres`; migration tool from SQLite included |
| OPA cross-check, S3 Object Lock | Optional | OPA evaluates the same policies via `infra/opa/policy.rego`; reported as standby unless reachable |
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
npm test                # SQLite (runs the OPA parity test when an `opa` binary is on PATH or in KONTROL_OPA_BIN)
npm run test:postgres   # in-process PostgreSQL (PGlite) over a socket: real driver, real RLS, migration
npm run test:opa        # opa check --strict and opa test on infra/opa
npm run test:e2e        # Playwright against a throwaway database, with axe accessibility checks
```

The suite covers the audit chain (tampering, deletion, concurrent writers, append-only enforcement), decision signatures, policy semantics, authentication and RBAC, CSRF, workflow separation of duties, SSRF protection, OSCAL output, tenant isolation, the SQLite to PostgreSQL migration, the HTTP handlers, the framework catalogues and crosswalk, the compliance engine, the collectors, the PDF report and the browser flows. CI runs it all, plus a production-image build and health check.

## Project layout

```
src/app/            Next.js routes (UI pages and /api handlers)
src/components/     Interface components
src/lib/core/       Policy, risk, workflow, assurance and enterprise engines; auth; integrity
src/lib/db/         Storage layer: SQLite and PostgreSQL drivers, schema, RLS, seed, migration
src/lib/frameworks/ Framework catalogues, unified-control crosswalk, scoring (pure, no I/O)
src/lib/connectors/ GitHub, AWS and Okta collectors, executable control pack
src/lib/agents/     Read-only specialist agents
infra/opa/          Rego policies (generic evaluator with unit tests, plus the SDLC control)
docs/               Architecture and OpenAPI
tests/              Test suite (runs on both drivers)
e2e/                Playwright end-to-end suite
```

See [architecture](docs/ARCHITECTURE.md) and the [security policy](SECURITY.md).

## Compliance hub

`/compliance` turns the platform into a multi-framework GRC workspace.

- **Unified controls.** Each of the 56 controls lists the requirements it advances in every framework; sub-requirements inherit their group's mapping unless refined. `tests/frameworks.test.ts` fails the build if any requirement of any framework is unmapped, if a reference points at nothing, or if a catalogue loses an item.
- **A published basis where one exists.** NIST CSF 2.0 links are derived from the informative references NIST publishes for ISO/IEC 27001:2022 (`scripts/generate-csf-data.py`), and each link shows whether it is *published* or *editorial*.
- **Mapping review.** A reviewer can validate or reject any built-in link, or add one, each with a note. Rejected and added links change the scores for that tenant only, and every review is chained in the audit log.
- **Scoring.** A requirement scores the mean of its controls (implemented 1, partial 0.5, planned 0.15, not started 0). Controls out of scope and requirements excluded with a written justification leave the denominator. A unified control linked to executable controls is *verified* by their latest evidence; one failing control caps it at partial and raises a contradiction alert.
- **Evidence.** `Install the pack` adds the executable controls, a connector sync evaluates them, and `Link evidence` attaches them to the unified controls they verify. Linking never changes an attested status: evidence verifies a claim, it does not make one.
- **Roadmap.** Incomplete controls are ranked by requirements advanced across the adopted frameworks, divided by typical effort.
- **Exceptions.** Risk acceptances expire within 365 days, cannot be decided by their requester and can be decided only once.
- **Exports.** `GET /api/compliance/frameworks/iso27001?format=csv` produces a Statement of Applicability (spreadsheet formulas are neutralised). `GET /api/compliance/report` produces a PDF audit-readiness report whose SHA-256 fingerprint and HMAC signature are also appended to the audit chain.
- **Sample data.** The *sample posture* is demonstration data, tagged `demo` row by row. `Purge the sample` removes exactly those rows and leaves real attestations, policies, adoptions and decisions untouched; it cannot be loaded on top of real data.

### Executable controls

| Connector | Controls |
| --- | --- |
| GitHub | Branch protection, secret scanning with push protection, Dependabot, protection applies to administrators, organisation 2FA |
| AWS | Root MFA and keys, IAM password policy, S3 public access block, Config compliance, multi-region CloudTrail |
| Okta | Administrator MFA, dormant accounts, password policy |

Collectors are written against injected clients and tested with API responses: the GitHub fixtures in `tests/fixtures/github` were recorded from api.github.com, and AWS and Okta use the documented response shapes. They have not been run against a live AWS or Okta tenant in CI. Control policies use 17 operators (`eq`, `gt`, `between`, `in`, `matches`, `within_days`, `older_than_days`, `length_gte`, and more) in `all` / `any` / `none` groups, and every operator fails closed. Regular expressions are length-bounded and reject nested quantifiers.

### Policy engines

`infra/opa/policy.rego` re-implements the operators in Rego. When `OPA_URL` is set, every control evaluation is also sent to OPA: the TypeScript verdict stays authoritative, and a disagreement opens a `policy_engine_divergence` drift event. `tests/opa.test.ts` starts a real OPA and compares both engines on several thousand condition and fact combinations; it found and fixed three divergences while it was being written.

## Known limits

- The rate limiter and workflow scheduler are per process; run a shared limiter at the edge and a single scheduler (or an external cron hitting `/api/jobs/run`) when scaling out.
- Evidence objects go to S3 with Object Lock when configured; otherwise a local folder is used and flagged as a fallback.
- Benchmarking uses a disclosed synthetic cohort; connect an approved aggregation service before making peer claims.
- **Catalogue depth.** PCI DSS is at section level (x.y) and SOC 2 at criterion level: the testing procedures and points of focus are licensed content and are not reproduced. The EU regulations cover the articles that bind the entity, not the whole text.
- **Crosswalk.** Only the NIST CSF to ISO/IEC 27001 links have a published basis. The rest is editorial and meant to be reviewed per tenant in the hub. Mappings support, and never replace, an expert or certification body.
- **Collectors.** Not yet run against live AWS or Okta tenants in CI, and organisational controls (training, management review) can only be attested, not machine-verified.

> Kontrol supports governance work; it does not provide legal advice or issue certification opinions.
