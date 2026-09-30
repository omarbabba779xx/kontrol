# Kontrol architecture

Kontrol is a decision-assurance control plane, not a checklist manager. Its core object graph connects obligations → controls → assets → evidence → findings → risks → decisions.

## Runtime flow

1. A connector collects a fact from GitHub, AWS or Okta and records source, time window, method and SHA-256 hash.
2. The policy engine evaluates structured facts against an executable control and opens, updates or closes a finding.
3. A durable database workflow advances one idempotent step at a time, retries failures and pauses for human approval.
4. Risk scenarios use a seeded FAIR-inspired Monte Carlo model so results are reproducible and comparable.
5. Decisions seal their evidence manifest, rationale and conditions with an HMAC signature.
6. Every material event is chained to the previous audit hash; the control plane recomputes the chain.

## Deployment profiles

Local development uses embedded SQLite in WAL mode and explicit demo connector data. The production support profile provides PostgreSQL with tenant row-level security, MinIO-compatible evidence storage and Open Policy Agent. Managed equivalents can replace these services behind the API boundary.

## AI safety model

Six role-specific agents query scoped facts and graph relations. Without `AI_GATEWAY_API_KEY`, they return deterministic local analysis. With it, Vercel AI Gateway routes the model call. Responses include provenance and assumptions. Agent tools are read-only; mutations remain authenticated API operations with RBAC and approval gates.

## Enterprise control plane

The enterprise layer is deliberately explicit about runtime truth. PostgreSQL, OPA and S3 are probed rather than assumed; missing configuration produces a standby state. Regulatory monitoring stores source hashes, the policy compiler emits both Rego and deterministic tests, the evidence vault maintains signed version chains, and continuous authorization can revoke a grant when evidence trust or findings violate its conditions.

Attack paths connect technical entry points to business assets, obligations and financial exposure. Case management and workflow definitions preserve human accountability. Executive metrics and benchmarks are derived from tenant records; the included reference cohort is labelled synthetic and must be replaced with an approved privacy-preserving aggregation service before making peer claims.
