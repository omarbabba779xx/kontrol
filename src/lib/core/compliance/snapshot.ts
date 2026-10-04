import "server-only";

import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { listImports, loadCustomRequirements, loadLicensedText } from "@/lib/core/licensed-content";
import type { Executor } from "@/lib/db";
import { LEVEL_LABEL, assessReadiness, weakestLevel } from "@/lib/frameworks/audit-readiness";
import { FRAMEWORKS, FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { baseControls, linkBasis, linkSource, suggestedControls } from "@/lib/frameworks/mapping";
import { buildRoadmap, controlWeight, crosswalk, mappedControls, overlapMatrix, requirementsOf, scoreFramework } from "@/lib/frameworks/scoring";
import type { ControlState, MappingOverrides, NotApplicable } from "@/lib/frameworks/scoring";
import type { FrameworkId } from "@/lib/frameworks/types";
import { DOMAIN_LABELS, UC_BY_CODE, UNIFIED_CONTROLS } from "@/lib/frameworks/unified";
import { randomUUID } from "node:crypto";
import { DAY, adoptedIds, loadOverrides, loadReviews, loadScope, loadStates, mappingStats, requireCountersignature, scope, toOverrides } from "@/lib/core/compliance/state";
import type { EvidenceRow, ExceptionRow, PolicyRow } from "@/lib/core/compliance/state";

function summary(score: ReturnType<typeof scoreFramework>, assessment: ReturnType<typeof assess>) {
  return {
    frameworkId: score.frameworkId,
    score: score.score,
    verifiedShare: score.verifiedShare,
    applicable: score.applicable,
    compliant: score.compliant,
    partial: score.partial,
    gaps: score.gaps,
    notApplicable: score.notApplicable,
    declaredBand: score.declaredBand,
    capability: score.capability,
    readiness: assessment.label,
    readinessLevel: assessment.level,
    assessment,
    groups: score.groups,
  };
}

/**
 * What audit readiness needs beyond the score: which controls have a reviewed, unexpired document, how many high findings are open, whether
 * risk acceptances have lapsed, and whether any exclusion lacks its justification. Gathered once per snapshot.
 */
async function readinessContext(tenantId: string, documents: EvidenceRow[], scopes: Map<FrameworkId, NotApplicable>) {
  const db = await scope(tenantId);
  const now = new Date().toISOString();
  const documented = new Set(documents.filter((item) => item.status === "accepted" && item.valid_until > now).map((item) => item.uc_code));
  const findings = await db.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM findings WHERE tenant_id = ? AND status IN ('open','remediating') AND severity IN ('high','critical')",
    tenantId,
  );
  const lapsed = await db.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM compliance_exceptions WHERE tenant_id = ? AND status = 'approved' AND expires_at <= ?",
    tenantId,
    now,
  );
  const unjustified = (frameworkId: FrameworkId) =>
    [...(scopes.get(frameworkId) ?? new Map<string, string>()).values()].filter((text) => text.trim().length === 0).length;
  return {
    documented,
    openHighFindings: Number(findings?.n ?? 0),
    expiredExceptions: Number(lapsed?.n ?? 0),
    unjustified,
    requireCountersignature: requireCountersignature(),
  };
}

function assess(
  score: ReturnType<typeof scoreFramework>,
  states: Map<string, ControlState>,
  context: Awaited<ReturnType<typeof readinessContext>>,
  overrides: MappingOverrides,
) {
  // What the exclusions are worth: the same posture scored with nothing excluded. A big positive gap means the score leans on the scope.
  const withoutExclusions = score.notApplicable > 0 ? scoreFramework(score.frameworkId, states, new Map(), overrides).score : score.score;
  const assessment = assessReadiness({
    score,
    states,
    documented: context.documented,
    openHighFindings: context.openHighFindings,
    expiredExceptions: context.expiredExceptions,
    unjustifiedExclusions: context.unjustified(score.frameworkId),
    requireCountersignature: context.requireCountersignature,
  });
  return {
    ...assessment,
    scope: {
      ...assessment.scope,
      scoreWithoutExclusions: withoutExclusions,
      exclusionEffect: Math.round((score.score - withoutExclusions) * 10) / 10,
    },
  };
}

