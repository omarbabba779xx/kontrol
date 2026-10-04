# The management system (ISMS)

`/isms` holds the records ISO/IEC 27001 clauses 4 to 10 ask an organisation to keep, and checks them clause by clause. The compliance
hub answers "which controls are in place"; this page answers "is there a management system around them".

## What is recorded

| Clause | Record | Who decides |
| --- | --- | --- |
| 4.1, 4.2 | Internal and external issues; interested parties, each with what it requires | Anyone who manages audits; items are re-confirmed at least yearly |
| 4.3 | The scope statement, its boundaries and its exclusions, versioned | An administrator approves each version |
| 5.2 | The information security policy (policy register, linked to `UC-GOV-01`) | Policy owner; review date enforced |
| 5.3 | A named owner on every claimed control | Control owners |
| 6.1.2 | The risk method, criteria and appetite ([RISK_REGISTER.md](RISK_REGISTER.md)) | An administrator approves each version |
| 6.1.3 | Treatment decisions and the statement of applicability | Risk owners; acceptance by a second person |
| 6.2 | Objectives with a measure, a target, an owner and a date; measurements over time | Objective owner |
| 9.1 | Measurements of objectives and collected evidence | Automatic and objective owners |
| 9.2 | Internal audits (engagements of kind *internal* in the audit workspace) | Audit lead |
| 9.3 | Management reviews, with the inputs frozen at preparation and the decisions | An administrator approves |
| 10.2 | Nonconformities: cause, corrective action, owner, date, effectiveness review | A second person verifies and closes |

## The clause checklist

Each clause is `met`, `partial` or `missing`, with what the records show and the next step. The rules are in
`src/lib/core/isms-checks.ts` and are deliberately about existence, approval and currency:

- a record that nobody has confirmed for a year is no longer current (context items, scope, policy);
- a draft is not an approval (management review);
- an objective past its date with no recorded result is flagged;
- a nonconformity needs a corrective action that removes its cause, not only a correction, and is closed by someone other than the owner
  of the action. If the reviewer finds the action did not work, the nonconformity reopens with that finding on record;
- clause 10 is `missing`, not `met`, when no nonconformity was ever recorded and no internal audit was completed: a process that has
  never run is not shown to work.

The checklist does not judge quality. A recorded scope can still be a poor scope. It tells you what an auditor will not find.

## Records that back controls

When every clause behind a governance control is met, that control counts as *documented*, the same level as a reviewed document:

| Unified control | Clauses that must be met |
| --- | --- |
| `UC-GOV-03` Context, scope and stakeholder requirements | 4.1, 4.2, 4.3 |
| `UC-GOV-04` Risk assessment and treatment | 6.1.2, 6.1.3 |
| `UC-GOV-05` Objectives, metrics and management review | 6.2, 9.1, 9.3 |
| `UC-GOV-06` Internal audit and independent review | 9.2 |
| `UC-GOV-07` Continual improvement and corrective action | 10.2 |

The backing follows the records: when a scope approval passes its year or a review falls out of the last twelve months, the control goes
back to being an unbacked claim, and audit readiness moves with it.

## Management review inputs

Preparing a review reads, at that moment, what clause 9.3.2 lists: the status of the actions from the previous review, changes in the
context, nonconformities, monitoring results per framework, internal audit results, the fulfilment of objectives, and the risk picture
(open, above appetite, untreated, acceptances lapsed). They are stored with the review and do not change afterwards. Each action decided
at approval becomes a task; the next review reports how many were done.

## API

`GET /api/isms` returns the checklist and the records. `POST /api/isms` takes an `action`: `save_context`, `remove_context`,
`approve_scope`, `save_objective`, `measure_objective`, `prepare_review`, `approve_review`, `raise_nonconformity`,
`plan_corrective_action`, `mark_implemented`, `verify_and_close`. Every change is written to the audit chain.
