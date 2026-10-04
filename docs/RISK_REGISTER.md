# Risk register

An ISO 27005-style register where risks are linked to the unified controls that treat them, so residual risk moves with the real compliance posture.

## Rating

Likelihood and impact are integers from 1 to 5; the score is their product on a 5x5 matrix. Bands: 1-4 low, 5-9 medium, 10-16 high, 17-25 critical.

## Residual risk

Residual likelihood is the inherent likelihood reduced by the effectiveness of the linked controls:

- A control counts by its implementation weight: implemented 1, partial 0.5, planned 0.15, not started 0. Not-applicable controls are ignored.
- Failing machine evidence, a lapsed attestation, or a missing countersignature already cap a control at partial in the compliance engine; the register inherits that.
- A control backed only by an attestation (no verified machine evidence and no accepted document) counts for 70%.
- The average effectiveness reduces likelihood by up to 80%, never more. The result is rounded up, so rounding never flatters a risk.
- Impact is not reduced. A control that works makes the event less likely, not less costly; resilience controls that cap impact are not modelled and the register does not pretend they are.

A risk with no linked control has residual equal to inherent. When a control lapses or its evidence starts failing, the residual rating rises on the next read; nothing has to be re-entered.

## Treatment and acceptance

Treatments: mitigate, transfer, avoid, undecided. Choosing mitigate moves the risk to treating and can create a remediation task assigned to the owner.

Accepting a risk is a separate decision (`decisions:approve`) with its own rules:

- The decider is neither the owner nor the person who recorded the risk (separation of duties), and the risk must have an owner.
- It is time-boxed: 1 to 365 days, with a mandatory note.
- A risk whose residual rating is critical cannot be accepted: it must be treated or reduced first.
- Changing the likelihood, impact or treatment of an accepted risk voids the acceptance.
- When the acceptance lapses the risk counts as untreated again, and an alert is raised once per lapse (and once as it approaches expiry).

Closing a risk is final and requires a note.

## Creating risks from gaps

"Create risks from control gaps" reads the compliance roadmap and records one risk per significant gap, linked to the control that closes it. Likelihood comes from the control's state (failing evidence 4, not started or planned 3, partial 2); impact from how many obligations depend on the control (2 to 5). Gaps already covered by an open risk, and gaps under an approved exception, are skipped.

## Quantification

"Quantify" runs the existing FAIR-inspired Monte Carlo simulation with a scenario derived from the risk and stores the annualised loss as a range (P50, mean, P90, P95). The simulation is seeded from the scenario, so the same inputs give the same result. It is a model under stated assumptions, not a forecast. The register sums the means and P90s of quantified risks for an indication only: separate simulations summed are not a portfolio simulation, because risks are not independent.

## Method, criteria and appetite

The method is the organisation's decision, set by an administrator and versioned (`set_method`). Until one is approved the built-in
defaults apply and are reported as not approved, which the ISMS checklist counts against clause 6.1.2.

- **Matrix (ISO/IEC 27005 style).** Likelihood x impact, 1 to 5 each. You choose the score at which medium, high and critical start.
- **NIST SP 800-30 Rev. 1.** A risk is described by a threat source (adversarial, accidental, structural, environmental), a threat
  event, a vulnerability and predisposing conditions. Likelihood has two parts, initiation or occurrence and resulting adverse impact,
  combined by Table G-5; the level of risk comes from Table I-2 and is kept on NIST's five levels (very low, low, moderate, high, very
  high): that is what the register shows, what the appetite is stated in (very low to high) and what an acceptance is judged against.
  A risk raised automatically from a gap has no threat description yet and is
  listed as needing one.
- **Appetite.** The highest band accepted without a management decision. Above it, a risk can only be accepted by an administrator, with
  a note of at least 40 characters, and stays counted as "accepted above appetite". A critical residual risk cannot be accepted at all.

Changing the criteria re-rates every risk at once, because ratings are computed and not stored.

## Traceability

`GET /api/risk-register?view=traceability` returns, for each open risk, its asset, its threat, its treatment, its controls and the
requirements those controls satisfy in the adopted frameworks, and for each control the risks it treats. It also lists where the thread
breaks: risks with no control or no asset, mitigations with no plan, untreated risks, and claimed controls that treat no recorded risk.

The statement of applicability carries two more columns, `risks_treated` and `inclusion_reason` (ISO/IEC 27001 6.1.3 d), and
`GET /api/risk-register?format=treatment-plan` exports the risk treatment plan (6.1.3 e) as CSV.