export async function complianceSnapshot(tenantId: string) {
  const db = await scope(tenantId);
  const [{ states, rows, documents }, scopes, adoptions, reviews, custom] = await Promise.all([
    loadStates(tenantId),
    loadScope(tenantId),
    adoptedIds(tenantId),
    loadReviews(tenantId),
    loadCustomRequirements(tenantId),
  ]);
  const overrides = toOverrides(reviews, custom);
  const adopted = adoptions.map((row) => row.framework_id);
  const scores = adopted.map((id) => scoreFramework(id, states, scopes.get(id), overrides));
  const context = await readinessContext(tenantId, documents, scopes);
  const assessments = scores.map((item) => assess(item, states, context, overrides));

  const exceptions = await db.all<ExceptionRow>(
    "SELECT * FROM compliance_exceptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 201",
    tenantId,
  );
  const policies = await db.all<PolicyRow>(
    "SELECT * FROM policy_register WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 201",
    tenantId,
  );
  const trendRows = await db.all<{
    framework_id: string;
    score: number;
    calculated_at: string;
    readiness: string | null;
    changes_json: string | null;
  }>(
    "SELECT framework_id, score, calculated_at, readiness, changes_json FROM compliance_snapshots WHERE tenant_id = ? ORDER BY calculated_at DESC LIMIT 400",
    tenantId,
  );
  const trend = trendRows.map((row) => ({
    framework_id: row.framework_id,
    score: row.score,
    calculated_at: row.calculated_at,
    readiness: row.readiness,
    changes: row.changes_json
      ? (JSON.parse(row.changes_json) as {
          scoreFrom: number | null;
          scoreTo: number;
          levelFrom: string | null;
          levelTo: string;
          blockers: string[];
          controls: Array<{ code: string; title: string; from: string; to: string }>;
        })
      : null,
  }));
  const now = new Date().toISOString();

  const implementation = new Map(rows.map((row) => [row.uc_code, row]));
  const controls = UNIFIED_CONTROLS.map((control) => {
    const row = implementation.get(control.code);
    const state = states.get(control.code);
    return {
      code: control.code,
      title: control.title,
      domain: control.domain,
      domainLabel: DOMAIN_LABELS[control.domain],
      description: control.description,
      status: row?.status ?? "not_started",
      maturity: row?.maturity ?? 0,
      ownerId: row?.owner_id ?? null,
      linkedControlCode: row?.linked_control_code ?? null,
      notes: row?.notes ?? "",
      source: row?.source ?? "none",
      reviewDue: row?.review_due ?? null,
      attestedBy: row?.updated_by ?? null,
      attestedAt: row?.updated_at ?? null,
      countersignedBy: row?.countersigned_by ?? null,
      attestationExpired: state?.attestationExpired ?? false,
      awaitingCountersignature: state?.awaitingCountersignature ?? false,
      verification: state?.verification ?? "unverified",
      excepted: state?.excepted ?? false,
      weight: state ? controlWeight(state) : 0,
      frameworks: FRAMEWORKS.map((framework) => ({
        frameworkId: framework.id as string,
        requirements: requirementsOf(control.code, framework.id, overrides).length,
      })).filter((entry) => entry.requirements > 0),
    };
  });

  const overall = scores.length ? Math.round((scores.reduce((sum, item) => sum + item.score, 0) / scores.length) * 10) / 10 : 0;
  const contradictions = controls.filter(
    (control) => control.verification === "failing" && ["implemented", "partial"].includes(control.status),
  );
  return {
    generatedAt: now,
    catalog: FRAMEWORKS.map((framework) => ({
      id: framework.id,
      name: framework.name,
      version: framework.version,
      authority: framework.authority,
      kind: framework.kind,
      granularity: framework.granularity,
      sourceUrl: framework.sourceUrl,
      requirements: framework.requirements.length,
      imported: custom.get(framework.id)?.length ?? 0,
    })),
    imports: await listImports(tenantId),
    adoptions: adoptions.map((row) => ({
      frameworkId: row.framework_id,
      scope: row.scope,
      targetDate: row.target_date,
      adoptedAt: row.adopted_at,
    })),
    scores: scores.map((item, index) => summary(item, assessments[index])),
    // Readiness is the weakest framework's, not an average: the organisation is as ready as its least ready scope.
    overall: {
      score: overall,
      readiness: assessments.length ? LEVEL_LABEL[weakestLevel(assessments.map((item) => item.level))!] : "Not assessed",
      frameworks: scores.length,
    },
    controls,
    roadmap: buildRoadmap(adopted, states, scopes, overrides).slice(0, 25),
    mapping: FRAMEWORKS.map((framework) => ({ frameworkId: framework.id, ...mappingStats(framework.id, reviews) })),
    overlap: overlapMatrix(),
    // One more row than shown is read, so a list that was cut says so instead of looking complete.
    truncated: { exceptions: exceptions.length > 200, policies: policies.length > 200 },
    exceptions: exceptions.slice(0, 200).map((row) => ({ ...row, expired: row.status === "approved" && row.expires_at <= now })),
    policies: policies
      .slice(0, 200)
      .map((row) => ({
        ...row,
        ucCodes: JSON.parse(row.uc_codes_json) as string[],
        overdue: row.status === "approved" && row.next_review !== null && row.next_review < now,
      })),
    trend: trend.reverse(),
    evidence: [...documents].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)).slice(0, 300),
    policy: { requireCountersignature: requireCountersignature() },
    alerts: {
      expiredAttestations: controls
        .filter((control) => control.attestationExpired)
        .map((control) => ({ code: control.code, title: control.title, reviewDue: control.reviewDue })),
      expiringAttestations: controls
        .filter(
          (control) =>
            !control.attestationExpired &&
            control.reviewDue !== null &&
            control.reviewDue > now &&
            control.reviewDue < new Date(Date.now() + 30 * DAY).toISOString() &&
            !["not_started", "not_applicable"].includes(control.status),
        )
        .map((control) => ({ code: control.code, title: control.title, reviewDue: control.reviewDue })),
      pendingEvidence: documents.filter((row) => row.status === "pending").length,
      contradictions: contradictions.map((control) => ({
        code: control.code,
        title: control.title,
        attested: control.status,
        linkedControlCode: control.linkedControlCode,
      })),
      pendingExceptions: exceptions.filter((row) => row.status === "pending").length,
      expiredExceptions: exceptions.filter((row) => row.status === "approved" && row.expires_at <= now).length,
      overduePolicies: policies.filter((row) => row.status === "approved" && row.next_review !== null && row.next_review < now).length,
      demoPosture:
        rows.some((row) => row.source === "demo") ||
        adoptions.some((row) => row.source === "demo") ||
        policies.some((row) => row.source === "demo"),
    },
  };
}

