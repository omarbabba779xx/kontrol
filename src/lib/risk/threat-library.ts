/**
 * A starting library of threats for asset-based risk identification in the manner of ISO/IEC 27005: what can happen, to which kind of
 * asset, which security properties it damages, the weaknesses that usually let it happen and the unified controls that usually treat
 * it. The wording and the selection are this product's own; the families follow the usual typology (physical, natural, loss of
 * essential services, technical failure, compromise of information, compromise of functions, human error, organisational).
 *
 * It is a prompt for the assessor, not an assessment: a scenario built from it still needs a likelihood and an impact that someone
 * who knows the organisation has judged.
 */
export type Dimension = "confidentiality" | "integrity" | "availability";
export type ThreatFamily = "physical" | "natural" | "essential_services" | "technical_failure" | "information_compromise" | "function_compromise" | "human_error" | "organisational";
export type ThreatOrigin = "adversarial" | "accidental" | "structural" | "environmental";

export type Threat = {
  id: string;
  family: ThreatFamily;
  title: string;
  /** How SP 800-30 would class the source of this threat. */
  origin: ThreatOrigin;
  affects: Dimension[];
  /** Asset types (of the inventory) this threat usually concerns; empty means any. */
  assetTypes: string[];
  vulnerabilities: string[];
  controls: string[];
};

const C: Dimension = "confidentiality", I: Dimension = "integrity", A: Dimension = "availability";
const t = (id: string, family: ThreatFamily, title: string, origin: ThreatOrigin, affects: Dimension[], vulnerabilities: string[], controls: string[], assetTypes: string[] = []): Threat => ({ id, family, title, origin, affects, assetTypes, vulnerabilities, controls });

