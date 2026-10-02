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
