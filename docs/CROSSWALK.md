# How the crosswalk is built, sourced and measured

Kontrol relates the requirements of thirteen frameworks to 56 framework-neutral *unified controls*. Twelve are security or privacy frameworks and are mapped in full, among them two Moroccan laws (Law 05-20 on cybersecurity and Law 09-08 on personal data), whose links are editorial and whose French text governs; COBIT 2019 reaches beyond security, so only its security-relevant objectives are mapped. Implementing a control
advances every requirement it is linked to. This page explains where each link comes from, how it is checked, and what is still open.

## Where a link comes from

| Basis | Meaning | Shown as |
| --- | --- | --- |
| **Published** | An official crosswalk relates the requirement to a requirement this control already serves. The source is named on the link. | *source publiée* + source |
| **Editorial** | Authored by the Kontrol team, inherited from a group, or hand-refined. | *éditorial* |
| **Tenant** | Added by a reviewer of your organisation. | *ajouté par vous* |

Published sources:

- **NIST CSF 2.0 informative references** (NIST Reference Tool export, a U.S. Government work): CSF subcategory to ISO/IEC 27001:2022, PCI DSS v4 and CIS Controls v8. 148 of 153 CSF links, 41 of 81 PCI DSS links and 36 of 190 CIS links are corroborated this way.
- **ENISA NIS2 Technical Implementation Guidance mapping table v1.2** (June-September 2025): points of Commission Implementing Regulation (EU) 2024/2690 to ISO/IEC 27001:2022 and NIST CSF 2.0, attached to NIS2 Article 21. 16 of 31 NIS2 links are corroborated.

Generators: `scripts/generate-csf-data.py`, `scripts/generate-enisa-data.py`. The control layer (which unified control a
published ISO or CSF reference points to) is Kontrol's: a *published* link says an official source relates the requirements, not that
a standards body endorsed the control library.

Where a source implies a link that is not in the built-in mapping, it is offered as a **suggestion** on the requirement (118 today,
42 of them for NIS2). For PCI DSS and CIS, which are reached through CSF subcategories, a suggestion needs two subcategories to agree.
Suggestions are never applied silently: a reviewer accepts them.

## Tenant review

Any built-in link can be validated or rejected, and any link can be added, each with a note of at least ten characters. Rejected and
added links change the scores for that tenant only. Every review is chained in the audit log with the reviewer's identity.
Sub-requirements imported from a licensed copy (see the README) inherit their parent's links and can be reviewed the same way.

## Independent measurement against the Secure Controls Framework

The SCF is an independent, widely used crosswalk. Its licence (CC BY-ND 4.0) forbids redistributing or adapting its data, so Kontrol
**does not ship or copy it**: `scripts/compare-scf.py` reads a copy you download and reports aggregate agreement and candidates for human review.

```bash
npm run export:crosswalk > crosswalk.json
python scripts/compare-scf.py scf.xlsx crosswalk.json --details
```

A Kontrol link (requirement, control) is *corroborated* when a requirement of another framework that shares the control is related by the SCF
to the requirement. Result against SCF 2026.3, 769 links the SCF can speak about:

| Framework | Links | Testable | Corroborated |
| --- | ---: | ---: | ---: |
| ISO/IEC 27001 | 121 | 119 | 92.4% |
| PCI DSS | 81 | 81 | 95.1% |
| SOC 2 | 70 | 69 | 91.3% |
| NIST CSF | 153 | 153 | 86.3% |
| CIS v8 | 190 | 177 | 84.7% |
| DORA | 34 | 29 | 82.8% |
| ISO/IEC 42001 | 75 | 69 | 73.9% |
| GDPR | 45 | 28 | 67.9% |
| EU AI Act | 34 | 22 | 50.0% |
| NIS2 | 31 | 22 | 100% |
| **Overall** | **834** | **769** | **85.7%** |

Reading the numbers honestly:

- The low rows are where the SCF itself is thin (it maps few AI Act and GDPR articles to technical controls) and where Kontrol has controls
  no other framework shares (privacy, AI governance), so the link cannot be tested. They are not evidence of error, and they are not evidence of correctness.
- The comparison already changed the mapping: it exposed noise in the CSF derivation (NIST cites many ISO controls per subcategory, including broad governance ones). Keeping only
  the controls that also belong to the subcategory's category removed 126 links and raised CSF corroboration from 79.6% to 86.3%.
- The candidate-addition list from the script is dominated by generic hubs (governance and incident-response controls appear everywhere in the SCF), so it is a prompt for
  review, not a to-do list.

## What remains open

A crosswalk is a judgement. Published sources and an independent comparison reduce the chance of error and make it visible, but neither replaces an
expert (or your certification body) reviewing the links that matter for your scope. The hub shows, per framework, how many links are published, validated, rejected, added and
still to review, so that review is measurable.

Not available to Kontrol: the AICPA mappings of the Trust Services Criteria to ISO/IEC 27001 and NIST CSF (they require an AICPA account or membership), and any official
crosswalk for the EU AI Act, DORA and GDPR to the technical standards (none has been published).
