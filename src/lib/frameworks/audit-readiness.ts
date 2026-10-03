import type { ControlState, FrameworkScore } from "@/lib/frameworks/scoring";

/**
 * Audit readiness is not an average. A high declared score says what people claim; readiness asks whether the claims are backed, reviewed
 * and free of blocking problems. Four things are kept apart and reported side by side:
 *
 *   declared      the progress people attested (the score)
 *   documentary   the share of in-scope controls backed by a reviewed, unexpired document
 *   technical     the share of in-scope controls whose latest machine evidence is healthy and current
 *   backed        controls backed by either of the two above (what an auditor can sample)
 *
 * and a list of blockers and reservations with their counts. A level is a rule over them, written out in `criteria`, so the same
 * numbers always give the same level and the reader can see which condition held it back.
 */
export type ReadinessLevel = "not_ready" | "in_progress" | "ready_with_reservations" | "audit_ready";
export const LEVEL_LABEL: Record<ReadinessLevel, string> = { not_ready: "Not ready", in_progress: "In progress", ready_with_reservations: "Ready with reservations", audit_ready: "Audit ready" };
export const LEVEL_ORDER: ReadinessLevel[] = ["not_ready", "in_progress", "ready_with_reservations", "audit_ready"];

export type ReadinessInputs = {
  score: FrameworkScore;
  states: Map<string, ControlState>;
  /** Controls with at least one accepted, unexpired document. */
  documented: Set<string>;
  openHighFindings: number;
  expiredExceptions: number;
  /** Exclusions recorded without a justification (should be none: the form requires one). */
  unjustifiedExclusions: number;
  requireCountersignature: boolean;
};

export type Criterion = { id: string; label: string; met: boolean; blocking: boolean; value: string; threshold: string };

export type ReadinessAssessment = {
  level: ReadinessLevel;
  label: string;
  dimensions: { declared: number; documentary: number; technical: number; backed: number };
  scope: { controls: number; requirements: number; excluded: number; excludedShare: number };
  blockers: string[];
  reservations: string[];
  criteria: Criterion[];
  nextSteps: string[];
};

const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);

export const THRESHOLDS = { declaredReady: 85, backedReady: 80, declaredReservations: 70, backedReservations: 50, maxExcludedShare: 40 } as const;

