<p align="center"><img src="docs/banner.svg" alt="Kontrol: governance you can prove" width="100%"></p>

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
- **Signed decisions.** Decisions seal their evidence manifest, conditions and rationale with a signature anyone can verify with the public key at `/api/signing-key`. With `KONTROL_SIGNING_KMS_KEY_ID` the key lives in AWS KMS and never enters the process. The audit chain head is anchored on a schedule and written to an S3 bucket under an Object Lock retention (or to an HTTPS sink), so removing the newest entries is detectable.
- **Real multi-tenancy.** On PostgreSQL every tenant table is under *forced* row-level security; a query that forgets its `WHERE` still cannot cross tenants. This is tested against a real PostgreSQL engine.
- **Human accountability.** Workflows pause for approval; the requester cannot approve their own request and an approval can only happen once. Agents are read-only and advisory.
- **Standards.** OSCAL 1.1.3 assessment-results export, OIDC with PKCE, FAIR-inspired Monte Carlo risk quantification with reproducible seeds.
- **Multi-framework compliance hub.** ISO/IEC 27001:2022 (clauses 4-10 and all 93 Annex A controls), NIST CSF 2.0 (all 106 subcategories), SOC 2, GDPR (42 articles), NIS2, DORA, EU AI Act, ISO/IEC 42001 (clauses and all 38 controls), PCI DSS 4.0 and CIS Controls v8 (all 153 safeguards), mapped through 56 framework-neutral *unified controls*: implement once, score everywhere. Scores are capped when live evidence contradicts an attested control.
- **A management system, not only controls.** `/isms` keeps the records of ISO/IEC 27001 clauses 4 to 10 (context, interested parties, approved scope, objectives and their measurements, management reviews with frozen inputs, nonconformities with a second-person effectiveness review) and checks them clause by clause. Records that exist, are approved and are current back the governance controls they stand for ([docs/ISMS.md](docs/ISMS.md)).
- **A risk method the organisation owns.** A likelihood x impact matrix with your own thresholds, or NIST SP 800-30 Rev. 1 (threat source, threat event, vulnerability, two-part likelihood, Tables G-5 and I-2). A risk appetite decides what needs a management decision. Each risk traces to its asset, its controls and the requirements they satisfy; the statement of applicability justifies each control by the risks it treats, and the risk treatment plan exports as a spreadsheet.
- **COBIT 2019 and capability levels.** The 40 governance and management objectives are in the catalogue, and every requirement of every framework shows a capability level from 0 to 5 that is held back by what the evidence supports. A target level can be set per objective, and the framework view reports the gap to it.
- **Evidence that is actually collected.** 33 executable controls (GitHub, GitLab, AWS, Okta, Google Workspace, Microsoft Entra, and signed HR and learning-system reports) verify what people attest. A fact that cannot be read is skipped, never failed. Organisational claims expire, need a second person where the organisation says so, and can be backed by reviewed documents or by the management system's own records.
- **Two policy engines that must agree.** Control policies run in TypeScript and are cross-checked by Open Policy Agent; a parity suite compares both on thousands of cases and a disagreement in production raises a drift event.
- **Honest about what is real.** Unconfigured services show as *standby*, demo-sourced evidence is tagged and scored lower, benchmark cohorts are labelled synthetic.

## What is inside

| Area | Status | Notes |
| --- | --- | --- |
| Domain model, policy engine, evidence hashing, findings | Implemented | Bitemporal obligation, asset and control records with a relationship graph |
| Audit hash chain, signed decisions | Implemented | Append-only, fork-proof, covered by tamper tests |
| RBAC, JWT sessions, OIDC (PKCE), rate limiting | Implemented | Fails closed in production without strong secrets |
| Durable workflows with approval gates | Implemented | Retries with back-off, separation of duties |
| Collectors (GitHub, GitLab, AWS, Okta, Google Workspace, Entra), HR/LMS webhook and control pack | Live with credentials, demo otherwise | 33 executable controls; demo evidence is tagged and trust-scored lower; unreadable facts are skipped, not failed |
| Evidence trust, drift, contradictions, digital twin, third-party concentration | Implemented | Assurance Studio at `/assurance` |
| Regulatory feeds and diff, policy compiler (NL → Rego + tests) | Implemented | HTTPS-only, SSRF-guarded; mappings require human review |
| Evidence vault, case management, continuous authorization, attack paths, benchmarks | Implemented | Enterprise workspace at `/enterprise`; S3 Object Lock when configured |
| **Compliance hub** (`/compliance`) | **Implemented** | 13 catalogues (COBIT 2019 by identifier and name; Moroccan Law 05-20 and Law 09-08 by article), 56 unified controls, crosswalk with a published basis for NIST CSF and per-tenant review (validate, reject, add), scoring, Statement of Applicability export, signed PDF audit-readiness report, gap roadmap, risk-acceptance exceptions with separation of duties, policy register, score trend |
| **ISMS** (`/isms`) | **Implemented** | 21 checks over clauses 4 to 10 and incident management; context, scope, objectives, planned changes, competence, communication, incidents, internal audit programme, management reviews, nonconformities |
| **Risk method, identification and traceability** (`/risk-register`) | **Implemented** | Matrix or NIST SP 800-30, appetite, asset valuation (C/I/A), a threat library, scenarios per asset, traceability to requirements, treatment plan export |
| **PostgreSQL with forced RLS** | **Implemented** | `KONTROL_DB_DRIVER=postgres`; migration tool from SQLite included |
| OPA cross-check, S3 Object Lock | Optional | OPA evaluates the same policies via `infra/opa/policy.rego`; reported as standby unless reachable |
| Specialist agents | Deterministic by default | Optional model gateway; read-only tools |

