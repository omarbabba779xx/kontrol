# What is validated, and what is not

Kontrol makes judgements: when a framework is "audit ready", which capability level a control has reached, whether a clause of the
management system is met. This page says what each judgement rests on, so that nobody mistakes a design choice for a measured result.

## Checked against an outside reference

| Claim | Reference | How it is checked |
| --- | --- | --- |
| NIST SP 800-30 scales (overall likelihood, level of risk) | NIST SP 800-30 Rev. 1, Tables G-5 and I-2 | Compared cell by cell with the publication; pinned by `tests/risk-method.test.ts` |
| NIST CSF 2.0 to ISO/IEC 27001 links | NIST's informative references | Derived from the published data, marked *published* on each link |
| NIS2 links | ENISA technical implementation mapping table | Same |
| The crosswalk as a whole | Secure Controls Framework | 85.7% of links corroborated by an independent comparison ([CROSSWALK.md](CROSSWALK.md)) |
| TypeScript and Rego policy engines agree | Open Policy Agent | A parity suite compares both on thousands of cases |
| AWS collectors | The real AWS wire protocols | Run against Moto with the real SDK |
| GitHub collector | The live GitHub API | Run against a real private repository of a personal account |

## Design choices that no audit has confirmed

These are reasoned, written down and tested for consistency. None has been compared with the outcome of a real certification audit.

| Judgement | Rule | Where |
| --- | --- | --- |
| Audit readiness level | Declared progress and evidence-backed share above thresholds, and no blocker (a contradicted claim, an expired attestation, an open high finding) | `src/lib/frameworks/audit-readiness.ts` |
| Capability level 0 to 5 | Declared maturity, capped by status and by evidence (no evidence stops at 3; contradicted stops at 2) | `src/lib/frameworks/capability.ts` |
| ISMS clause met / partial / missing | The record exists, is approved and is current (within twelve months) | `src/lib/core/isms-checks.ts` |
| Residual risk | Inherent likelihood reduced by control effectiveness, never by more than 80%, never on impact | `src/lib/core/risk-rating.ts` |
| Threat library and its suggested controls | Written for this product in the manner of ISO/IEC 27005 | `src/lib/risk/threat-library.ts` |
| COBIT 2019 mapping | Written for this product; 11 objectives outside security are left unmapped | `src/lib/frameworks/data/cobit.ts` |

Every mapping link carries its basis (*published* or *editorial*), and a reviewer can validate, reject or add links per organisation;
the review is recorded in the audit chain. An editorial link that nobody reviewed is exactly that.

## How to validate them with a real audit

The thresholds are constants, on purpose: they can be compared with reality and changed in one place.

1. Before the audit, export the readiness report and the statement of applicability, and take an audit anchor.
2. After the audit, record each nonconformity the auditor raised (`/isms`, source *external audit*) with its requirement.
3. Compare. A requirement the auditor failed that Kontrol showed as compliant and backed is a false assurance: look at which
   rule let it through. A blocker Kontrol raised that the auditor did not care about is noise.
4. Adjust the thresholds or the rule, with a test that pins the case, and say so in the change.

Until that has been done at least once, treat the readiness level as a structured self-assessment, not a prediction.

## Not tested against a real account

- The GitHub collector against an **organisation** (two-factor requirement, organisation rulesets, outside collaborators).
- The AWS, Okta, GitLab, Google Workspace and Microsoft Entra collectors against a live tenant.

`npm run test:live` runs the collectors read-only against your accounts ([LIVE_TESTING.md](LIVE_TESTING.md)).

## Measured, not assumed

`npm run measure` builds a throwaway database at a stated volume and times the main reads. On a developer laptop, SQLite, with
2,000 risks, 20,000 evidence records and 1,000 nonconformities:

| Read | Time |
| --- | --- |
| Compliance snapshot | 28 ms |
| Risk register, every risk rated | 70 ms |
| Risk traceability | 115 ms |
| ISMS page with the clause checklist | 17 ms |
| One page of 50 risks with the total | 1 ms |
| One page of 50 evidence records | 34 ms |

It is a single-process measurement on SQLite. PostgreSQL under concurrent load has not been measured.
