# DORA register of information and vendor questionnaires

Kontrol keeps the register of ICT third-party arrangements that DORA Art.28(3) requires, checks it, and exports it. This page states precisely what that covers and what it does not.

## What is modelled

| Object | Content |
|---|---|
| ICT provider | Legal name, LEI (validated with the ISO 17442 check digits), country, parent entity and its LEI, third-party or intra-group, active or exited |
| Contractual arrangement | Reference (ARR-nnn), service type, function supported, critical or important flag, start and end dates, notice period, governing law, service and data countries, data sensitivity, subcontractors with country and rank, substitutability, exit plan and its last test, audit and access rights, contractual incident notification time |

Arrangements are never deleted. Terminating one is final and recorded in the audit chain; a provider with active arrangements cannot be marked exited.

## Checks

Errors block export. They are the fields a register cannot be filed without: a missing or invalid LEI on a critical arrangement, missing governing law or service country, a missing data country when data is processed, inverted dates.

Warnings are supervisory red flags and do not block export: no audit rights, no exit plan, an exit plan not tested in 12 months, substitutability not assessed, a provider that cannot be substituted and has no exit plan, an incident notification time over 72 hours or absent, a critical arrangement ending within 90 days, a subcontractor without a country.

Concentration is the Herfindahl-Hirschman index over critical or important arrangements by provider (0 to 10,000; 1,500 moderate, 2,500 high). It is reported as low below three critical arrangements because the measure is not meaningful on so few.

## Export

`GET /api/third-party/export?format=json|csv`. The JSON has four sections shaped after the ITS templates for the register (providers, contractual arrangements, supply chain, assessment) plus a SHA-256 of the content. The CSV is the flat list of arrangements with their provider.

**It is not an xBRL-CSV submission file.** The supervisory reporting package uses the EBA data point model and taxonomy, with LEI-keyed templates and closed code lists. Kontrol does not claim that alignment. Treat the export as a validated working file to review and to feed a reporting tool, not as the regulator submission.

## Vendor questionnaires

A 20-question baseline across governance, certification, access control, data protection, vulnerability management, monitoring, incident management, resilience, supply chain, audit rights, exit and people. Each question maps to a unified control (so an answer can be traced to ISO 27001, NIS2, DORA, SOC 2) and has a weight.

- A user with the `vendors:manage` permission creates a link for a provider. The token is 256 bits of randomness, shown once, and only its SHA-256 is stored.
- The vendor opens `/vendor-response/<token>` without an account, answers every question, and submits once. The link then stops working, as it does when it expires or is revoked. Every unusable link gives the same answer, so it reveals nothing about why it fails. The public endpoints are rate limited.
- Score is the weighted share of credit over applicable questions. A "no" on a blocking question (MFA, encryption, incident notification, audit rights, exit) caps the level at high whatever the score. A missing answer counts against the vendor.
- A different person from the sender reviews the answers (separation of duties). Accepting turns every blocking finding into a remediation task with an owner and a 30-day due date.

Answers are self-declared. The score ranks vendors for follow-up; it is not an assessment of the vendor.