export async function frameworkDetail(tenantId: string, frameworkId: FrameworkId) {
  if (!FRAMEWORK_BY_ID.has(frameworkId)) throw userError(`Framework ${frameworkId} not found`);
  const [{ states, documents }, scopes, reviews, custom, licensedText] = await Promise.all([
    loadStates(tenantId),
    loadScope(tenantId),
    loadReviews(tenantId),
    loadCustomRequirements(tenantId),
    loadLicensedText(tenantId, frameworkId),
  ]);
  const overrides = toOverrides(reviews, custom);
  const baseOf = (requirementId: string) =>
    custom.get(frameworkId)?.find((item) => item.id === requirementId)?.controls ?? baseControls(frameworkId, requirementId);
  const score = scoreFramework(frameworkId, states, scopes.get(frameworkId), overrides);
  const assessment = assess(score, states, await readinessContext(tenantId, documents, scopes), overrides);
  const decisions = new Map(
    reviews.filter((row) => row.framework_id === frameworkId).map((row) => [`${row.requirement_id}|${row.uc_code}`, row]),
  );
  return {
    ...score,
    readiness: assessment.label,
    readinessLevel: assessment.level,
    assessment,
    framework: FRAMEWORK_BY_ID.get(frameworkId),
    mapping: mappingStats(frameworkId, reviews),
    requirements: score.requirements.map((requirement) => ({
      ...requirement,
      related: crosswalk(frameworkId, requirement.id, overrides).related.map((entry) => ({
        frameworkId: entry.frameworkId,
        ids: entry.requirements.map((item) => item.id),
      })),
      suggestions: suggestedControls(frameworkId, requirement.id)
        .filter(
          (item) =>
            !decisions.has(`${requirement.id}|${item.ucCode}`) &&
            !mappedControls(frameworkId, requirement.id, overrides).includes(item.ucCode),
        )
        .map((item) => ({ ucCode: item.ucCode, title: UC_BY_CODE.get(item.ucCode)?.title ?? item.ucCode, source: item.source })),
      licensed: licensedText.get(requirement.id) ?? [],
      links: [...new Set([...baseOf(requirement.id), ...mappedControls(frameworkId, requirement.id, overrides)])].map((ucCode) => {
        const review = decisions.get(`${requirement.id}|${ucCode}`);
        const builtIn = baseOf(requirement.id).includes(ucCode);
        return {
          ucCode,
          title: UC_BY_CODE.get(ucCode)?.title ?? ucCode,
          basis: builtIn ? linkBasis(frameworkId, requirement.id, ucCode) : ("tenant" as const),
          source: builtIn ? linkSource(frameworkId, requirement.id, ucCode) : null,
          review: review?.decision ?? null,
          reviewer: review?.reviewer_id ?? null,
          note: review?.note ?? null,
          reviewedAt: review?.reviewed_at ?? null,
        };
      }),
    })),
  };
}

