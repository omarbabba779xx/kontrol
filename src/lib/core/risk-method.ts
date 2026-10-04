import type { Band } from "@/lib/core/risk-rating";

/**
 * The risk assessment method an organisation has decided to use. ISO/IEC 27001 clause 6.1.2 asks for risk criteria that are defined,
 * applied consistently and approved; this is where they live. Two methods are built in:
 *
 *   iso27005      a likelihood x impact matrix (1-5 each). The organisation sets where "medium", "high" and "critical" start.
 *   nist_800_30   NIST SP 800-30 Rev. 1. A risk is described by a threat source, a threat event, a vulnerability and predisposing
 *                 conditions. Likelihood has two parts: that the event is initiated or occurs, and that it then results in adverse
 *                 impact. They combine through the assessment scale of Table G-5, and the level of risk comes from Table I-2.
 *
 * The matrix method rates on four bands. SP 800-30 rates on its own five levels, which is what is shown and decided on; a band is
 * still derived for the method-neutral parts of the product (summary counts across methods). The risk appetite is the highest rating
 * the organisation accepts without a management decision, stated in the scale of the method in use.
 */
export const METHODS = ["iso27005", "nist_800_30"] as const;
export type MethodId = (typeof METHODS)[number];
export const THREAT_SOURCES = ["adversarial", "accidental", "structural", "environmental"] as const;
export type ThreatSource = (typeof THREAT_SOURCES)[number];

export type RiskMethod = {
  method: MethodId;
  /** Lowest score (likelihood x impact, 1-25) of each band, for the matrix method. */
  thresholds: { medium: number; high: number; critical: number };
  /** Highest band accepted without a management decision. */
  appetite: Exclude<Band, "critical">;
  /**
   * Under SP 800-30 the appetite is stated on NIST's own five levels (1 very low to 4 high; very high is never within appetite), so that
   * "very low" and "low" stay distinct. Absent, it follows `appetite`.
   */
  appetiteLevel?: number;
  maxAcceptanceDays: number;
  likelihoodLabels: string[];
  impactLabels: string[];
  /** What each impact level means for this organisation (money, service, people, legal), in its own words. */
  impactCriteria: string[];
  /** What each impact level means for each security property: five entries for confidentiality, integrity and availability. */
  impactCriteriaByDimension?: Record<"confidentiality" | "integrity" | "availability", string[]>;
  version: number;
  approvedBy: string | null;
  approvedAt: string | null;
};

const LEVELS = ["Very low", "Low", "Moderate", "High", "Very high"];

export const DEFAULT_METHOD: RiskMethod = {
  method: "iso27005",
  thresholds: { medium: 5, high: 10, critical: 17 },
  appetite: "medium",
  maxAcceptanceDays: 365,
  likelihoodLabels: LEVELS,
  impactLabels: LEVELS,
  impactCriteria: ["", "", "", "", ""],
  version: 0,
  approvedBy: null,
  approvedAt: null,
};

// Both tables below were checked cell by cell against the publication (nvlpubs.nist.gov, SP 800-30 Rev. 1, appendices G and I).
// NIST SP 800-30 Rev. 1, Table G-5: overall likelihood. Rows: likelihood of threat event initiation or occurrence (very low to very
// high). Columns: likelihood that the event results in adverse impact (very low to very high). Values are levels 1-5.
const TABLE_G5 = [
  [1, 1, 2, 2, 2],
  [1, 2, 2, 3, 3],
  [2, 2, 3, 3, 4],
  [2, 3, 3, 4, 5],
  [2, 3, 4, 5, 5],
];

// NIST SP 800-30 Rev. 1, Table I-2: level of risk. Rows: overall likelihood (very low to very high). Columns: level of impact.
const TABLE_I2 = [
  [1, 1, 1, 2, 2],
  [1, 2, 2, 2, 3],
  [1, 2, 3, 3, 4],
  [1, 2, 3, 4, 5],
  [1, 2, 3, 4, 5],
];

const level = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new RangeError(`${label} must be between 1 and 5`);
  return value - 1;
};

/** Table G-5: the overall likelihood from its two parts. */
export function overallLikelihood(initiation: number, adverseImpact: number) {
  return TABLE_G5[level(initiation, "Likelihood of initiation")][level(adverseImpact, "Likelihood of adverse impact")];
}

/** Table I-2: the level of risk (1 very low to 5 very high). */
export function nistRiskLevel(likelihood: number, impact: number) {
  return TABLE_I2[level(likelihood, "Likelihood")][level(impact, "Impact")];
}

