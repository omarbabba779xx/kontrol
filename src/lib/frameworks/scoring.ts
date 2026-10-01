import { FRAMEWORKS, FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { baseControls, baseRequirements, linkKey } from "@/lib/frameworks/mapping";
import { UNIFIED_CONTROLS, effortOf } from "@/lib/frameworks/unified";
import type { FrameworkId, ImplementationStatus } from "@/lib/frameworks/types";

/** How well a unified control's implementation is backed by machine-collected evidence. */
/**
 * How well a unified control's implementation is backed by evidence.
 *  - verified: the latest machine evidence of every linked executable control is healthy
 *  - documented: reviewed documentary evidence (accepted by someone other than its uploader) is still valid
 *  - failing: machine evidence contradicts the claim
 *  - stale: the evidence that existed has expired
 */
export type Verification = "verified" | "documented" | "unverified" | "failing" | "stale";

/** Evidence a person or a machine vouched for, as opposed to a bare attestation. */
export const isBacked = (verification: Verification) => verification === "verified" || verification === "documented";

export type ControlState = {
  status: ImplementationStatus;
  maturity: number;
  verification: Verification;
  /** An approved, unexpired risk-acceptance covers the remaining gap. */
  excepted: boolean;
  /** The attestation passed its review date and nothing else backs it: it can no longer count in full. */
  attestationExpired?: boolean;
  /** Organisation policy requires a second person to confirm attestations, and nobody has. */
  awaitingCountersignature?: boolean;
};

export type RequirementStatus = "compliant" | "partial" | "initial" | "gap" | "not_applicable";

export const STATUS_WEIGHT: Record<Exclude<ImplementationStatus, "not_applicable">, number> = { implemented: 1, partial: 0.5, planned: 0.15, not_started: 0 };

/** A control whose live evidence is failing cannot count for more than a partial implementation, whatever was attested. */
export function controlWeight(state: ControlState): number | null {
  if (state.status === "not_applicable") return null;
  const weight = STATUS_WEIGHT[state.status];
  // Failing machine evidence, a lapsed attestation and a missing countersignature each cap a claim at "partial".
  return state.verification === "failing" || state.attestationExpired || state.awaitingCountersignature ? Math.min(weight, 0.5) : weight;
}

export function requirementStatus(score: number | null): RequirementStatus {
  if (score === null) return "not_applicable";
  if (score >= 0.85) return "compliant";
  if (score >= 0.4) return "partial";
  if (score > 0) return "initial";
  return "gap";
}

/** Tenant-level review of the built-in crosswalk: rejected links stop counting, added links start counting. */
export type CustomRequirement = { id: string; title: string; group: string; parent: string; controls: string[] };
export type MappingOverrides = { rejected: Set<string>; added: Map<string, string[]>; /** Sub-requirements imported from a licensed copy, per framework. */ custom?: Map<FrameworkId, CustomRequirement[]> };
export const NO_OVERRIDES: MappingOverrides = { rejected: new Set(), added: new Map() };

function customOf(frameworkId: FrameworkId, requirementId: string, overrides: MappingOverrides) {
  return overrides.custom?.get(frameworkId)?.find((item) => item.id === requirementId);
}

export function mappedControls(frameworkId: FrameworkId, requirementId: string, overrides: MappingOverrides = NO_OVERRIDES) {
  const base = customOf(frameworkId, requirementId, overrides)?.controls ?? baseControls(frameworkId, requirementId);
  const kept = base.filter((code) => !overrides.rejected.has(linkKey(frameworkId, requirementId, code)));
  const added = overrides.added.get(`${frameworkId}|${requirementId}`) ?? [];
  return [...new Set([...kept, ...added])];
}

/** Requirements a control currently advances in a framework, after tenant overrides. */
export function requirementsOf(ucCode: string, frameworkId: FrameworkId, overrides: MappingOverrides = NO_OVERRIDES) {
  const customIds = (overrides.custom?.get(frameworkId) ?? []).filter((item) => item.controls.includes(ucCode)).map((item) => item.id);
  const kept = [...baseRequirements(ucCode, frameworkId), ...customIds].filter((id) => !overrides.rejected.has(linkKey(frameworkId, id, ucCode)));
  const added: string[] = [];
  for (const [key, codes] of overrides.added) if (key.startsWith(`${frameworkId}|`) && codes.includes(ucCode)) added.push(key.slice(frameworkId.length + 1));
  return [...new Set([...kept, ...added])];
}

export const DEFAULT_STATE: ControlState = { status: "not_started", maturity: 0, verification: "unverified", excepted: false };

export type RequirementResult = {
  /** Present on sub-requirements imported from a licensed copy. */
  custom?: boolean;
  id: string;
  title: string;
  group: string;
  applicable: boolean;
  justification: string | null;
  score: number | null;
  status: RequirementStatus;
  verified: boolean;
  controls: string[];
};

export type FrameworkScore = {
  frameworkId: FrameworkId;
  score: number;
  verifiedShare: number;
  applicable: number;
  compliant: number;
  partial: number;
  gaps: number;
  notApplicable: number;
  readiness: "Audit ready" | "Near ready" | "In progress" | "Early stage";
  groups: Array<{ group: string; score: number; applicable: number }>;
  requirements: RequirementResult[];
};

export function readinessLabel(score: number): FrameworkScore["readiness"] {
  return score >= 90 ? "Audit ready" : score >= 70 ? "Near ready" : score >= 40 ? "In progress" : "Early stage";
}

export type NotApplicable = Map<string, string>;

export function scoreFramework(frameworkId: FrameworkId, states: Map<string, ControlState>, notApplicable: NotApplicable = new Map(), overrides: MappingOverrides = NO_OVERRIDES): FrameworkScore {
  const framework = FRAMEWORK_BY_ID.get(frameworkId);
  if (!framework) throw new Error(`Framework ${frameworkId} not found`);

  const imported = overrides.custom?.get(frameworkId) ?? [];
  // A requirement refined by imported sub-requirements is replaced by them in the score, so nothing counts twice.
  const refined = new Map<string, number>();
  for (const item of imported) refined.set(item.parent, (refined.get(item.parent) ?? 0) + 1);
  const catalogue = [...framework.requirements, ...imported.map((item) => ({ id: item.id, title: item.title, group: item.group, parent: item.parent, custom: true as const }))];

  const requirements: RequirementResult[] = catalogue.map((requirement) => {
    const controls = mappedControls(frameworkId, requirement.id, overrides);
    if (refined.has(requirement.id) && !notApplicable.has(requirement.id)) return { ...requirement, applicable: false, justification: `Refined into ${refined.get(requirement.id)} imported sub-requirement(s), which are scored instead`, score: null, status: "not_applicable", verified: false, controls };
    const justification = notApplicable.get(requirement.id) ?? null;
    if (justification !== null) return { ...requirement, applicable: false, justification, score: null, status: "not_applicable", verified: false, controls };

    const weights: number[] = [];
    let verified = true;
    for (const code of controls) {
      const state = states.get(code) ?? DEFAULT_STATE;
      const weight = controlWeight(state);
      if (weight === null) continue;
      weights.push(weight);
      if (!isBacked(state.verification)) verified = false;
    }
    // Every mapped control being out of scope takes the requirement out of scope with it.
    if (weights.length === 0) return { ...requirement, applicable: controls.length > 0, justification: null, score: controls.length > 0 ? null : 0, status: controls.length > 0 ? "not_applicable" : "gap", verified: false, controls };
    const score = weights.reduce((sum, weight) => sum + weight, 0) / weights.length;
    return { ...requirement, applicable: true, justification: null, score, status: requirementStatus(score), verified: verified && score > 0, controls };
  });

  const scored = requirements.filter((requirement) => requirement.score !== null);
  const total = scored.reduce((sum, requirement) => sum + (requirement.score ?? 0), 0);
  const score = scored.length ? (total / scored.length) * 100 : 0;
  const groups = new Map<string, { sum: number; count: number }>();
  for (const requirement of scored) {
    const entry = groups.get(requirement.group) ?? { sum: 0, count: 0 };
    entry.sum += requirement.score ?? 0;
    entry.count += 1;
    groups.set(requirement.group, entry);
  }
  return {
    frameworkId,
    score: Math.round(score * 10) / 10,
    verifiedShare: scored.length ? Math.round((scored.filter((requirement) => requirement.verified).length / scored.length) * 1000) / 10 : 0,
    applicable: scored.length,
    compliant: scored.filter((requirement) => requirement.status === "compliant").length,
    partial: scored.filter((requirement) => requirement.status === "partial" || requirement.status === "initial").length,
    gaps: scored.filter((requirement) => requirement.status === "gap").length,
    notApplicable: requirements.length - scored.length,
    readiness: readinessLabel(score),
    groups: [...groups.entries()].map(([group, entry]) => ({ group, score: Math.round((entry.sum / entry.count) * 1000) / 10, applicable: entry.count })),
    requirements,
  };
}

export type RoadmapItem = {
  code: string;
  title: string;
  domain: string;
  currentStatus: ImplementationStatus;
  verification: Verification;
  effort: number;
  /** Requirement-equivalents closed by completing this control across the adopted frameworks. */
  leverage: number;
  priority: number;
  closes: Array<{ frameworkId: FrameworkId; requirements: number }>;
  excepted: boolean;
};

/** Ranks incomplete unified controls by how much compliance they unlock per unit of effort. */
export function buildRoadmap(adopted: FrameworkId[], states: Map<string, ControlState>, notApplicable: Map<FrameworkId, NotApplicable> = new Map(), overrides: MappingOverrides = NO_OVERRIDES): RoadmapItem[] {
  const items: RoadmapItem[] = [];
  for (const control of UNIFIED_CONTROLS) {
    const state = states.get(control.code) ?? DEFAULT_STATE;
    const weight = controlWeight(state);
    if (weight === null || (weight >= 1 && state.verification !== "failing")) continue;
    const closes: RoadmapItem["closes"] = [];
    let leverage = 0;
    for (const frameworkId of adopted) {
      const excluded = notApplicable.get(frameworkId);
      const ids = requirementsOf(control.code, frameworkId, overrides).filter((id) => !excluded?.has(id));
      if (!ids.length) continue;
      closes.push({ frameworkId, requirements: ids.length });
      // A requirement shared by n controls moves by 1/n when this one is completed.
      for (const id of ids) leverage += (1 - weight) / Math.max(1, mappedControls(frameworkId, id, overrides).length);
    }
    if (!closes.length) continue;
    const effort = effortOf(control.code);
    items.push({ code: control.code, title: control.title, domain: control.domain, currentStatus: state.status, verification: state.verification, effort, leverage: Math.round(leverage * 100) / 100, priority: Math.round((leverage / effort) * 100) / 100, closes, excepted: state.excepted });
  }
  return items.sort((a, b) => b.priority - a.priority);
}

/** Requirements in other frameworks that the same unified controls also satisfy. */
export function crosswalk(frameworkId: FrameworkId, requirementId: string, overrides: MappingOverrides = NO_OVERRIDES) {
  const controls = mappedControls(frameworkId, requirementId, overrides);
  const related = new Map<FrameworkId, Set<string>>();
  for (const code of controls) {
    for (const other of FRAMEWORKS) {
      if (other.id === frameworkId) continue;
      const ids = requirementsOf(code, other.id, overrides);
      if (!ids.length) continue;
      const set = related.get(other.id) ?? new Set<string>();
      for (const id of ids) set.add(id);
      related.set(other.id, set);
    }
  }
  return { controls, related: [...related.entries()].map(([id, set]) => ({ frameworkId: id, requirements: [...set].map((reqId) => ({ id: reqId, title: FRAMEWORK_BY_ID.get(id)?.requirements.find((requirement) => requirement.id === reqId)?.title ?? reqId })) })) };
}

/** Share of each target framework's requirements already addressed by controls that the base framework needs. */
export function overlapMatrix() {
  const touched = new Map<FrameworkId, Set<string>>();
  for (const framework of FRAMEWORKS) {
    const set = new Set<string>();
    for (const control of UNIFIED_CONTROLS) if (baseRequirements(control.code, framework.id).length) set.add(control.code);
    touched.set(framework.id, set);
  }
  return FRAMEWORKS.map((base) => ({
    base: base.id,
    targets: FRAMEWORKS.filter((target) => target.id !== base.id).map((target) => {
      const covered = target.requirements.filter((requirement) => baseControls(target.id, requirement.id).some((code) => touched.get(base.id)?.has(code))).length;
      return { target: target.id, share: Math.round((covered / target.requirements.length) * 100) };
    }),
  }));
}
