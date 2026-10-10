# Hydria: a worked ISMS dossier

Hydria is a **fictional** water utility used to show Kontrol on a complete case. It does not describe any real organisation; the names,
figures and people are invented.

| | |
| --- | --- |
| Activity | Drinking-water supply and billing for about 410,000 customers |
| Why it is interesting | An essential service, personal data at scale, an industrial network next to the office network, and a SOC that uses AI-assisted triage |
| ISMS scope, version 1 | The Security Operations Centre service and the customer information system |
| Excluded | The industrial control systems themselves (only their log interface is in scope), customer agencies, subsidiaries |
| Frameworks adopted | ISO/IEC 27001:2022 for the management system, ISO/IEC 42001:2023 for the AI triage pipeline |

## Loading it

Use a separate database so the dossier does not mix with other data, and give the server a secret to check the signed HR and
learning reports:

```bash
# .env.local
KONTROL_DATABASE_PATH=.data/hydria.db
KONTROL_INGEST_SECRET=<32 characters or more>
```

```bash
npm run dev
node examples/hydria/load-foundation.mjs
node examples/hydria/load-risk.mjs
node examples/hydria/load-operation.mjs
```

The scripts go through the public API, so every record is written to the audit chain like any other, and each stops if its records
are already there. Run from an empty database, the three steps end with 20 of the 21 clause checks met and one partial.

## What the dossier contains

| Step | Clauses | Records |
| --- | --- | --- |
| `load-foundation.mjs` | 4.1, 4.2, 4.3, 5.2, 6.2, 7.2, 7.4 | Five people, 8 issues, 7 interested parties with their requirements, the approved scope with its exclusions, the security policy, 5 objectives, 3 competence and 4 communication records, two adopted frameworks |
| `load-risk.mjs` | 5.3, 6.1.2, 6.1.3, 7.1, 8.1, 8.2 | The approved risk method with impact criteria per property, 8 valued assets, the state and the owner of 42 controls, 15 risk scenarios with their treatment plans and tasks, one acceptance by a second person |
| `load-operation.mjs` | 7.3, 9.1, 9.3, 10.2, A.5.24 | Signed reports from the learning and HR systems, a first measurement of each objective, one incident handled to its lessons, two nonconformities, the audit programme, the first management review |

`exports/` holds what Kontrol produces from these records: the statement of applicability for ISO/IEC 27001 and ISO/IEC 42001, the
risk treatment plan, and the signed audit-readiness report.

## What it shows, including what is not finished

The dossier is meant to look like a young management system, not a finished one.

- **Eleven of the fifteen risks stay above the appetite.** Most controls are partial or planned, so residual risk hardly moves. Each has
  a plan, an owner and a date; none is hidden by an optimistic rating.
- **One risk is accepted above the appetite**, for six months, by the administrator, who neither owns nor recorded it, with the reason
  on record.
- **The HR report fails a control**: two leavers kept an account after their departure. It is left failing.
- **An incident produced a nonconformity** (MFA not enforced on every account) whose corrective action is open and on time. A second
  nonconformity went through the whole cycle and was closed by someone other than its owner.
- **Clause 9.2 is partial on purpose.** The internal auditor is not trained yet, so the first audit is planned and none is completed.
  The checklist says so.

## Known limits of the example

- **The calendar is compressed.** Every record is created the day the scripts run. A real management system takes months to produce
  measurements, an incident, corrective actions and a review.
- **The administrator keeps the name of the built-in demonstration account.** The organisation is renamed Hydria and its five people
  own the records and act in their own name, but approvals reserved to an administrator are signed by that account.
- **Kontrol has no catalogue for Moroccan law.** Law 05-20 and Law 09-08 are recorded as requirements of interested parties, and which
  obligations bind an operator like Hydria is marked as to be confirmed with Legal. No deadline or duty is asserted from them.
- **The ratings are an example.** Likelihoods, asset values and control states were chosen to be plausible for such an operator; they
  are not measurements of any organisation.