/** NIST's five levels of risk, in its own words. */
export const NIST_LEVELS = ["Very low", "Low", "Moderate", "High", "Very high"] as const;
// The four bands exist for the parts of the product that are method-neutral (colours, cross-method summaries). Under SP 800-30 the
// rating shown, the appetite and the decisions all use the five levels; the band never decides anything there.
const NIST_BAND: Band[] = ["low", "low", "medium", "high", "critical"];
const LEVEL_OF_APPETITE: Record<RiskMethod["appetite"], number> = { low: 2, medium: 3, high: 4 };
const ORDER: Band[] = ["low", "medium", "high", "critical"];

export function bandFor(method: RiskMethod, likelihood: number, impact: number): Band {
  if (method.method === "nist_800_30") return NIST_BAND[nistRiskLevel(likelihood, impact) - 1];
  const score = likelihood * impact;
  return score >= method.thresholds.critical ? "critical" : score >= method.thresholds.high ? "high" : score >= method.thresholds.medium ? "medium" : "low";
}

export const exceedsAppetite = (method: RiskMethod, band: Band) => ORDER.indexOf(band) > ORDER.indexOf(method.appetite);

/** The level of risk on NIST's five-level scale (1 to 5) with its label, or null under the matrix method. */
export function levelFor(method: RiskMethod, likelihood: number, impact: number) {
  if (method.method !== "nist_800_30") return null;
  const level = nistRiskLevel(likelihood, impact);
  return { level, label: NIST_LEVELS[level - 1] };
}

export const appetiteLevelOf = (method: RiskMethod) => method.appetiteLevel ?? LEVEL_OF_APPETITE[method.appetite];

/** Whether a rating is above the appetite: on the five NIST levels under SP 800-30, on the bands under the matrix method. */
export function aboveAppetite(method: RiskMethod, likelihood: number, impact: number) {
  if (method.method === "nist_800_30") return nistRiskLevel(likelihood, impact) > appetiteLevelOf(method);
  return exceedsAppetite(method, bandFor(method, likelihood, impact));
}

/** Checks a method before it is stored: thresholds in order and inside the matrix, five labels per scale, a sane acceptance limit. */
export function validateMethod(input: Pick<RiskMethod, "method" | "thresholds" | "appetite" | "maxAcceptanceDays" | "likelihoodLabels" | "impactLabels" | "impactCriteria"> & { appetiteLevel?: number; impactCriteriaByDimension?: RiskMethod["impactCriteriaByDimension"] }): string | null {
  if (!METHODS.includes(input.method)) return "Unknown method";
  if (input.appetiteLevel !== undefined && (!Number.isInteger(input.appetiteLevel) || input.appetiteLevel < 1 || input.appetiteLevel > 4)) return "The appetite level is between 1 (very low) and 4 (high): a very high risk is never within appetite";
  if (input.appetiteLevel !== undefined && input.method !== "nist_800_30") return "An appetite level applies to NIST SP 800-30; the matrix method uses the appetite band";
  const { medium, high, critical } = input.thresholds;
  if (![medium, high, critical].every((value) => Number.isInteger(value) && value >= 2 && value <= 25)) return "Thresholds must be whole scores between 2 and 25";
  if (!(medium < high && high < critical)) return "Thresholds must increase: medium, then high, then critical";
  if (!["low", "medium", "high"].includes(input.appetite)) return "The appetite is low, medium or high: a critical risk is never within appetite";
  if (!Number.isInteger(input.maxAcceptanceDays) || input.maxAcceptanceDays < 1 || input.maxAcceptanceDays > 730) return "An acceptance lasts between 1 and 730 days";
  for (const [name, labels] of [["likelihood", input.likelihoodLabels], ["impact", input.impactLabels], ["impact criteria", input.impactCriteria]] as const) {
    if (labels.length !== 5) return `Give five ${name} entries, one per level`;
  }
  if ([...input.likelihoodLabels, ...input.impactLabels].some((label) => !label.trim() || label.length > 60)) return "Scale labels must be 1 to 60 characters";
  if (input.impactCriteria.some((text) => text.length > 400)) return "An impact criterion is at most 400 characters";
  for (const [dimension, levels] of Object.entries(input.impactCriteriaByDimension ?? {})) {
    if (!["confidentiality", "integrity", "availability"].includes(dimension)) return "Impact criteria are given for confidentiality, integrity and availability";
    if (!Array.isArray(levels) || levels.length !== 5 || levels.some((text) => typeof text !== "string" || text.length > 400)) return `Give five ${dimension} criteria of at most 400 characters, one per level`;
  }
  return null;
}
