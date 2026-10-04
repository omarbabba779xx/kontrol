import { group } from "@/lib/frameworks/data/helpers";
import type { Requirement } from "@/lib/frameworks/types";

/**
 * COBIT 2019 governance and management objectives: the 40 identifiers and their short names, in their five domains.
 *
 * COBIT is published by ISACA and its text is licensed. Only the identifiers and names are carried here; the purpose statements,
 * practices and activities are not reproduced. An organisation that holds a licence can attach them through licensed-content import.
 *
 * COBIT governs all of information and technology, not only its security. Objectives about portfolio, budget, innovation or
 * programme delivery have no counterpart in a security control library, so they carry no built-in mapping: bring them into scope with
 * your own mapping, or exclude them with a justification. They are never silently counted as met.
 */
export const COBIT_REQUIREMENTS: Requirement[] = [
  ...group("EDM · Evaluate, Direct and Monitor", `
EDM01|Ensured governance framework setting and maintenance
EDM02|Ensured benefits delivery
EDM03|Ensured risk optimization
EDM04|Ensured resource optimization
EDM05|Ensured stakeholder engagement`),
  ...group("APO · Align, Plan and Organize", `
APO01|Managed I&T management framework
APO02|Managed strategy
APO03|Managed enterprise architecture
APO04|Managed innovation
APO05|Managed portfolio
APO06|Managed budget and costs
APO07|Managed human resources
APO08|Managed relationships
APO09|Managed service agreements
APO10|Managed vendors
APO11|Managed quality
APO12|Managed risk
APO13|Managed security
APO14|Managed data`),
  ...group("BAI · Build, Acquire and Implement", `
BAI01|Managed programs
BAI02|Managed requirements definition
BAI03|Managed solutions identification and build
BAI04|Managed availability and capacity
BAI05|Managed organizational change
BAI06|Managed IT changes
BAI07|Managed IT change acceptance and transitioning
BAI08|Managed knowledge
BAI09|Managed assets
BAI10|Managed configuration
BAI11|Managed projects`),
  ...group("DSS · Deliver, Service and Support", `
DSS01|Managed operations
DSS02|Managed service requests and incidents
DSS03|Managed problems
DSS04|Managed continuity
DSS05|Managed security services
DSS06|Managed business process controls`),
  ...group("MEA · Monitor, Evaluate and Assess", `
MEA01|Managed performance and conformance monitoring
MEA02|Managed system of internal control
MEA03|Managed compliance with external requirements
MEA04|Managed assurance`),
];

/** Editorial mapping of each objective to the unified controls that carry out its security-relevant part. */
export const COBIT_MAPPING = `
EDM01: UC-GOV-01 UC-GOV-02
EDM03: UC-GOV-04
EDM04: UC-GOV-02
EDM05: UC-GOV-03 UC-GOV-08
APO01: UC-GOV-01 UC-GOV-02 UC-GOV-03
APO07: UC-HR-01 UC-HR-02
APO09: UC-TPM-02
APO10: UC-TPM-01 UC-TPM-02 UC-TPM-03
APO11: UC-GOV-07
APO12: UC-GOV-04
APO13: UC-GOV-01 UC-GOV-04 UC-GOV-05
APO14: UC-DAT-01 UC-DAT-02
BAI02: UC-SDL-01
BAI03: UC-SDL-01
BAI04: UC-OPS-07
BAI06: UC-OPS-06
BAI07: UC-OPS-06 UC-OPS-09
BAI09: UC-ASM-01 UC-PHY-02
BAI10: UC-OPS-01 UC-ASM-01
DSS01: UC-OPS-08 UC-OPS-05 UC-PHY-01
DSS02: UC-INC-01 UC-INC-02
DSS03: UC-GOV-07 UC-INC-01
DSS04: UC-BCP-01 UC-BCP-02 UC-DAT-05
DSS05: UC-IAM-01 UC-IAM-02 UC-IAM-03 UC-IAM-04 UC-OPS-02 UC-OPS-03 UC-OPS-04 UC-OPS-05 UC-DAT-03 UC-PHY-01
DSS06: UC-IAM-04 UC-OPS-11 UC-GOV-02
MEA01: UC-GOV-05
MEA02: UC-GOV-06
MEA03: UC-CMP-01
MEA04: UC-GOV-06
`;