![Enterprise platform](docs/screenshots/enterprise-platform.png)

## Quick start

```bash
npm ci            # Node 24; on Windows use `npm run setup` (see docs/OPERATIONS.md)
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
| `KONTROL_AUTH_SECRET`, `KONTROL_SIGNING_SECRET` | Session signing and the development signing key. **Required in production**, distinct, 32+ characters |
| `KONTROL_SIGNING_KEY` | Ed25519 private key (PEM, or its base64) that signs decisions, reports and audit anchors. **Required in production**; `npm run keys:signing` makes one |
| `KONTROL_TRUSTED_PROXY_HOPS` | Proxies in front of the app that append to `X-Forwarded-For`; 0 (default) ignores the header for rate limits |
| `OIDC_ALLOWED_DOMAINS`, `OIDC_DOMAIN_TENANTS` | Email domains that may create accounts at first SSO sign-in (default organisation, or `domain=tenant_id` pairs). Unset means sign-in by invitation only |
| `KONTROL_DB_DRIVER`, `POSTGRES_URL` | Storage driver (`sqlite` default, `postgres` for production) |
| `KONTROL_SEED` | Load the demonstration tenant. **Opt-in in production** (`true` to load it); on by default elsewhere (`false` to skip) |
| `KONTROL_BOOTSTRAP_ADMIN_EMAIL`, `KONTROL_BOOTSTRAP_TENANT_NAME`, `OIDC_DEFAULT_TENANT_ID` | On an empty database, create the first organisation and its administrator (who then signs in through the identity provider). Without demo data this is how the first person gets in |
| `KONTROL_SECRETS_KEY`, `KONTROL_SECRETS_KEY_PREVIOUS` | Key that encrypts stored credentials and vault documents (**required in production**). To rotate: set the new key, keep the old one in `KONTROL_SECRETS_KEY_PREVIOUS`, restart, run the key rotation from Administration (`POST /api/admin {"action":"rotate_keys"}`), then drop the old key |
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
npm run test:live       # read-only checks against your own GitHub, Okta and AWS (skipped unless you set credentials)
```

The suite covers the audit chain (tampering, deletion, concurrent writers, append-only enforcement), decision signatures, policy semantics, authentication and RBAC, CSRF, workflow separation of duties, SSRF protection, OSCAL output, tenant isolation, the SQLite to PostgreSQL migration, the HTTP handlers, the framework catalogues and crosswalk, the compliance engine, the collectors (including the real AWS SDK against Moto), attestations, evidence review, the signed webhook, licensed-content import, the PDF report and the browser flows. CI runs it all, plus a production-image build and health check.

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

See [architecture](docs/ARCHITECTURE.md), the [security policy](SECURITY.md) and the [threat model](docs/THREAT_MODEL.md), which lists who could falsify the record, what stops them and what is still open.

## Compliance hub

`/compliance` turns the platform into a multi-framework GRC workspace.

- **Unified controls.** Each of the 56 controls lists the requirements it advances in every framework; sub-requirements inherit their group's mapping unless refined. `tests/frameworks.test.ts` fails the build if any requirement of any framework is unmapped, if a reference points at nothing, or if a catalogue loses an item.
- **A published basis where one exists.** Links are corroborated by NIST's CSF 2.0 informative references (to ISO 27001, PCI DSS and CIS) and by ENISA's NIS2 mapping table, with the source named on each link; what those sources imply but the mapping lacks is offered as a suggestion. The crosswalk is also measured against the independent Secure Controls Framework: 85.7% of testable links are corroborated. See [docs/CROSSWALK.md](docs/CROSSWALK.md).
- **Mapping review.** A reviewer can validate or reject any built-in link, accept a suggestion, or add a link, each with a note. Rejected and added links change the scores for that tenant only, and every review is chained in the audit log.
- **Scoring.** A requirement scores the mean of its controls (implemented 1, partial 0.5, planned 0.15, not started 0). Controls out of scope and requirements excluded with a written justification leave the denominator. A unified control linked to executable controls is *verified* by their latest evidence; one failing control caps it at partial and raises a contradiction alert.
- **Evidence.** `Install the pack` adds the executable controls, a connector sync evaluates them, and `Link evidence` attaches them to the unified controls they verify. Linking never changes an attested status: evidence verifies a claim, it does not make one.
- **Attestations that expire.** A claim gets a review date (a year for *implemented*, six months for *partial*, three for *planned*). Past that date, and when nothing else backs it, it counts as partial until the owner re-attests. A second person can countersign (the attester cannot), and a change to the claim voids the countersignature. `KONTROL_REQUIRE_COUNTERSIGN=true` makes an unconfirmed claim count as partial.
- **Documentary evidence.** A document is uploaded to the hashed, signed evidence vault against a control and stays pending until a different person accepts it; it then marks the control *documented* while it is valid. Machine evidence outranks documents: a failing control is not rescued by a PDF.
- **People systems.** HR and learning systems post signed reports (`/api/ingest/lms`, `/api/ingest/hris`) evaluated by the same control pack: training completion, leaver deprovisioning, screening. HMAC-SHA-256 per-tenant secrets, five-minute clock window, database-backed replay protection. See [docs/LIVE_TESTING.md](docs/LIVE_TESTING.md).
- **Licensed content.** Standards bodies license some text (PCI DSS testing procedures, SOC 2 points of focus). An administrator can import the organisation's own licensed copy: it is stored for that tenant only with the licence acknowledgement and a content hash, never in the repository, and can be removed at any time. Imported sub-requirements inherit their parent's mapping and replace the parent in the score.
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
| HR and learning systems (signed webhook) | Training completion, leavers deprovisioned on time, screening before start |