/** Appends a trend point per adopted framework when its score moved since the last snapshot. */
async function recordSnapshots(
  tx: Executor,
  actor: Actor,
  adopted: FrameworkId[],
  states: Map<string, ControlState>,
  context: Awaited<ReturnType<typeof readinessContext>>,
  overrides: MappingOverrides,
  scopes: Map<FrameworkId, NotApplicable>,
  force = false,
) {
  const at = new Date().toISOString();
  // The state of every control the history is about, kept compactly, so the next point can say what changed and why the score moved.
  const snapshotStates = Object.fromEntries(
    [...states].map(([code, state]) => [code, `${state.status}|${state.verification}${state.excepted ? "|excepted" : ""}`]),
  );
  for (const id of adopted) {
    const score = scoreFramework(id, states, scopes.get(id), overrides);
    const assessment = assess(score, states, context, overrides);
    const last = await tx.get<{ score: number; readiness: string | null; states_json: string | null }>(
      "SELECT score, readiness, states_json FROM compliance_snapshots WHERE tenant_id = ? AND framework_id = ? ORDER BY calculated_at DESC LIMIT 1",
      actor.tenantId,
      id,
    );
    const previousStates = last?.states_json ? (JSON.parse(last.states_json) as Record<string, string>) : {};
    const controls = Object.keys({ ...previousStates, ...snapshotStates })
      .filter((code) => previousStates[code] !== snapshotStates[code])
      .slice(0, 60)
      .map((code) => ({
        code,
        title: UC_BY_CODE.get(code)?.title ?? code,
        from: previousStates[code] ?? "not recorded",
        to: snapshotStates[code] ?? "removed",
      }));
    const levelChanged = Boolean(last) && last!.readiness !== assessment.level;
    const scoreMoved = !last || Math.abs(last.score - score.score) >= 0.05;
    if (!force && last && !scoreMoved && !levelChanged && controls.length === 0) continue;
    const changes = {
      scoreFrom: last?.score ?? null,
      scoreTo: score.score,
      levelFrom: last?.readiness ?? null,
      levelTo: assessment.level,
      blockers: assessment.blockers,
      controls,
    };
    await tx.run(
      "INSERT INTO compliance_snapshots (id,tenant_id,framework_id,score,verified_share,compliant,gaps,calculated_at,readiness,states_json,changes_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      `snap_${randomUUID()}`,
      actor.tenantId,
      id,
      score.score,
      score.verifiedShare,
      score.compliant,
      score.gaps,
      at,
      assessment.level,
      JSON.stringify(snapshotStates),
      JSON.stringify(changes),
    );
  }
}

export async function refreshSnapshots(actor: Actor, force = false) {
  const [{ states, documents }, scopes, adoptions, overrides] = await Promise.all([
    loadStates(actor.tenantId),
    loadScope(actor.tenantId),
    adoptedIds(actor.tenantId),
    loadOverrides(actor.tenantId),
  ]);
  // Everything that needs a read is gathered before the transaction opens: on SQLite a statement outside it waits for it to end.
  const context = await readinessContext(actor.tenantId, documents, scopes);
  await (
    await scope(actor.tenantId)
  ).transaction((tx) =>
    recordSnapshots(
      tx,
      actor,
      adoptions.map((row) => row.framework_id),
      states,
      context,
      overrides,
      scopes,
      force,
    ),
  );
}

/** Records a trend point when a score moved, for changes made outside this module (for example a licensed-content import). */
export async function refreshComplianceTrend(actor: Actor) {
  await refreshSnapshots(actor);
}

export async function recordComplianceSnapshot(actor: Actor) {
  await refreshSnapshots(actor, true);
  return complianceSnapshot(actor.tenantId);
}
