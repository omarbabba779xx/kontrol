# Kontrol — continuous decision assurance

Kontrol is an advanced GRC control plane. It turns regulatory obligations and live operational facts into executable controls, traceable findings, quantified risk and signed decisions.

This is not a static dashboard. The application includes a persistent domain model, authenticated APIs, automated collectors, a policy engine, durable workflows, evidence integrity, OSCAL export and grounded specialist agents.

## Implemented capabilities

- bitemporal obligation, asset and control records with an explicit relationship graph
- GitHub, AWS and Okta collectors with live credential mode and deterministic demo mode
- executable control policies that generate hashed evidence and open or close findings
- FAIR-inspired Monte Carlo simulation with reproducible P50/P90/P95 exposure
- regulatory version ingestion, text diff and candidate control mappings requiring human review
- durable workflows with retries and approval gates
- signed decision manifests and a verifiable append-only audit hash chain
- OSCAL 1.1.3 assessment-results export
- six read-only GRC agents with provenance and deterministic fallback
- multi-tenant RBAC, JWT sessions and server-side secret isolation
- an operational control plane at `/operations`
- evidence trust scoring, compliance drift and contradiction detection
- interactive assurance graph and digital-twin change simulations
- fourth-party concentration and exit-readiness assessment
- secure auditor request room with downloadable integrity packs
- decision-intelligence briefs and optional standards-based OIDC SSO with PKCE
- a live Assurance Studio at `/assurance`

## Maturity

| Area | Status | Notes |
| --- | --- | --- |
| Domain model, policy engine, evidence hashing, findings | Implemented | SQLite (WAL) kernel, covered by tests |
| Audit hash chain, signed decisions | Implemented | Tamper detection covered by tests |
| RBAC, JWT sessions, OIDC (PKCE) | Implemented | Fails closed in production without strong secrets |
| Workflows with approval gates | Implemented | Separation of duties enforced (requester cannot approve) |
| GitHub / AWS / Okta collectors | Live with credentials, demo otherwise | Evidence from demo sources is tagged and scored lower |
| Regulatory feeds | Implemented | HTTPS only, SSRF-guarded |
| PostgreSQL + RLS, S3 Object Lock, OPA | Probed, not the system of record | Reported as standby unless reachable; data still lives in SQLite |
| Benchmarking | Synthetic cohort | Clearly labelled; no external peer data |
| Agents | Deterministic by default | Optional model gateway; read-only tools |

## Run locally

```bash
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:3000`. Local development defaults to the seeded Acme tenant. Never keep the example secrets or demo authentication in production.

Run the full quality gate (lint, tests, production build):

```bash
npm run check
```

Start the production support services:

```bash
docker compose up -d postgres minio opa
```

## API examples

```bash
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/connectors/github/sync -H "Content-Type: application/json" -d '{"owner":"acme","repository":"lending-decision-service","assetId":"asset_repo_lending","demo":true}'
curl http://localhost:3000/api/oscal/export -o assessment-results.json
```

## Configuration and hardening

In production the server refuses to sign or verify anything unless `KONTROL_AUTH_SECRET` and `KONTROL_SIGNING_SECRET` are distinct, at least 32 characters long and not placeholders. Demo authentication is ignored when `NODE_ENV=production`. Cookie-authenticated mutations must come from the same origin, regulatory feeds cannot target private networks, and OIDC role claims are only honoured when `OIDC_TRUST_ROLE_CLAIM=true`. Responses carry strict security headers. See [`.env.example`](.env.example) for every setting.

See [architecture](docs/ARCHITECTURE.md), [security policy](SECURITY.md), and `.env.example`.

## Enterprise platform — ten implemented capabilities

The `/enterprise` workspace exposes the ten capabilities as first-class modules, in this order:

1. **Production réelle** — live readiness checks for PostgreSQL/RLS, OPA, immutable S3 storage and secret configuration. Unconfigured services are shown as standby, never as healthy.
2. **Regulatory Intelligence** — official HTTPS feeds, content hashing, change detection, cadence and application calendar.
3. **Policy Compiler** — natural-language requirements compiled into Rego, executable JSON conditions, required data and tests.
4. **Evidence Vault** — upload, SHA-256, signing, duplicate detection, version chains, retention and S3 Object Lock or explicit local fallback.
5. **Case Management** — investigation records with owners, severity-based SLAs, remediation, comments and attachment contracts.
6. **Continuous Authorization** — recurring evaluation of evidence trust and open high findings, with automatic revocation and reason.
7. **Attack-path GRC** — identity/repository entry points propagated to cloud, business assets, obligations and quantified loss.
8. **Workflow Designer** — validated trigger/node/edge definitions requiring a human approval node for material workflows.
9. **Executive Risk Cockpit** — P50/P90 exposure, control effectiveness, cases, conditional decisions and audit-chain integrity.
10. **Benchmarking confidentiel** — disclosed synthetic reference cohorts and percentile calculations; no fabricated external peer data.

> Kontrol supports governance work; it does not provide legal advice or issue certification opinions.
