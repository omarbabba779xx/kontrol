/**
 * Qualitative risk rating on a 5x5 matrix (ISO 27005 style) and the residual risk after controls.
 *
 * Residual likelihood is the inherent likelihood reduced by how effective the linked controls really are. A control counts by its
 * implementation weight (implemented 1, partial 0.5, planned 0.15), discounted by 30% when nothing but an attestation backs it, and
 * a claim contradicted by failing evidence is already capped at partial upstream. Controls never remove more than 80% of the
 * likelihood, and they do not reduce impact: a control that works does not make the consequence of the event smaller.
 */
export type Band = "low" | "medium" | "high" | "critical";

export const MAX_REDUCTION = 0.8;
export const UNBACKED_DISCOUNT = 0.7;

export const scoreOf = (likelihood: number, impact: number) => likelihood * impact;

export function bandOf(score: number): Band {
  return score >= 17 ? "critical" : score >= 10 ? "high" : score >= 5 ? "medium" : "low";
}

export type ControlEffect = {
  code: string;
  /** implementation weight 0..1, null when not applicable */ weight: number | null;
  backed: boolean;
};

export function controlEffectiveness(effect: ControlEffect) {
  if (effect.weight === null) return null;
  return effect.weight * (effect.backed ? 1 : UNBACKED_DISCOUNT);
}

export function residual(input: { likelihood: number; impact: number; controls: ControlEffect[]; /** The organisation's own rating of a likelihood and an impact; the default matrix otherwise. */ rate?: (likelihood: number, impact: number) => Band }) {
  const values = input.controls.map(controlEffectiveness).filter((value): value is number => value !== null);
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const reduction = Math.min(MAX_REDUCTION, average * MAX_REDUCTION);
  // Rounded up: a residual rating is never flattered by rounding.
  const likelihood = Math.max(1, Math.ceil(input.likelihood * (1 - reduction) - 1e-9));
  const score = scoreOf(likelihood, input.impact);
  return {
    likelihood,
    impact: input.impact,
    score,
    band: input.rate ? input.rate(likelihood, input.impact) : bandOf(score),
    reduction: Math.round(reduction * 100) / 100,
    controlsConsidered: values.length,
  };
}

/** Counts of risks per likelihood x impact cell, for a heat map: result[likelihood-1][impact-1]. */
export function heatMap(cells: Array<{ likelihood: number; impact: number }>) {
  const grid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => 0));
  for (const cell of cells) grid[cell.likelihood - 1][cell.impact - 1] += 1;
  return grid;
}