Collectors are written against injected clients and tested at three levels: responses (the GitHub fixtures in `tests/fixtures/github` were recorded from api.github.com), the real AWS SDK against Moto, a server that speaks the AWS wire protocols (`tests/aws-moto.test.ts`), and your own accounts through opt-in read-only live tests (`npm run test:live`, [docs/LIVE_TESTING.md](docs/LIVE_TESTING.md)). Control policies use 17 operators (`eq`, `gt`, `between`, `in`, `matches`, `within_days`, `older_than_days`, `length_gte`, and more) in `all` / `any` / `none` groups, and every operator fails closed. Regular expressions are length-bounded and reject nested quantifiers.

### Policy engines

`infra/opa/policy.rego` re-implements the operators in Rego. When `OPA_URL` is set, every control evaluation is also sent to OPA: the TypeScript verdict stays authoritative, and a disagreement opens a `policy_engine_divergence` drift event. `tests/opa.test.ts` starts a real OPA and compares both engines on several thousand condition and fact combinations; it found and fixed three divergences while it was being written.

## Known limits

- Per-user rate limits are per process; limits on sign-in, public endpoints and authentication failures are shared through the database and fall back to per-process if it is unreachable. Schedules are claimed with a database lease, so several instances can run the scheduler; that has not been load-tested.
- **COBIT.** Only identifiers and names are carried. Objectives outside information security (portfolio, budget, innovation, programmes) have no built-in control: map them yourself, exclude them with a justification, or give them a target of 0. The mapping of the others is editorial. COBIT's design factors are not modelled: you set the target levels they would lead to.
- **NIST SP 800-30.** The assessment scales are those of Rev. 1, Table G-5 (overall likelihood) and Table I-2 (level of risk), checked cell by cell against the NIST publication. Ratings, the appetite and acceptance decisions use NIST's five levels as they are.
- Evidence objects go to S3 with Object Lock when configured; otherwise a local folder is used and flagged as a fallback.
- **Labs.** The digital twin, attack paths and benchmarking work on modelled or synthetic data. They are hidden unless `NEXT_PUBLIC_KONTROL_LABS=true`.
- **Catalogue depth.** Without an import, PCI DSS is at section level and SOC 2 at criterion level. Importing your licensed copy takes both further; the EU regulations cover the articles that bind the entity, not the whole text.
- **Crosswalk.** Sourced and measured, but a judgement. Published sources corroborate part of it, an independent comparison corroborates 85.7%, and per-tenant review makes the rest visible. It supports, and never replaces, an expert or certification body ([docs/CROSSWALK.md](docs/CROSSWALK.md)).
- **Live accounts.** The GitHub collector has been run against a real private repository of a personal account (`npm run test:live`), which is how the Dependabot fallback was found and fixed. It has not been run against a GitHub organisation. The AWS collectors run against a protocol-faithful server and Okta against recorded and documented responses; neither has been run against a real account. Run `npm run test:live` against yours before relying on them.
- **Unvalidated judgements.** The readiness levels, capability levels, ISMS checks, threat library and COBIT mapping are design choices that no real audit has confirmed. [docs/VALIDATION.md](docs/VALIDATION.md) lists what is checked against an outside reference, what is not, and how to validate the rest with your own audit.
- **SQLite.** It separates organisations by a filter in each query, so several organisations on SQLite are refused in production; use PostgreSQL, which enforces the separation with row-level security.
- **Regular expressions in policies** are bounded twice: patterns that can backtrack badly are refused, and any match that runs past 25 ms is stopped and counts as no match.
- **Organisational controls** cannot be machine-verified. They are attestations that expire, optionally countersigned, optionally backed by reviewed documents, or fed by your HR and learning systems.

> Kontrol supports governance work; it does not provide legal advice or issue certification opinions.
