<p align="center"><img src="docs/banner.svg" alt="Kontrol: governance you can prove" width="100%"></p>

# Kontrol

[![CI](https://github.com/omarbabba779xx/kontrol/actions/workflows/ci.yml/badge.svg)](https://github.com/omarbabba779xx/kontrol/actions/workflows/ci.yml)
![Node.js 24](https://img.shields.io/badge/Node.js-24-171713)
![Next.js 16](https://img.shields.io/badge/Next.js-16-171713)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Storage](https://img.shields.io/badge/storage-SQLite%20%7C%20PostgreSQL%20RLS-2f6f4f)
![Frameworks](https://img.shields.io/badge/frameworks-13-f4673b)

**An information security management system and GRC platform where every claim is backed by evidence.** ISO/IEC 27001:2022,
NIST CSF 2.0, NIST SP 800-30, COBIT 2019, SOC 2, NIS2, DORA, GDPR, the EU AI Act, ISO/IEC 42001, PCI DSS, CIS Controls and Morocco's
Law 05-20 and Law 09-08 in one application: unified controls, evidence collected from your systems, the records of clauses 4 to 10, a
risk register with a method you approve, signed decisions and an audit trail that shows when it has been cut.

> Most GRC tools record what people say. Kontrol records what people say, checks it against what the systems show, and tells you where
> the two disagree.

<p align="center"><img src="docs/screenshots/decision-room.png" alt="Decision room: the state of the management system, the risks above the appetite, the compliance posture and what is waiting for a decision" width="100%"></p>

## In pictures

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/isms-clauses.png" alt="ISMS clause checklist"><p align="center"><b>ISMS</b> · 21 checks over clauses 4 to 10, what the records show and the next step</p></td>
    <td width="50%"><img src="docs/screenshots/compliance-overview.png" alt="Compliance hub overview"><p align="center"><b>Compliance hub</b> · readiness per framework, gaps, and evidence that contradicts a claim</p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/compliance-frameworks.png" alt="ISO 27001 framework view"><p align="center"><b>Frameworks</b> · every requirement, its controls, capability level and statement of applicability</p></td>
    <td width="50%"><img src="docs/screenshots/risk-register.png" alt="Risk register"><p align="center"><b>Risk register</b> · inherent and residual heat maps, appetite, treatment plans</p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/risk-identification.png" alt="Asset-based risk identification"><p align="center"><b>Identification</b> · assets valued on C, I and A, threats still to assess on each</p></td>
    <td width="50%"><img src="docs/screenshots/risk-traceability.png" alt="Risk traceability"><p align="center"><b>Traceability</b> · from asset and threat to control and requirement, and where the thread breaks</p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/isms-nonconformities.png" alt="Nonconformities"><p align="center"><b>Nonconformities</b> · cause, corrective action, and a second person to verify it worked</p></td>
    <td width="50%"><img src="docs/screenshots/isms-reviews.png" alt="Management review"><p align="center"><b>Management review</b> · inputs frozen at preparation, decisions approved by management</p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/isms-incidents.png" alt="Incident register"><p align="center"><b>Incidents</b> · the 72-hour clock for personal data, closing as a post-incident review</p></td>
    <td width="50%"><img src="docs/screenshots/isms-audits.png" alt="Internal audit programme"><p align="center"><b>Internal audit</b> · a programme, an independent auditor, findings that become nonconformities</p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/tasks.png" alt="Remediation tasks"><p align="center"><b>Remediation</b> · owned, dated work from risks, findings and reviews</p></td>
    <td width="50%"><img src="docs/screenshots/audit-workspace.png" alt="Audit workspace"><p align="center"><b>Audit workspace</b> · engagements, auditor requests and a self-verifying evidence pack</p></td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/screenshots/administration.png" alt="Administration"><p align="center"><b>Administration</b> · people and roles, API keys, connections, notifications, single sign-on</p></td>
  </tr>
</table>

<sub>Screenshots of the <a href="examples/hydria">Hydria</a> example dossier, a fictional water utility: no name, figure or person on
these pages is real. They are regenerated with <code>npm run screenshots</code>.</sub>

## Interface

A quiet, dense interface built for people who read tables all day: Instrument Serif for page titles, Geist for content, Geist Mono for
references and figures, one warm accent, and status colours that mean the same thing on every page. The main pages are
checked for accessibility (axe, WCAG 2 AA) by the browser tests. The navigation puts the management system first; the modules that work
on modelled or synthetic data are hidden unless `NEXT_PUBLIC_KONTROL_LABS=true`.

## What Kontrol does

| Module | What it holds |
| --- | --- |
| **Frameworks** | 13 catalogues: ISO/IEC 27001:2022 (clauses 4 to 10 and all 93 Annex A controls), NIST CSF 2.0 (106 subcategories), SOC 2, GDPR, NIS2, DORA, EU AI Act, ISO/IEC 42001 (with its 38 Annex A controls), PCI DSS 4.0.1, CIS Controls v8 (153 safeguards), COBIT 2019 (40 objectives by identifier and name), Morocco's Law 05-20 and Law 09-08 by article. Licensed text (PCI DSS procedures, SOC 2 points of focus, COBIT practices) can be imported by an organisation that holds the licence. |
| **Unified controls** | 56 framework-neutral controls, each linked to every requirement it serves: implement once, score everywhere. Each link says whether it rests on a published source (NIST, ENISA) or is editorial, and can be validated, rejected or added per organisation. |
| **Evidence** | 33 executable controls collected from GitHub, GitLab, AWS, Okta, Google Workspace, Microsoft Entra and signed HR and learning-system reports. A fact that cannot be read is skipped, never failed. Documents go to a hashed, signed vault and count once a second person accepts them. |
| **Scoring and readiness** | A score per requirement, a capability level from 0 to 5 held back by what the evidence supports, a target level per objective and the gap to it, and an audit-readiness level that blocks on contradicted claims, lapsed attestations and open high findings. |
| **ISMS** | The records of clauses 4 to 10: context and interested parties, approved scope, objectives and their measurements, planned changes, competence, communication, management reviews with frozen inputs, nonconformities with a second-person effectiveness review. 21 checks say what is met, partly met or missing, and what to do next. |
| **Risk** | A method the organisation approves: a 5 × 5 matrix with its own thresholds, or NIST SP 800-30 Rev. 1 on its five levels. A risk appetite, asset valuation on confidentiality, integrity and availability, a library of 30 threats, scenarios per asset, residual risk that follows the live control posture, acceptance by a second person with an expiry, FAIR-style quantification. |
| **Traceability** | From asset and threat to risk, control and requirement, and back. The statement of applicability justifies each control by the risks it treats; the risk treatment plan exports as a spreadsheet. |
| **Incidents** | A register with the 72-hour clock of GDPR Article 33 for personal data, a post-incident review at closure, and a nonconformity for anything serious. |
| **Internal audit** | A programme of audits with objectives, criteria and scope; an auditor who may not audit controls they own; findings that become nonconformities; a recorded conclusion. |
| **Audit workspace** | Engagements, auditor requests and responses, operating effectiveness over the audit period, external auditor access limited to their engagement, and an evidence pack that verifies itself. |
| **Remediation** | Tasks from risks, findings, gaps and management reviews, with owners, dates and notifications. |
| **Third parties and AI** | A DORA register of information with ICT concentration and exit readiness, vendor questionnaires, and an AI system register classified under the EU AI Act. |
| **Reports** | Statements of applicability (CSV, JSON), a signed PDF audit-readiness report, the risk treatment plan, and OSCAL 1.1.3 assessment results. |
| **Integrity** | Every material event joins a per-organisation hash chain, append-only on both databases. Decisions, reports and anchors are signed (AWS KMS or Ed25519) and verifiable with the public key alone. The chain head is anchored on a schedule to an S3 bucket under Object Lock, so a chain that has been cut back is detected. |
| **Access** | Roles (`admin`, `risk_owner`, `control_owner`, `auditor`, `viewer`), OIDC single sign-on with PKCE and nonce, invitation or allowed domains, API keys, sessions revoked at once when an account changes. |

## Getting started

Prerequisite: **Node.js 24**.

```bash
npm ci                          # on Windows: npm run setup (see docs/OPERATIONS.md)
cp .env.example .env.local      # on Windows: copy .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. Development uses embedded SQLite, a seeded sample organisation and demo sign-in; nothing else is required.

### The Hydria example dossier

To see a complete management system rather than sample rows, start from an empty database and load
[Hydria](examples/hydria), a fictional water utility:

```bash
# .env.local
KONTROL_DATABASE_PATH=.data/hydria.db
KONTROL_SEED=empty
KONTROL_INGEST_SECRET=<32 characters or more>
```

```bash
npm run dev
node examples/hydria/load-foundation.mjs
node examples/hydria/load-risk.mjs
node examples/hydria/load-operation.mjs
```

The scripts go through the public API, so every record lands in the audit chain. They end with 20 of the 21 ISMS checks met and one
partial, on purpose. [examples/hydria](examples/hydria) explains what the dossier shows, including what is not finished.

### PostgreSQL

```bash
docker compose up -d postgres minio minio-init opa
POSTGRES_URL=postgres://kontrol:kontrol@localhost:5432/kontrol KONTROL_DB_DRIVER=postgres npm run dev
```

Or the whole stack, with the application on PostgreSQL:

```bash
docker compose --profile app up -d --build
```

Data already in SQLite moves with `POSTGRES_URL=postgres://… npm run db:migrate`, with row counts and audit chains re-verified on the
target. Production refuses several organisations on SQLite: PostgreSQL enforces their separation with row-level security.

## Collecting evidence

| Connector | Controls |
| --- | --- |
| GitHub | Branch protection and its reach over administrators, secret scanning with push protection, Dependabot, code scanning, open high vulnerabilities, read-only workflow tokens, outside administrators and writable deploy keys, security policy and code owners, webhook TLS, organisation two-factor |
| GitLab | Protected branches, merge approvals, group two-factor |
| AWS | Root MFA and keys, IAM password policy, S3 public access block, Config compliance, multi-region CloudTrail |
| Okta, Google Workspace, Microsoft Entra | Administrator MFA, MFA for every user, Conditional Access, legacy authentication blocked, few super administrators, dormant accounts, password policy |
| HR and learning systems (signed webhook) | Training completion, leavers deprovisioned on time, screening before start |

Credentials are encrypted at rest and never returned. Collectors are tested on recorded responses, the AWS ones against the real SDK
on a protocol-faithful server, and on your own accounts with `npm run test:live` (read-only, skipped unless you provide credentials,
see [docs/LIVE_TESTING.md](docs/LIVE_TESTING.md)). Policies run in TypeScript and are cross-checked by Open Policy Agent; a parity suite
compares both engines on thousands of cases.

## Signatures and the audit trail

- **Append-only chain.** Each entry carries the hash of the previous one; triggers refuse updates and deletes on both databases, and on
  PostgreSQL the application role has no right to change them.
- **Signatures anyone can check.** With `KONTROL_SIGNING_KMS_KEY_ID` the private key stays in AWS KMS and never enters the process; with
  `KONTROL_SIGNING_KEY` a local Ed25519 key signs. The public key is at `/api/signing-key`.
- **Anchors.** A chain that has lost its newest entries is still a valid chain. Kontrol anchors the head on a schedule and writes it to an
  S3 bucket under an Object Lock retention (`KONTROL_ANCHOR_S3_BUCKET`) or to an HTTPS sink; `/api/audit/anchor` compares the live chain
  with the copies you hold.

[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) lists who could falsify the record, what stops them and what is still open.

## Configuration

Every setting is documented in [`.env.example`](.env.example). The ones that matter most:

| Variable | Purpose |
| --- | --- |
| `KONTROL_AUTH_SECRET`, `KONTROL_SIGNING_SECRET` | Session signing and the development signing key. **Required in production**, distinct, 32+ characters |
| `KONTROL_SIGNING_KMS_KEY_ID` or `KONTROL_SIGNING_KEY` | The signing key: an AWS KMS key (preferred) or a local Ed25519 key (`npm run keys:signing`). **One is required in production** |
| `KONTROL_SECRETS_KEY` | Encrypts stored credentials and vault documents. **Required in production**; rotation with `KONTROL_SECRETS_KEY_PREVIOUS` |
| `KONTROL_DB_DRIVER`, `POSTGRES_URL` | Storage (`sqlite` by default, `postgres` for production) |
| `KONTROL_SEED` | `empty` for a clean organisation, `true` for the sample one; off in production unless set |
| `KONTROL_ANCHOR_S3_BUCKET`, `KONTROL_ANCHOR_INTERVAL_HOURS` | Where and how often the audit chain is anchored |
| `OIDC_*`, `OIDC_ALLOWED_DOMAINS`, `OIDC_DOMAIN_TENANTS` | Single sign-on; without allowed domains, sign-in is by invitation only |
| `KONTROL_BOOTSTRAP_ADMIN_EMAIL` | On an empty database, the first administrator |
| `KONTROL_TRUSTED_PROXY_HOPS` | Proxies in front of the app, for rate limits by client |
| `NEXT_PUBLIC_KONTROL_LABS` | Show the modules that work on modelled or synthetic data |

Operations (backup and restore, key rotation, several instances, logs and alerts) are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Tests

```bash
npm run verify -- --e2e   # everything CI runs, with a summary
npm test                  # unit and integration tests on SQLite
npm run test:postgres     # the same tests on PostgreSQL with row-level security
npm run test:e2e          # browser tests (Playwright) with axe accessibility checks
npm run test:opa          # the Rego policies
npm run test:live         # read-only checks against your own accounts
npm run measure           # times the main reads at a stated volume
```

About 340 tests run on both databases. They cover the audit chain (tampering, deletion, truncation, concurrent writers), signatures and
anchors, tenant isolation, authentication and roles, SSRF and outbound requests, rate limits, the policy engines, the collectors, the
framework catalogues and crosswalk, scoring and readiness, the ISMS checks, the risk method including the NIST SP 800-30 tables, and the
browser flows. CI runs them all, plus a dependency audit, a production build and a container that must start and report healthy.

## Architecture

| Path | Role |
| --- | --- |
| `src/app/` | Next.js pages and `/api` route handlers |
| `src/components/` | Interface components |
| `src/lib/core/` | Engines: compliance, ISMS and its checks, risk, incidents and audits, workflows, evidence trail, signing, integrity and anchors, authentication, outbound request guard, rate limits |
| `src/lib/frameworks/` | Framework catalogues, unified-control crosswalk, scoring, capability, readiness (pure, no I/O) |
| `src/lib/risk/` | Threat library |
| `src/lib/connectors/` | Collectors and the executable control pack |
| `src/lib/db/` | SQLite and PostgreSQL drivers, migrations, row-level security, seed |
| `infra/opa/` | Rego policies with their unit tests |
| `examples/hydria/` | A worked ISMS dossier for a fictional water utility |
| `scripts/` | Verification, migration, backup, measurement, screenshots |
| `tests/`, `e2e/` | Test suites |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [ISMS](docs/ISMS.md), [risk register](docs/RISK_REGISTER.md), [crosswalk](docs/CROSSWALK.md), [validation](docs/VALIDATION.md), [threat model](docs/THREAT_MODEL.md), [operations](docs/OPERATIONS.md), [OpenAPI](docs/openapi.yaml) |

## Application security

- Fails closed in production without strong secrets, a signing key and an encryption key.
- Forced row-level security on PostgreSQL: a query that forgets its organisation filter still cannot cross organisations.
- Outbound requests (webhooks, connectors, identity provider) check the address they actually connect to, follow no redirects and cap
  the response; private and special-purpose ranges are refused.
- Server errors return a reference, never internals. Rate limits on sign-in, public endpoints and failed authentication are shared
  across instances.
- Regular expressions in policies are refused when they can backtrack badly and stopped after 25 ms.
- See the [security policy](SECURITY.md) and the [threat model](docs/THREAT_MODEL.md).

## Known limits

- **Judgements not yet confirmed by an audit.** Readiness levels, capability levels, the ISMS checks, the threat library and the COBIT
  mapping are design choices. [docs/VALIDATION.md](docs/VALIDATION.md) separates what is checked against an outside reference (the NIST
  SP 800-30 tables, the NIST and ENISA crosswalks, OPA parity) from what is not, and explains how to validate the rest.
- **Live accounts.** The GitHub collector has run against a real repository of a personal account; organisations, AWS, Okta, GitLab,
  Google Workspace and Entra have not been run against a live tenant. Run `npm run test:live` against yours.
- **Catalogue depth.** Without a licensed import, PCI DSS is at section level, SOC 2 at criterion level and COBIT at objective level.
  Eleven COBIT objectives outside security have no built-in control; COBIT's design factors are not modelled.
- **Crosswalk.** Sourced and measured (85.7 % corroborated by an independent comparison), but a judgement: per-organisation review
  makes it visible, and it never replaces an expert or a certification body.
- **Organisational controls** cannot be machine-verified. They rest on attestations that expire, a second person, reviewed documents or
  the management system's own records.

## Disclaimer

Requirement titles are short paraphrases for steering the work, not the official texts: ISO/IEC standards, PCI DSS, SOC 2 and COBIT are
protected by copyright, and the references to articles of the EU and Moroccan laws are indicative. Kontrol supports governance work;
it does not give legal advice or issue certification opinions. Have your statement of applicability and your regulatory obligations
confirmed by your auditor or legal counsel.
