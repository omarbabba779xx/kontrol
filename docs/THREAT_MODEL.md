# Threat model

Kontrol records what an organisation claims about its security, the evidence for those claims and the decisions people sign. The
question this document asks is therefore not only "who can break in" but **"who has an interest in making the record say something
untrue, and what stops them"**. It lists the protections that exist in the code, where each is tested, and what is still open.

It was written by the author of the application, from the code. No third party has reviewed it and no penetration test has been run.

## What is worth protecting

| Asset | Why it matters | Property that matters most |
| --- | --- | --- |
| The audit log | It is the proof that a record was not rewritten afterwards | Integrity |
| Evidence and control results | Scores, findings and reports are computed from them | Integrity |
| Decisions: risk acceptances, approvals, closures | They carry a person's accountability | Integrity, non-repudiation |
| Tenant data | One organisation must never read another's posture | Confidentiality |
| Connector credentials and vault documents | They open the systems Kontrol collects from | Confidentiality |
| Signing keys | Whoever holds them can produce a "genuine" report | Confidentiality |

## Who might attack it

| Actor | What they want | What they start with |
| --- | --- | --- |
| **An insider who wants a better picture** (control owner, risk owner) | A control shown as working, a risk closed, a finding gone before the audit | A valid account with a role |
| **An administrator** | The same, with more reach; or to hide a mistake | Every permission in the application |
| **Whoever operates the host or the database** | To rewrite history without leaving a trace | File system and database access, outside the application |
| **Another tenant** | To read a competitor's or a customer's posture | A valid account in a different organisation |
| **An outsider** | Credentials, documents, or a foothold | Network access to the application |
| **A source system that lies** | Nothing: it is misconfigured, or its token was stolen | The ability to send facts or signed reports |

## Trust boundaries

1. **Browser to API.** Every route authenticates, then checks one permission (`requireActor`). The account in the database is
   authoritative on each request, not the token.
2. **API to database.** On PostgreSQL the application connects as an unprivileged role and every tenant table is under forced
   row-level security. On SQLite isolation is by query filter only.
3. **Source systems to Kontrol.** Connectors pull with stored credentials; HR and learning systems push signed reports.
4. **Kontrol to the outside.** Regulatory fetches, notifications, anchor publication, the optional AI gateway.
5. **The application to whoever runs it.** The operator is outside the application's control. Only signatures and external anchors
   say anything about them.

## Threats and what answers them

### Making the record say something untrue

| # | Threat | Protection | Tested in | Residual |
| --- | --- | --- | --- | --- |
| T1 | The owner of a risk accepts it to make it disappear | The owner and the person who recorded a risk cannot accept it; an acceptance expires; a critical residual risk cannot be accepted | `risk-register.test.ts` | Two people who agree can still do it. The record shows both names |
| T2 | A requester approves their own workflow | Refused; the same request does not start a workflow twice | `workflow.test.ts` | Same as T1 |
| T3 | An owner closes their own nonconformity | The owner of a corrective action cannot verify its effectiveness | `isms.test.ts` | Same as T1 |
| T4 | A control is attested as working while the evidence says otherwise | Failing machine evidence caps the control at partial and the report lists the contradiction; attestations expire | `attestations.test.ts`, `compliance.test.ts` | A control with no machine evidence rests on the attestation alone. It is shown as attested, not verified |
| T5 | A residual risk is typed lower than it is | Residual risk is computed from the state of the linked controls, not entered | `risk-register.test.ts` | The inherent rating and the choice of linked controls are still a person's judgement |
| T6 | A missing permission is recorded as compliance, or as a failure | A fact a collector could not read is `null`; a control missing a required fact is skipped and reported | `connectors.test.ts`, `controls.test.ts` | None known |
| T7 | A forged or replayed report from an HR or learning system | HMAC over `timestamp.body` with a per-tenant derived secret, five-minute window, each signature accepted once, same answer for an unknown tenant and a bad signature | `ingest.test.ts` | A source system that is itself compromised sends valid lies. Kontrol records what it was told and by whom |
| T8 | An excuse is hidden as "not applicable" | An exclusion needs a justification and appears in the statement of applicability | `compliance.test.ts` | The justification is free text; its quality is for the auditor to judge |

### Rewriting history

| # | Threat | Protection | Tested in | Residual |
| --- | --- | --- | --- | --- |
| T9 | An audit entry is edited or deleted through the application | `audit_log` is append-only by trigger on both databases; on PostgreSQL the runtime role has only `SELECT` and `INSERT` on it | `integrity.test.ts` | None through the application |
| T10 | An entry is edited by someone with database access | Each entry is chained to the previous hash; the chain is recomputed on demand and after a migration | `integrity.test.ts`, `migration.test.ts` | See T11 |
| T11 | The newest entries, or the whole chain, are removed and the rest still verifies | Signed anchors of each chain head, published on a schedule to a write-once sink or an S3 bucket with Object Lock | `signing-anchor.test.ts`, `anchor-publisher.test.ts` | **Without an external sink configured, a database owner can truncate the chain undetected.** Entries written since the last anchor are never covered |
| T12 | A decision or a report is altered after signature | Ed25519 signatures verifiable with the public key alone | `decisions.test.ts`, `report.test.ts`, `signing-anchor.test.ts` | With a local key, whoever runs the host can sign anything. Only the KMS custody removes that. The development key is derived from a known secret and proves nothing |
| T13 | Two writers fork a tenant's chain | Writers serialised per tenant; unique index on `(tenant_id, previous_hash)` | `integrity.test.ts` | None known |