export function assessReadiness(input: ReadinessInputs): ReadinessAssessment {
  const { score, states } = input;
  const scored = score.requirements.filter((requirement) => requirement.score !== null);
  const controlCodes = [...new Set(scored.flatMap((requirement) => requirement.controls))];
  // Controls explicitly out of scope everywhere are not counted: a control that cannot apply cannot be missing evidence.
  const inScope = controlCodes.filter((code) => states.get(code)?.status !== "not_applicable");
  const state = (code: string) => states.get(code);
  const documentedCount = inScope.filter((code) => input.documented.has(code)).length;
  const technicalCount = inScope.filter((code) => state(code)?.verification === "verified").length;
  const backedCount = inScope.filter((code) => ["verified", "documented"].includes(state(code)?.verification ?? "unverified")).length;

  const claimed = inScope.filter((code) => ["implemented", "partial"].includes(state(code)?.status ?? "not_started"));
  const contradicted = claimed.filter((code) => state(code)?.verification === "failing");
  const expired = inScope.filter((code) => state(code)?.attestationExpired);
  const awaiting = input.requireCountersignature ? inScope.filter((code) => state(code)?.awaitingCountersignature) : [];
  const lapsed = claimed.filter((code) => state(code)?.verification === "stale");
  const excluded = score.requirements.filter((requirement) => !requirement.applicable && requirement.justification !== null).length;
  const totalRequirements = score.requirements.filter((requirement) => requirement.score !== null || requirement.justification !== null).length;
  const excludedShare = pct(excluded, totalRequirements);

  const dimensions = { declared: score.score, documentary: pct(documentedCount, inScope.length), technical: pct(technicalCount, inScope.length), backed: pct(backedCount, inScope.length) };

  const criteria: Criterion[] = [
    { id: "declared", label: "Declared progress", met: score.score >= THRESHOLDS.declaredReady, blocking: false, value: `${score.score}%`, threshold: `at least ${THRESHOLDS.declaredReady}%` },
    { id: "backed", label: "Controls backed by evidence", met: dimensions.backed >= THRESHOLDS.backedReady, blocking: false, value: `${dimensions.backed}% (${backedCount} of ${inScope.length})`, threshold: `at least ${THRESHOLDS.backedReady}%` },
    { id: "contradictions", label: "Claims contradicted by failing evidence", met: contradicted.length === 0, blocking: true, value: String(contradicted.length), threshold: "none" },
    { id: "expired_attestations", label: "Attestations past their review date without other backing", met: expired.length === 0, blocking: true, value: String(expired.length), threshold: "none" },
    { id: "countersignature", label: "Claims awaiting the second confirmation the organisation requires", met: awaiting.length === 0, blocking: true, value: String(awaiting.length), threshold: "none" },
    { id: "open_findings", label: "Open high or critical findings", met: input.openHighFindings === 0, blocking: true, value: String(input.openHighFindings), threshold: "none" },
    { id: "unjustified_exclusions", label: "Requirements excluded without a justification", met: input.unjustifiedExclusions === 0, blocking: true, value: String(input.unjustifiedExclusions), threshold: "none" },
    { id: "lapsed_evidence", label: "Claims whose evidence has expired", met: lapsed.length === 0, blocking: false, value: String(lapsed.length), threshold: "none" },
    { id: "exclusion_share", label: "Share of requirements excluded from scope", met: excludedShare <= THRESHOLDS.maxExcludedShare, blocking: false, value: `${excludedShare}% (${excluded} of ${totalRequirements})`, threshold: `at most ${THRESHOLDS.maxExcludedShare}%` },
    { id: "exceptions", label: "Risk acceptances past their expiry", met: input.expiredExceptions === 0, blocking: false, value: String(input.expiredExceptions), threshold: "none" },
  ];

  const blockers = criteria.filter((item) => item.blocking && !item.met).map((item) => `${item.label}: ${item.value}`);
  const reservations = criteria.filter((item) => !item.blocking && !["declared", "backed"].includes(item.id) && !item.met).map((item) => `${item.label}: ${item.value}`);

  let level: ReadinessLevel;
  if (scored.length === 0 || score.score < 30) level = "not_ready";
  else if (blockers.length > 0) level = "in_progress"; // a blocking problem caps readiness whatever the scores say
  else if (score.score >= THRESHOLDS.declaredReady && dimensions.backed >= THRESHOLDS.backedReady && reservations.length === 0) level = "audit_ready";
  else if (score.score >= THRESHOLDS.declaredReservations && dimensions.backed >= THRESHOLDS.backedReservations) level = "ready_with_reservations";
  else level = "in_progress";

  const nextSteps: string[] = [];
  if (contradicted.length) nextSteps.push(`Fix or correct the ${contradicted.length} claim(s) that live evidence contradicts.`);
  if (expired.length) nextSteps.push(`Re-attest or back the ${expired.length} attestation(s) past their review date.`);
  if (awaiting.length) nextSteps.push(`Have a second person confirm ${awaiting.length} attested control(s).`);
  if (input.openHighFindings) nextSteps.push(`Close the ${input.openHighFindings} open high or critical finding(s).`);
  const unbacked = claimed.length - claimed.filter((code) => ["verified", "documented"].includes(state(code)?.verification ?? "unverified")).length;
  if (unbacked > 0 && dimensions.backed < THRESHOLDS.backedReady) nextSteps.push(`Provide a reviewed document or machine evidence for ${unbacked} control(s) that are only attested.`);
  if (lapsed.length) nextSteps.push(`Renew the evidence of ${lapsed.length} control(s) whose evidence expired.`);
  if (excludedShare > THRESHOLDS.maxExcludedShare) nextSteps.push("Review the scope exclusions: an auditor will challenge a scope this heavily reduced.");

  return {
    level, label: LEVEL_LABEL[level], dimensions,
    scope: { controls: inScope.length, requirements: scored.length, excluded, excludedShare },
    blockers, reservations, criteria, nextSteps: nextSteps.slice(0, 5),
  };
}

/** The weakest level across frameworks: an organisation is as ready as its least ready scope. */
export function weakestLevel(levels: ReadinessLevel[]): ReadinessLevel | null {
  if (!levels.length) return null;
  return levels.reduce((weakest, level) => (LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(weakest) ? level : weakest));
}