export const THREATS: Threat[] = [
  t("TH-PHY-01", "physical", "Fire or water damage to premises or equipment", "environmental", [A, I], ["No fire detection or suppression", "Equipment below pipes or at ground level"], ["UC-PHY-01", "UC-BCP-01", "UC-DAT-05"]),
  t("TH-PHY-02", "physical", "Theft or loss of equipment or media", "adversarial", [C, A], ["Unencrypted laptops and removable media", "Unattended equipment"], ["UC-PHY-02", "UC-DAT-03", "UC-ASM-01"]),
  t("TH-PHY-03", "physical", "Unauthorised physical access to secure areas", "adversarial", [C, I, A], ["Shared or untracked access badges", "Visitors not escorted"], ["UC-PHY-01", "UC-IAM-04"]),
  t("TH-NAT-01", "natural", "Natural disaster affecting a site or a region", "environmental", [A], ["Single site or single cloud region", "Recovery never tested"], ["UC-BCP-01", "UC-OPS-07", "UC-DAT-05"]),
  t("TH-SVC-01", "essential_services", "Loss of power, cooling or network connectivity", "structural", [A], ["No redundant supply or link", "No capacity monitoring"], ["UC-OPS-07", "UC-BCP-01", "UC-PHY-01"]),
  t("TH-SVC-02", "essential_services", "Outage or failure of a cloud or ICT provider", "structural", [A, I], ["Concentration on one provider", "No exit plan"], ["UC-TPM-01", "UC-TPM-03", "UC-TPM-04", "UC-BCP-01"], ["service", "vendor"]),
  t("TH-TEC-01", "technical_failure", "Hardware or storage failure with loss of data", "structural", [A, I], ["Backups not taken or not restorable", "No redundancy"], ["UC-DAT-05", "UC-OPS-07"]),
  t("TH-TEC-02", "technical_failure", "Software defect or failed change in production", "accidental", [A, I], ["Changes released without review or test", "No rollback"], ["UC-OPS-06", "UC-SDL-01", "UC-OPS-09"], ["repository", "application", "service"]),
  t("TH-TEC-03", "technical_failure", "Capacity exhaustion or performance degradation", "structural", [A], ["No capacity planning", "No autoscaling or limits"], ["UC-OPS-07", "UC-OPS-05"]),
  t("TH-INF-01", "information_compromise", "Exploitation of a known software vulnerability", "adversarial", [C, I, A], ["Patches applied late", "Unsupported components", "No vulnerability scanning"], ["UC-OPS-02", "UC-OPS-01", "UC-OPS-04"]),
  t("TH-INF-02", "information_compromise", "Compromise of credentials (phishing, reuse, stuffing)", "adversarial", [C, I], ["No multi-factor authentication", "Shared or long-lived credentials"], ["UC-IAM-02", "UC-HR-02", "UC-IAM-01"]),
  t("TH-INF-03", "information_compromise", "Abuse of privileged access", "adversarial", [C, I, A], ["Standing administrator rights", "Privileged actions not logged"], ["UC-IAM-03", "UC-OPS-05", "UC-GOV-02"]),
  t("TH-INF-04", "information_compromise", "Malware or ransomware", "adversarial", [C, I, A], ["Endpoints without protection", "Flat network", "Backups reachable from production"], ["UC-OPS-03", "UC-OPS-04", "UC-DAT-05", "UC-INC-01"]),
  t("TH-INF-05", "information_compromise", "Disclosure of information by interception or misdirection", "adversarial", [C], ["Data sent or stored unencrypted", "No data classification"], ["UC-DAT-03", "UC-DAT-01", "UC-DAT-04"]),
  t("TH-INF-06", "information_compromise", "Secrets or personal data committed to source control", "accidental", [C], ["No secret scanning", "No pre-commit checks"], ["UC-SDL-01", "UC-DAT-04"], ["repository"]),
  t("TH-INF-07", "information_compromise", "Compromise through a supplier or a software dependency", "adversarial", [C, I, A], ["Dependencies not inventoried or pinned", "Supplier access not reviewed"], ["UC-TPM-01", "UC-TPM-02", "UC-OPS-02", "UC-SDL-01"]),
  t("TH-INF-08", "information_compromise", "Unauthorised access to data by an insider", "adversarial", [C, I], ["Access broader than the role needs", "Leavers not deprovisioned"], ["UC-IAM-04", "UC-IAM-01", "UC-OPS-05", "UC-HR-01"]),
  t("TH-INF-09", "information_compromise", "Tampering with data or with records", "adversarial", [I], ["No integrity checks", "Shared accounts"], ["UC-OPS-11", "UC-OPS-05", "UC-IAM-04"]),
  t("TH-FUN-01", "function_compromise", "Denial of service", "adversarial", [A], ["No rate limiting or upstream protection", "Single point of failure"], ["UC-OPS-04", "UC-OPS-07", "UC-INC-01"], ["service", "application"]),
  t("TH-FUN-02", "function_compromise", "Unauthorised change to configuration or infrastructure", "adversarial", [I, A], ["Configuration not under change control", "No baseline or drift detection"], ["UC-OPS-01", "UC-OPS-06", "UC-OPS-05"]),
  t("TH-FUN-03", "function_compromise", "Misuse of an AI system or of its outputs", "adversarial", [I, C], ["No human oversight", "Inputs and outputs not logged"], ["UC-AI-05", "UC-AI-04", "UC-AI-02"], ["ai_model", "model"]),
  t("TH-HUM-01", "human_error", "Operating error (wrong command, wrong environment)", "accidental", [I, A], ["Production access without safeguards", "Procedures not written down"], ["UC-OPS-08", "UC-OPS-06", "UC-HR-02"]),
  t("TH-HUM-02", "human_error", "Misconfiguration exposing a service or data to the internet", "accidental", [C, I], ["Defaults not hardened", "No configuration review"], ["UC-OPS-01", "UC-OPS-04", "UC-TPM-03"]),
  t("TH-HUM-03", "human_error", "Accidental deletion or overwrite of data", "accidental", [A, I], ["No backup or versioning", "No retention rules"], ["UC-DAT-05", "UC-DAT-02"]),
  t("TH-HUM-04", "human_error", "Sending information to the wrong recipient", "accidental", [C], ["No classification or labelling", "No awareness training"], ["UC-DAT-01", "UC-HR-02", "UC-DAT-04"]),
  t("TH-ORG-01", "organisational", "Loss of key staff or of knowledge held by one person", "structural", [A], ["Undocumented procedures", "No deputy for critical roles"], ["UC-GOV-02", "UC-OPS-08", "UC-HR-02"]),
  t("TH-ORG-02", "organisational", "Breach of a legal, regulatory or contractual obligation", "structural", [C, I], ["Obligations not identified", "No compliance monitoring"], ["UC-CMP-01", "UC-GOV-01", "UC-PRV-01"]),
  t("TH-ORG-03", "organisational", "Unlawful processing of personal data", "structural", [C], ["No record of processing", "No impact assessment", "Transfers without safeguards"], ["UC-PRV-01", "UC-PRV-03", "UC-PRV-05", "UC-PRV-02"]),
  t("TH-ORG-04", "organisational", "Incident not detected or not handled in time", "structural", [C, I, A], ["No monitoring or alerting", "No tested response plan"], ["UC-OPS-05", "UC-INC-01", "UC-INC-02"]),
  t("TH-ORG-05", "organisational", "Recovery fails when it is needed", "structural", [A], ["Continuity plan never exercised", "Restoration never tested"], ["UC-BCP-01", "UC-BCP-02", "UC-DAT-05", "UC-OPS-09"]),
];

export const THREAT_BY_ID = new Map(THREATS.map((threat) => [threat.id, threat]));

export type Valuation = Record<Dimension, number>;

/**
 * A scenario for one threat on one asset. The impact follows the asset: the consequence of losing a property cannot be worth more
 * than that property is to the organisation, so each affected dimension takes the asset's value for it, and the scenario's impact is
 * the highest of them. Likelihood is left to the assessor.
 */
export function scenarioFor(threat: Threat, asset: { name: string; valuation: Valuation | null }) {
  const byDimension = Object.fromEntries(threat.affects.map((dimension) => [dimension, asset.valuation ? asset.valuation[dimension] : null])) as Partial<Record<Dimension, number | null>>;
  const known = Object.values(byDimension).filter((value): value is number => typeof value === "number");
  return {
    title: `${threat.title}: ${asset.name}`,
    threatId: threat.id,
    threatSource: threat.origin,
    threatEvent: threat.title,
    vulnerability: threat.vulnerabilities.join("; "),
    impactByDimension: byDimension,
    impact: known.length ? Math.max(...known) : null,
    controls: threat.controls,
  };
}