### Reading what is not yours

| # | Threat | Protection | Tested in | Residual |
| --- | --- | --- | --- | --- |
| T14 | One tenant reads another's data | Forced row-level security on PostgreSQL; start-up refuses a superuser, `BYPASSRLS` or table-owning connection | `postgres-rls.test.ts`, `isolation.test.ts`, `db-roles.test.ts` | **On SQLite isolation depends on every query carrying its filter.** SQLite is for evaluation and a single organisation |
| T15 | An external auditor wanders beyond the engagement | External accounts are refused everything outside the audit workspace | `audit.test.ts` | None known |
| T16 | A stolen session keeps working after the account is disabled or demoted | Status, role and a revocation time are read from the database on each request; a token can narrow a role, never widen it | `auth.test.ts` | A stolen session is valid until someone notices. Sessions last eight hours |
| T17 | A leaked API key | Stored hashed, never administrator, never above its owner's role, revocable, with expiry | `admin.test.ts` | A key is a bearer secret: no binding to a client |
| T18 | Credentials or documents read from a copied database or disk | AES-256-GCM, bound to the tenant and the record; every read checks the recorded hash; key rotation | `vault.test.ts`, `backup.test.ts` | Evidence results, findings, names and audit entries are not encrypted by the application: that is left to the disk or the managed database |

### Getting in from outside

| # | Threat | Protection | Tested in | Residual |
| --- | --- | --- | --- | --- |
| T19 | Cross-site request forgery on a cookie session | Cookie-authenticated mutations must come from the same origin | `auth.test.ts` | A request with no `Origin` header is accepted, to allow non-browser clients |
| T20 | Password or key guessing | Failed authentication is counted per client across instances; per-actor request budget | `rate-limit.test.ts` | If the database is unreachable the shared limit falls back to one per process. Put a limit at the edge as well |
| T21 | Using Kontrol to reach internal addresses (SSRF) | Outbound fetches are HTTPS only, refuse credentials, private and internal addresses, and do not follow redirects | `net-guard.test.ts` | None known |
| T22 | A regular expression in a policy that never finishes | Length bound; back-references and nested quantifiers refused | `policy-engine.test.ts` | None known |
| T23 | Script injected through imported or stored text | Imported content is rendered as plain text; React escapes output; CSV exports are escaped | `compliance.test.ts` (export only) | **No Content-Security-Policy header is set**, so there is no second line if an injection is ever found |
| T24 | A new account gets too much | Accounts created through single sign-on are viewers unless the role claim is explicitly trusted; sign-up is limited to listed domains | `oidc.test.ts` | Never exercised against a real identity provider |
| T25 | The demonstration sign-in left on | Refused in production; start-up fails on missing, short, placeholder or duplicated secrets | `auth.test.ts` | On a shared non-production host, demo sign-in gives everyone an administrator |

### The AI agents

| # | Threat | Protection | Residual |
| --- | --- | --- | --- |
| T26 | A model is talked into changing something | Agent tools are read-only; every mutation is an authenticated API call with its permission and its approval gate | A wrong analysis can still mislead the person who reads it. Output carries its sources and assumptions |
| T27 | Tenant facts sent to a third party | Without a configured gateway the agents run a deterministic local analysis and nothing leaves | With a gateway configured, the facts in scope are sent to it. That is a deployment decision |

## What this model does not cover

- **Collusion.** Separation of duties needs two people. Two who agree, or an administrator who controls a second account, defeat it.
  The application guarantees that both names are on record, nothing more.
- **The operator.** Someone who controls the host, the database and a locally held signing key can produce a consistent false
  history. The defences are organisational: KMS custody for the key, an anchor sink the operator cannot write to, separate people.
- **Availability.** There is no denial-of-service protection beyond rate limits, and the limits are per process.
- **The truth of the evidence.** Kontrol checks where a fact came from, when, and that it has not changed. It cannot check that the
  source system told the truth.
- **Supply chain.** Dependencies are pinned, audited in CI and updated by Dependabot. Nothing verifies the build provenance.

## Open items, in the order I would address them

1. Add a Content-Security-Policy (T23).
2. Refuse a cookie-authenticated mutation that carries no `Origin` header (T19), with an explicit exception for API keys.
3. Make an external anchor sink a start-up requirement in production instead of an option (T11).
4. Show, on each decision that needed a second person, whether that person's account was created by the first (collusion signal).
5. Have the model reviewed, and the application tested, by someone other than its author.
