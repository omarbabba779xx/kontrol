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

## Operating records

Beyond the records above, `/isms` keeps what the system produces while it runs:

| Clause | Record | Rule |
| --- | --- | --- |
| 6.3 | Planned changes: purpose, what the change could affect, resources, who is responsible, when | Every revision of the scope or of the risk method after the first must have a planned change behind it |
| 7.1 | Nothing new: every open risk, task and corrective action has someone assigned | |
| 7.2 | Competence per role: the competence needed, the evidence it is met, or the action that closes the gap | Reviewed at least yearly; a gap with an action is a managed gap |
| 7.3 | Awareness: the learning system's report (`CTL-HR-001`) or a reviewed record on `UC-HR-02` | |
| 7.4 | Communication plan: what, to whom, when, by whom, how | Both internal and external communications |
| 7.5 | Documented information: the policy register | No approved document past its review date |
| 8.1 | Operational control: every mitigation has a plan and a date, none is late | |
| 8.2 | Risk assessment at planned intervals | The register was updated within the year and after the last change of method |
| A.5.24 to A.5.27 | Security incidents | Recorded; none open for more than 30 days; no personal-data incident past its 72-hour notification deadline |

### Incidents

An incident moves forward only (reported, contained, resolved, closed). One that involves personal data starts the 72-hour clock of
GDPR Article 33 from its detection, and cannot be closed until the notification decision is recorded. Closing is the post-incident
review: the cause and what was learned, and for a high or critical incident either a nonconformity that carries the corrective action
(it is linked to the incident) or the stated reason why none is needed.

### Internal audit programme

An internal audit has objectives, criteria, a period, the controls in scope and an auditor. **An auditor does not audit controls they
own**: planning one that does is refused. Only the auditor records findings and states the conclusion; each finding becomes a
nonconformity linked to the audit. One completed audit is not a programme: clause 9.2 is met when an audit was completed in the last
twelve months, its conclusion is recorded, and the next one is planned.

### More records that back controls

| Unified control | Checks that must be met |
| --- | --- |
| `UC-GOV-04` Risk assessment and treatment | 6.1.2, 6.1.3, 8.2 |
| `UC-GOV-08` Communication and external contacts | 7.4 |
| `UC-HR-02` Awareness, training and competence | 7.2, 7.3 |
| `UC-INC-01` Incident management and response | A.5.24 |

A process that has never run is `missing`, not `met`: no incident ever recorded does not show that incident management works.
