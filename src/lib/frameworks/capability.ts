import type { ControlState } from "@/lib/frameworks/scoring";

/**
 * Capability level (0 to 5) of a control and of the requirement or objective it serves, in the sense COBIT 2019 and ISO/IEC 33000 use:
 * 0 incomplete, 1 performed, 2 managed, 3 defined, 4 measured, 5 optimising.
 *
 * The level starts from the maturity the owner declared and is then held back by what is actually known:
 *   - a control that is not started is 0, a planned one at most 1, a partial one at most 2;
 *   - levels 4 and 5 are about measurement, so they need evidence: a claim backed only by an attestation stops at 3;
 *   - a claim contradicted by failing evidence, an attestation past its review date or one awaiting countersignature stops at 2.
 *
 * An objective is as capable as its weakest practice, so a requirement takes the lowest level among its controls.
 */
export const CAPABILITY_LABELS = ["Incomplete", "Performed", "Managed", "Defined", "Measured", "Optimising"] as const;

export function controlCapability(state: ControlState): number | null {
  if (state.status === "not_applicable") return null;
  if (state.status === "not_started") return 0;
  const declared = Math.max(1, Math.min(5, Math.round(state.maturity)));
  const byStatus = state.status === "planned" ? 1 : state.status === "partial" ? 2 : 5;
  const backed = state.verification === "verified" || state.verification === "documented";
  const byEvidence = state.verification === "failing" || state.attestationExpired || state.awaitingCountersignature ? 2 : backed ? 5 : 3;
  return Math.min(declared, byStatus, byEvidence);
}

export function requirementCapability(controls: string[], states: Map<string, ControlState>, fallback: ControlState): number | null {
  const levels = controls.map((code) => controlCapability(states.get(code) ?? fallback)).filter((level): level is number => level !== null);
  return levels.length ? Math.min(...levels) : null;
}

/** How many scored requirements sit at each level, and the level reached by at least `share` of them (the usual way a target is stated). */
export function capabilityProfile(levels: Array<number | null | undefined>) {
  const known = levels.filter((level): level is number => typeof level === "number");
  const distribution = [0, 0, 0, 0, 0, 0];
  for (const level of known) distribution[level] += 1;
  const average = known.length ? Math.round((known.reduce((sum, level) => sum + level, 0) / known.length) * 10) / 10 : 0;
  return { assessed: known.length, distribution, average, lowest: known.length ? Math.min(...known) : 0 };
}
