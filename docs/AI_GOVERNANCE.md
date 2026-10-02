# AI governance

A register of AI systems, each classified under the EU AI Act (Regulation (EU) 2024/1689) with its reasoning recorded, a versioned model card, a fundamental rights impact assessment where one is required, and an approval that depends on the paperwork and on the controls behind the obligations.

## What the classification is, and is not

The wizard is a **triage with recorded reasoning**. Every outcome lists the articles and answers that produced it. It is not legal advice. Three judgements are flagged for counsel in the result:

- the Art.6(3) derogation (a system in an Annex III area that only does a narrow procedural or preparatory task, improves a prior human activity, or detects patterns without replacing human assessment). It never applies to a system that profiles natural persons;
- whether a product falls under Annex I legislation requiring third-party conformity assessment;
- a systemic-risk designation for a general-purpose AI model.

**Application dates are deliberately not hard-coded.** They have been subject to amendment proposals; check the current timeline in the Official Journal or with the AI Office before planning against a date. A test fails if a calendar date appears in the classification module.

## Outcomes

| Tier | Trigger | Consequence in Kontrol |
|---|---|---|
| Prohibited | Any Art.5 practice | The system is blocked. It cannot be approved, only retired. |
| High-risk | Annex I product, or an Annex III area (unless the derogation applies) | Obligations of Art.9-17, 43, 49, 72, 73 for providers; Art.26 for deployers; a FRIA where Art.27 applies |
| Limited | Interacts with people, generates synthetic content, emotion recognition or biometric categorisation | Art.50 transparency obligations |
| Minimal | None of the above | AI literacy (Art.4) and voluntary codes |

General-purpose model providers are assessed separately (Art.53, and Art.55 where systemic risk is presumed) and the result is added to the tier of the system.

The role (provider, deployer, both) selects which obligations apply. A FRIA is required for a high-risk system when the deployer is a public body or provides public services, or the use is creditworthiness or life and health insurance pricing.

## Obligations are connected to controls

Each obligation names the unified control that supports it (UC-AI-01 to UC-AI-07). Its state (met, partial, open) is read from the live compliance posture, so it changes when the control is attested, verified, fails or lapses. Readiness is the average of the obligations' coverage.

## Model cards

Ten sections modelled on the documentation duties (Art.11 and Annex IV, Art.13, Art.53); seven are required. Cards are **append-only**: saving creates a new version with a SHA-256, and an identical save is rejected. What was documented when a decision was made stays provable.

## Impact assessment (FRIA)

Description of the process, affected groups, an impact rating (none to high) for each of ten fundamental rights with an explanation for every medium or high, mitigations, human oversight and a remedy. Completing it requires all of these. Editing a completed assessment clears its review. A person other than the author and the system's owner reviews it.

## Approval

- Only a classified system can be approved; a prohibited one never.
- The approver is neither the owner nor the person who registered the system (separation of duties), and an owner must be assigned.
- A high-risk system, or a GPAI provider, needs a model card.
- Where a FRIA is required it must be completed and reviewed.
- A high-risk system also needs every control behind its obligations at least partially implemented (weight 0.5 or more).
- Re-classifying with a different tier or a different set of obligations voids the approval; an unchanged outcome keeps it.
- Retiring is final.
