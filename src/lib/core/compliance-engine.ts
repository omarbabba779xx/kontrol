import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { userError } from "@/lib/core/errors";
import { appendAudit, sha256 } from "@/lib/core/integrity";
import { getDb } from "@/lib/db";
import type { Executor } from "@/lib/db";
import { FRAMEWORKS, FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { SUGGESTED_LINKS } from "@/lib/connectors/pack";
import { storeVaultDocument } from "@/lib/core/enterprise-engine";
import { listImports, loadCustomRequirements, loadLicensedText } from "@/lib/core/licensed-content";
import { allLinks, allSuggestions, baseControls, linkBasis, linkKey, linkSource, suggestedControls } from "@/lib/frameworks/mapping";
import { buildRoadmap, controlWeight, crosswalk, isBacked, mappedControls, overlapMatrix, readinessLabel, requirementsOf, scoreFramework, type ControlState, type MappingOverrides, type NotApplicable, type Verification } from "@/lib/frameworks/scoring";
import { DOMAIN_LABELS, UNIFIED_CONTROLS, UC_BY_CODE } from "@/lib/frameworks/unified";
import type { FrameworkId, ImplementationStatus } from "@/lib/frameworks/types";

const MAX_EXCEPTION_DAYS = 365;
const DAY = 86_400_000;

type ImplementationRow = { uc_code: string; status: ImplementationStatus; maturity: number; owner_id: string | null; linked_control_code: string | null; notes: string; source: string; review_due: string | null; updated_by: string; updated_at: string; countersigned_by: string | null; countersigned_at: string | null };
type ExceptionRow = { id: string; uc_code: string; title: string; justification: string; compensating_controls: string; risk_level: string; requested_by: string; approved_by: string | null; status: string; expires_at: string; created_at: string; decided_at: string | null; decision_note: string | null };
type PolicyRow = { id: string; title: string; version: string; owner_id: string | null; status: string; approved_at: string | null; next_review: string | null; uc_codes_json: string; document_hash: string | null; updated_at: string; source: string };

const scope = async (tenantId: string) => (await getDb()).scope(tenantId);

async function singleVerification(db: Executor, tenantId: string, controlCode: string): Promise<Verification> {
  const latest = await db.get<{ status: string; expires_at: string | null }>(
    "SELECT e.status, e.expires_at FROM evidence e JOIN controls c ON c.id = e.control_id WHERE e.tenant_id = ? AND c.code = ? AND c.valid_to IS NULL ORDER BY e.collected_at DESC LIMIT 1",
    tenantId, controlCode);
  if (!latest) return "unverified";
  if (latest.status === "failed") return "failing";
  if (latest.expires_at && latest.expires_at < new Date().toISOString()) return "stale";
  return "verified";
}

/** A unified control may be backed by several executable controls (comma-separated codes). One failing control fails the lot. */
export function linkedCodes(value: string | null | undefined) {
  return [...new Set((value ?? "").split(",").map((code) => code.trim()).filter(Boolean))];
}

async function evidenceVerification(db: Executor, tenantId: string, linked: string | null): Promise<Verification> {
  const codes = linkedCodes(linked);
  if (!codes.length) return "unverified";
  const results = await Promise.all(codes.map((code) => singleVerification(db, tenantId, code)));
  if (results.includes("failing")) return "failing";
  if (results.includes("stale")) return "stale";
  return results.every((result) => result === "verified") ? "verified" : "unverified";
}

type EvidenceRow = { id: string; uc_code: string; title: string; kind: string; vault_document_id: string | null; content_hash: string; note: string; valid_until: string; uploaded_by: string; uploaded_at: string; status: "pending" | "accepted" | "rejected"; reviewed_by: string | null; reviewed_at: string | null; review_note: string | null };

const requireCountersignature = () => process.env.KONTROL_REQUIRE_COUNTERSIGN === "true";
const REVIEW_DAYS: Partial<Record<ImplementationStatus, number>> = { implemented: 365, partial: 180, planned: 90 };

/** Machine evidence wins over documents; documents back a claim only while an accepted one is still valid. */
function combineVerification(machine: Verification, documents: EvidenceRow[], now: string): Verification {
  if (machine === "failing" || machine === "verified") return machine;
  const accepted = documents.filter((row) => row.status === "accepted");
  if (accepted.some((row) => row.valid_until > now)) return "documented";
  return machine === "stale" || accepted.length > 0 ? "stale" : "unverified";
}

/** Merges attested implementation, machine and documentary evidence, expiry and approved risk acceptances into one state per unified control. */
async function loadStates(tenantId: string) {
  const db = await scope(tenantId);
  const rows = await db.all<ImplementationRow>("SELECT * FROM control_implementations WHERE tenant_id = ?", tenantId);
  const documents = await db.all<EvidenceRow>("SELECT * FROM control_evidence WHERE tenant_id = ?", tenantId);
  const now = new Date().toISOString();
  const excepted = new Set((await db.all<{ uc_code: string }>("SELECT uc_code FROM compliance_exceptions WHERE tenant_id = ? AND status = 'approved' AND expires_at > ?", tenantId, now)).map((row) => row.uc_code));
  const states = new Map<string, ControlState>();
  for (const row of rows) {
    const verification = combineVerification(await evidenceVerification(db, tenantId, row.linked_control_code), documents.filter((item) => item.uc_code === row.uc_code), now);
    const claimed = row.status === "implemented" || row.status === "partial";
    states.set(row.uc_code, {
      status: row.status, maturity: row.maturity, verification, excepted: excepted.has(row.uc_code),
      attestationExpired: claimed && row.review_due !== null && row.review_due < now && !isBacked(verification),
      awaitingCountersignature: requireCountersignature() && row.status === "implemented" && !row.countersigned_by && !isBacked(verification),
    });
  }
  return { states, rows, documents };
}

async function loadScope(tenantId: string) {
  const rows = await (await scope(tenantId)).all<{ framework_id: FrameworkId; requirement_id: string; justification: string }>("SELECT framework_id, requirement_id, justification FROM requirement_scope WHERE tenant_id = ?", tenantId);
  const byFramework = new Map<FrameworkId, NotApplicable>();
  for (const row of rows) {
    const map = byFramework.get(row.framework_id) ?? new Map<string, string>();
    map.set(row.requirement_id, row.justification);
    byFramework.set(row.framework_id, map);
  }
  return byFramework;
}

type ReviewRow = { framework_id: FrameworkId; requirement_id: string; uc_code: string; decision: "validated" | "rejected" | "added"; note: string; reviewer_id: string; reviewed_at: string };

async function loadReviews(tenantId: string) {
  return (await scope(tenantId)).all<ReviewRow>("SELECT framework_id, requirement_id, uc_code, decision, note, reviewer_id, reviewed_at FROM mapping_reviews WHERE tenant_id = ?", tenantId);
}

function toOverrides(rows: ReviewRow[], custom?: MappingOverrides["custom"]): MappingOverrides {
  const overrides: MappingOverrides = { rejected: new Set(), added: new Map(), custom };
  for (const row of rows) {
    if (row.decision === "rejected") overrides.rejected.add(linkKey(row.framework_id, row.requirement_id, row.uc_code));
    if (row.decision === "added") {
      const key = `${row.framework_id}|${row.requirement_id}`;
      overrides.added.set(key, [...(overrides.added.get(key) ?? []), row.uc_code]);
    }
  }
  return overrides;
}

async function loadOverrides(tenantId: string) {
  return toOverrides(await loadReviews(tenantId), await loadCustomRequirements(tenantId));
}

/** Review coverage of the built-in crosswalk for one framework. */
function mappingStats(frameworkId: FrameworkId, reviews: ReviewRow[]) {
  const links = allLinks().filter((link) => link.frameworkId === frameworkId);
  const mine = reviews.filter((row) => row.framework_id === frameworkId);
  const decided = new Set(mine.filter((row) => row.decision !== "added").map((row) => `${row.requirement_id}|${row.uc_code}`));
  return {
    links: links.length,
    published: links.filter((link) => link.basis === "published").length,
    validated: mine.filter((row) => row.decision === "validated").length,
    rejected: mine.filter((row) => row.decision === "rejected").length,
    added: mine.filter((row) => row.decision === "added").length,
    suggested: allSuggestions().filter((item) => item.frameworkId === frameworkId && !mine.some((row) => row.requirement_id === item.requirementId && row.uc_code === item.ucCode)).length,
    reviewedShare: links.length ? Math.round((links.filter((link) => decided.has(`${link.requirementId}|${link.ucCode}`) || link.basis === "published").length / links.length) * 1000) / 10 : 0,
  };
}

async function adoptedIds(tenantId: string) {
  return (await (await scope(tenantId)).all<{ framework_id: FrameworkId; scope: string; target_date: string | null; adopted_at: string; source: string }>("SELECT framework_id, scope, target_date, adopted_at, source FROM framework_adoptions WHERE tenant_id = ? ORDER BY adopted_at", tenantId));
}

function summary(score: ReturnType<typeof scoreFramework>) {
  return { frameworkId: score.frameworkId, score: score.score, verifiedShare: score.verifiedShare, applicable: score.applicable, compliant: score.compliant, partial: score.partial, gaps: score.gaps, notApplicable: score.notApplicable, readiness: score.readiness, groups: score.groups };
}

export async function complianceSnapshot(tenantId: string) {
  const db = await scope(tenantId);
  const [{ states, rows, documents }, scopes, adoptions, reviews, custom] = await Promise.all([loadStates(tenantId), loadScope(tenantId), adoptedIds(tenantId), loadReviews(tenantId), loadCustomRequirements(tenantId)]);
  const overrides = toOverrides(reviews, custom);
  const adopted = adoptions.map((row) => row.framework_id);
  const scores = adopted.map((id) => scoreFramework(id, states, scopes.get(id), overrides));

  const exceptions = await db.all<ExceptionRow>("SELECT * FROM compliance_exceptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200", tenantId);
  const policies = await db.all<PolicyRow>("SELECT * FROM policy_register WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 200", tenantId);
  const trend = await db.all<{ framework_id: string; score: number; calculated_at: string }>("SELECT framework_id, score, calculated_at FROM compliance_snapshots WHERE tenant_id = ? ORDER BY calculated_at DESC LIMIT 400", tenantId);
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
      frameworks: FRAMEWORKS.map((framework) => ({ frameworkId: framework.id as string, requirements: requirementsOf(control.code, framework.id, overrides).length })).filter((entry) => entry.requirements > 0),
    };
  });

  const overall = scores.length ? Math.round((scores.reduce((sum, item) => sum + item.score, 0) / scores.length) * 10) / 10 : 0;
  const contradictions = controls.filter((control) => control.verification === "failing" && ["implemented", "partial"].includes(control.status));
  return {
    generatedAt: now,
    catalog: FRAMEWORKS.map((framework) => ({ id: framework.id, name: framework.name, version: framework.version, authority: framework.authority, kind: framework.kind, granularity: framework.granularity, sourceUrl: framework.sourceUrl, requirements: framework.requirements.length, imported: custom.get(framework.id)?.length ?? 0 })),
    imports: await listImports(tenantId),
    adoptions: adoptions.map((row) => ({ frameworkId: row.framework_id, scope: row.scope, targetDate: row.target_date, adoptedAt: row.adopted_at })),
    scores: scores.map(summary),
    overall: { score: overall, readiness: readinessLabel(overall), frameworks: scores.length },
    controls,
    roadmap: buildRoadmap(adopted, states, scopes, overrides).slice(0, 25),
    mapping: FRAMEWORKS.map((framework) => ({ frameworkId: framework.id, ...mappingStats(framework.id, reviews) })),
    overlap: overlapMatrix(),
    exceptions: exceptions.map((row) => ({ ...row, expired: row.status === "approved" && row.expires_at <= now })),
    policies: policies.map((row) => ({ ...row, ucCodes: JSON.parse(row.uc_codes_json) as string[], overdue: row.status === "approved" && row.next_review !== null && row.next_review < now })),
    trend: trend.reverse(),
    evidence: [...documents].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)).slice(0, 300),
    policy: { requireCountersignature: requireCountersignature() },
    alerts: {
      expiredAttestations: controls.filter((control) => control.attestationExpired).map((control) => ({ code: control.code, title: control.title, reviewDue: control.reviewDue })),
      expiringAttestations: controls.filter((control) => !control.attestationExpired && control.reviewDue !== null && control.reviewDue > now && control.reviewDue < new Date(Date.now() + 30 * DAY).toISOString() && !["not_started", "not_applicable"].includes(control.status)).map((control) => ({ code: control.code, title: control.title, reviewDue: control.reviewDue })),
      pendingEvidence: documents.filter((row) => row.status === "pending").length,
      contradictions: contradictions.map((control) => ({ code: control.code, title: control.title, attested: control.status, linkedControlCode: control.linkedControlCode })),
      pendingExceptions: exceptions.filter((row) => row.status === "pending").length,
      expiredExceptions: exceptions.filter((row) => row.status === "approved" && row.expires_at <= now).length,
      overduePolicies: policies.filter((row) => row.status === "approved" && row.next_review !== null && row.next_review < now).length,
      demoPosture: rows.some((row) => row.source === "demo") || adoptions.some((row) => row.source === "demo") || policies.some((row) => row.source === "demo"),
    },
  };
}

export async function frameworkDetail(tenantId: string, frameworkId: FrameworkId) {
  if (!FRAMEWORK_BY_ID.has(frameworkId)) throw userError(`Framework ${frameworkId} not found`);
  const [{ states }, scopes, reviews, custom, licensedText] = await Promise.all([loadStates(tenantId), loadScope(tenantId), loadReviews(tenantId), loadCustomRequirements(tenantId), loadLicensedText(tenantId, frameworkId)]);
  const overrides = toOverrides(reviews, custom);
  const baseOf = (requirementId: string) => custom.get(frameworkId)?.find((item) => item.id === requirementId)?.controls ?? baseControls(frameworkId, requirementId);
  const score = scoreFramework(frameworkId, states, scopes.get(frameworkId), overrides);
  const decisions = new Map(reviews.filter((row) => row.framework_id === frameworkId).map((row) => [`${row.requirement_id}|${row.uc_code}`, row]));
  return {
    ...score,
    framework: FRAMEWORK_BY_ID.get(frameworkId),
    mapping: mappingStats(frameworkId, reviews),
    requirements: score.requirements.map((requirement) => ({
      ...requirement,
      related: crosswalk(frameworkId, requirement.id, overrides).related.map((entry) => ({ frameworkId: entry.frameworkId, ids: entry.requirements.map((item) => item.id) })),
      suggestions: suggestedControls(frameworkId, requirement.id)
        .filter((item) => !decisions.has(`${requirement.id}|${item.ucCode}`) && !mappedControls(frameworkId, requirement.id, overrides).includes(item.ucCode))
        .map((item) => ({ ucCode: item.ucCode, title: UC_BY_CODE.get(item.ucCode)?.title ?? item.ucCode, source: item.source })),
      licensed: licensedText.get(requirement.id) ?? [],
      links: [...new Set([...baseOf(requirement.id), ...mappedControls(frameworkId, requirement.id, overrides)])].map((ucCode) => {
        const review = decisions.get(`${requirement.id}|${ucCode}`);
        const builtIn = baseOf(requirement.id).includes(ucCode);
        return { ucCode, title: UC_BY_CODE.get(ucCode)?.title ?? ucCode, basis: builtIn ? linkBasis(frameworkId, requirement.id, ucCode) : ("tenant" as const), source: builtIn ? linkSource(frameworkId, requirement.id, ucCode) : null, review: review?.decision ?? null, reviewer: review?.reviewer_id ?? null, note: review?.note ?? null, reviewedAt: review?.reviewed_at ?? null };
      }),
    })),
  };
}

/** Appends a trend point per adopted framework when its score moved since the last snapshot. */
async function recordSnapshots(tx: Executor, actor: Actor, adopted: FrameworkId[], states: Map<string, ControlState>, scopes: Map<FrameworkId, NotApplicable>, overrides: MappingOverrides, force = false) {
  const at = new Date().toISOString();
  for (const id of adopted) {
    const score = scoreFramework(id, states, scopes.get(id), overrides);
    const last = await tx.get<{ score: number }>("SELECT score FROM compliance_snapshots WHERE tenant_id = ? AND framework_id = ? ORDER BY calculated_at DESC LIMIT 1", actor.tenantId, id);
    if (!force && last && Math.abs(last.score - score.score) < 0.05) continue;
    await tx.run("INSERT INTO compliance_snapshots (id,tenant_id,framework_id,score,verified_share,compliant,gaps,calculated_at) VALUES (?,?,?,?,?,?,?,?)", `snap_${randomUUID()}`, actor.tenantId, id, score.score, score.verifiedShare, score.compliant, score.gaps, at);
  }
}

async function refreshSnapshots(actor: Actor, force = false) {
  const [{ states }, scopes, adoptions, overrides] = await Promise.all([loadStates(actor.tenantId), loadScope(actor.tenantId), adoptedIds(actor.tenantId), loadOverrides(actor.tenantId)]);
  await (await scope(actor.tenantId)).transaction((tx) => recordSnapshots(tx, actor, adoptions.map((row) => row.framework_id), states, scopes, overrides, force));
}

/** Records a trend point when a score moved, for changes made outside this module (for example a licensed-content import). */
export async function refreshComplianceTrend(actor: Actor) {
  await refreshSnapshots(actor);
}

export async function recordComplianceSnapshot(actor: Actor) {
  await refreshSnapshots(actor, true);
  return complianceSnapshot(actor.tenantId);
}

export async function adoptFramework(actor: Actor, input: { frameworkId: FrameworkId; scope: string; targetDate?: string }) {
  if (!FRAMEWORK_BY_ID.has(input.frameworkId)) throw userError(`Framework ${input.frameworkId} not found`);
  const db = await scope(actor.tenantId);
  const at = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run(`INSERT INTO framework_adoptions (id,tenant_id,framework_id,scope,target_date,adopted_by,adopted_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, framework_id) DO UPDATE SET scope = excluded.scope, target_date = excluded.target_date, source = 'attested'`, `adopt_${randomUUID()}`, actor.tenantId, input.frameworkId, input.scope, input.targetDate ?? null, actor.userId, at);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.framework_adopted", objectType: "framework", objectId: input.frameworkId, payload: { scope: input.scope, targetDate: input.targetDate ?? null } }, tx);
  });
  await refreshSnapshots(actor);
  return { frameworkId: input.frameworkId };
}

export async function setImplementation(actor: Actor, input: { ucCode: string; status: ImplementationStatus; maturity: number; ownerId?: string; linkedControlCode?: string; notes: string; reviewDue?: string }) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const db = await scope(actor.tenantId);
  const linkedList = linkedCodes(input.linkedControlCode);
  for (const code of linkedList) {
    const linked = await db.get("SELECT id FROM controls WHERE tenant_id = ? AND code = ? AND valid_to IS NULL", actor.tenantId, code);
    if (!linked) throw userError(`Control ${code} not found`);
  }
  const linkedValue = linkedList.length ? linkedList.join(",") : null;
  if (input.ownerId) {
    const owner = await db.get("SELECT id FROM users WHERE tenant_id = ? AND id = ?", actor.tenantId, input.ownerId);
    if (!owner) throw userError(`User ${input.ownerId} not found`);
  }
  const at = new Date().toISOString();
  const reviewDays = REVIEW_DAYS[input.status];
  const reviewDue = input.reviewDue ?? (reviewDays ? new Date(Date.now() + reviewDays * DAY).toISOString() : null);
  const previous = await db.get<{ status: string }>("SELECT status FROM control_implementations WHERE tenant_id = ? AND uc_code = ?", actor.tenantId, input.ucCode);
  await db.transaction(async (tx) => {
    await tx.run(`INSERT INTO control_implementations (id,tenant_id,uc_code,status,maturity,owner_id,linked_control_code,notes,source,review_due,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, uc_code) DO UPDATE SET status = excluded.status, maturity = excluded.maturity, owner_id = excluded.owner_id, linked_control_code = excluded.linked_control_code, notes = excluded.notes, source = excluded.source, review_due = excluded.review_due, updated_by = excluded.updated_by, updated_at = excluded.updated_at, countersigned_by = NULL, countersigned_at = NULL`,
      `impl_${randomUUID()}`, actor.tenantId, input.ucCode, input.status, input.maturity, input.ownerId ?? null, linkedValue, input.notes, "attested", reviewDue, actor.userId, at);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.implementation_updated", objectType: "unified_control", objectId: input.ucCode, payload: { from: previous?.status ?? "not_started", to: input.status, maturity: input.maturity, linkedControlCode: linkedValue } }, tx);
  });
  await refreshSnapshots(actor);
  return { ucCode: input.ucCode, status: input.status };
}

/**
 * Links unified controls to the executable controls that provide machine evidence for them. Only controls that
 * exist in this tenant are linked, existing links are kept, and attested statuses are never changed: evidence verifies a
 * claim, it does not make one.
 */
export async function linkEvidence(actor: Actor) {
  const db = await scope(actor.tenantId);
  const existing = new Set((await db.all<{ code: string }>("SELECT code FROM controls WHERE tenant_id = ? AND valid_to IS NULL", actor.tenantId)).map((row) => row.code));
  const at = new Date().toISOString();
  const linked: Array<{ ucCode: string; controls: string[] }> = [];
  await db.transaction(async (tx) => {
    for (const [ucCode, suggested] of Object.entries(SUGGESTED_LINKS)) {
      const available = suggested.filter((code) => existing.has(code));
      if (!available.length) continue;
      const row = await tx.get<{ linked_control_code: string | null }>("SELECT linked_control_code FROM control_implementations WHERE tenant_id = ? AND uc_code = ?", actor.tenantId, ucCode);
      const merged = [...new Set([...linkedCodes(row?.linked_control_code), ...available])];
      if (row && merged.join(",") === linkedCodes(row.linked_control_code).join(",")) continue;
      if (row) await tx.run("UPDATE control_implementations SET linked_control_code = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND uc_code = ?", merged.join(","), actor.userId, at, actor.tenantId, ucCode);
      else await tx.run(`INSERT INTO control_implementations (id,tenant_id,uc_code,status,maturity,owner_id,linked_control_code,notes,source,review_due,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        `impl_${randomUUID()}`, actor.tenantId, ucCode, "not_started", 0, null, merged.join(","), "Evidence linked; implementation not yet attested", "attested", null, actor.userId, at);
      linked.push({ ucCode, controls: merged });
    }
    if (linked.length) await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.evidence_linked", objectType: "tenant", objectId: actor.tenantId, payload: { linked } }, tx);
  });
  await refreshSnapshots(actor);
  return { linked };
}

/** Renews an attestation without changing it: the owner confirms the claim still holds. Restarts the review clock and clears the countersignature. */
export async function reattest(actor: Actor, input: { ucCode: string; note: string }) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const db = await scope(actor.tenantId);
  const row = await db.get<{ status: ImplementationStatus }>("SELECT status FROM control_implementations WHERE tenant_id = ? AND uc_code = ?", actor.tenantId, input.ucCode);
  const days = row ? REVIEW_DAYS[row.status] : undefined;
  if (!row || !days) throw userError("Only an implemented, partial or planned control can be re-attested");
  const at = new Date().toISOString();
  const reviewDue = new Date(Date.now() + days * DAY).toISOString();
  await db.transaction(async (tx) => {
    await tx.run("UPDATE control_implementations SET review_due = ?, updated_by = ?, updated_at = ?, countersigned_by = NULL, countersigned_at = NULL WHERE tenant_id = ? AND uc_code = ?", reviewDue, actor.userId, at, actor.tenantId, input.ucCode);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.attestation_renewed", objectType: "unified_control", objectId: input.ucCode, payload: { note: input.note, status: row.status } }, tx);
  });
  await refreshSnapshots(actor);
  return { ucCode: input.ucCode, reviewDue };
}

/** A second person confirms the current attestation. The person who made it cannot. Changing the attestation clears the countersignature. */
export async function countersign(actor: Actor, input: { ucCode: string; note: string }) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const db = await scope(actor.tenantId);
  const row = await db.get<{ status: ImplementationStatus; updated_by: string; countersigned_by: string | null }>("SELECT status, updated_by, countersigned_by FROM control_implementations WHERE tenant_id = ? AND uc_code = ?", actor.tenantId, input.ucCode);
  if (!row || (row.status !== "implemented" && row.status !== "partial")) throw userError("Only an implemented or partial attestation can be countersigned");
  if (row.updated_by === actor.userId) throw userError("Separation of duties: the person who made the attestation cannot countersign it");
  await db.transaction(async (tx) => {
    const result = await tx.run("UPDATE control_implementations SET countersigned_by = ?, countersigned_at = ? WHERE tenant_id = ? AND uc_code = ? AND updated_by = ?", actor.userId, new Date().toISOString(), actor.tenantId, input.ucCode, row.updated_by);
    if (result.changes !== 1) throw userError("The attestation changed while you were reviewing it; review it again");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.attestation_countersigned", objectType: "unified_control", objectId: input.ucCode, payload: { note: input.note, attestedBy: row.updated_by } }, tx);
  });
  await refreshSnapshots(actor);
  return { ucCode: input.ucCode, countersignedBy: actor.userId };
}

const MAX_EVIDENCE_DAYS = 730;

/** Stores a document in the evidence vault (hashed, signed, versioned) and files it against a unified control, pending review. */
export async function attachEvidence(actor: Actor, input: { ucCode: string; title: string; kind: "document" | "record" | "report" | "certificate"; validUntil: string; note: string; file: File }) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const until = Date.parse(input.validUntil);
  if (!(until > Date.now())) throw userError("Evidence must be valid until a future date");
  if (until - Date.now() > MAX_EVIDENCE_DAYS * DAY) throw userError(`Evidence cannot be declared valid for more than ${MAX_EVIDENCE_DAYS} days`);
  const stored = await storeVaultDocument(actor, input.file, `control-evidence:${input.kind}`);
  const id = `cev_${randomUUID()}`;
  const db = await scope(actor.tenantId);
  await db.transaction(async (tx) => {
    await tx.run(`INSERT INTO control_evidence (id,tenant_id,uc_code,title,kind,vault_document_id,content_hash,note,valid_until,uploaded_by,uploaded_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, actor.tenantId, input.ucCode, input.title, input.kind, stored.id, stored.hash, input.note, new Date(until).toISOString(), actor.userId, new Date().toISOString(), "pending");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.evidence_attached", objectType: "control_evidence", objectId: id, payload: { ucCode: input.ucCode, hash: stored.hash, kind: input.kind, vaultDocumentId: stored.id } }, tx);
  });
  return { id, status: "pending", hash: stored.hash, duplicateDocument: stored.duplicate };
}

/** Accepting evidence makes the control "documented" while it is valid. The reviewer cannot be the uploader, and a decision is final. */
export async function reviewEvidence(actor: Actor, input: { id: string; accept: boolean; note: string }) {
  const db = await scope(actor.tenantId);
  const row = await db.get<EvidenceRow>("SELECT * FROM control_evidence WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
  if (!row) throw userError("Evidence not found");
  if (row.uploaded_by === actor.userId) throw userError("Separation of duties: the person who uploaded the evidence cannot review it");
  const status = input.accept ? "accepted" : "rejected";
  await db.transaction(async (tx) => {
    const result = await tx.run("UPDATE control_evidence SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE tenant_id = ? AND id = ? AND status = 'pending'", status, actor.userId, new Date().toISOString(), input.note, actor.tenantId, input.id);
    if (result.changes !== 1) throw userError("Evidence has already been reviewed");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: `compliance.evidence_${status}`, objectType: "control_evidence", objectId: input.id, payload: { ucCode: row.uc_code, hash: row.content_hash, note: input.note } }, tx);
  });
  await refreshSnapshots(actor);
  return { id: input.id, status };
}

export async function setRequirementScope(actor: Actor, input: { frameworkId: FrameworkId; requirementId: string; applicable: boolean; justification?: string }) {
  const framework = FRAMEWORK_BY_ID.get(input.frameworkId);
  const imported = (await loadCustomRequirements(actor.tenantId)).get(input.frameworkId)?.some((item) => item.id === input.requirementId);
  if (!imported && !framework?.requirements.some((requirement) => requirement.id === input.requirementId)) throw userError(`Requirement ${input.requirementId} not found`);
  if (!input.applicable && (input.justification ?? "").trim().length < 15) throw userError("A justification of at least 15 characters is required to exclude a requirement");
  const db = await scope(actor.tenantId);
  await db.transaction(async (tx) => {
    if (input.applicable) await tx.run("DELETE FROM requirement_scope WHERE tenant_id = ? AND framework_id = ? AND requirement_id = ?", actor.tenantId, input.frameworkId, input.requirementId);
    else await tx.run(`INSERT INTO requirement_scope (id,tenant_id,framework_id,requirement_id,justification,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, framework_id, requirement_id) DO UPDATE SET justification = excluded.justification, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      `scope_${randomUUID()}`, actor.tenantId, input.frameworkId, input.requirementId, input.justification!.trim(), actor.userId, new Date().toISOString());
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: input.applicable ? "compliance.requirement_included" : "compliance.requirement_excluded", objectType: "requirement", objectId: `${input.frameworkId}:${input.requirementId}`, payload: { justification: input.justification ?? null } }, tx);
  });
  await refreshSnapshots(actor);
  return { frameworkId: input.frameworkId, requirementId: input.requirementId, applicable: input.applicable };
}

export async function requestException(actor: Actor, input: { ucCode: string; title: string; justification: string; compensatingControls: string; riskLevel: "low" | "medium" | "high" | "critical"; expiresAt: string }) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const expires = Date.parse(input.expiresAt);
  const now = Date.now();
  if (!(expires > now)) throw userError("An exception must expire in the future");
  if (expires - now > MAX_EXCEPTION_DAYS * DAY) throw userError(`An exception cannot last longer than ${MAX_EXCEPTION_DAYS} days; re-approve it instead`);
  const id = `exc_${randomUUID()}`;
  const at = new Date().toISOString();
  await (await scope(actor.tenantId)).transaction(async (tx) => {
    await tx.run(`INSERT INTO compliance_exceptions (id,tenant_id,uc_code,title,justification,compensating_controls,risk_level,requested_by,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id, actor.tenantId, input.ucCode, input.title, input.justification, input.compensatingControls, input.riskLevel, actor.userId, "pending", new Date(expires).toISOString(), at);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.exception_requested", objectType: "exception", objectId: id, payload: { ucCode: input.ucCode, riskLevel: input.riskLevel, expiresAt: input.expiresAt } }, tx);
  });
  return { id, status: "pending" };
}

export async function decideException(actor: Actor, input: { id: string; approve: boolean; note: string }) {
  const db = await scope(actor.tenantId);
  const row = await db.get<ExceptionRow>("SELECT * FROM compliance_exceptions WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
  if (!row) throw userError("Exception not found");
  if (row.requested_by === actor.userId) throw userError("Separation of duties: the requester cannot decide their own exception");
  const status = input.approve ? "approved" : "rejected";
  await db.transaction(async (tx) => {
    // The status guard makes a decision single-use even under concurrent approvals.
    const result = await tx.run("UPDATE compliance_exceptions SET status = ?, approved_by = ?, decided_at = ?, decision_note = ?, source = 'attested' WHERE tenant_id = ? AND id = ? AND status = 'pending'", status, actor.userId, new Date().toISOString(), input.note, actor.tenantId, input.id);
    if (result.changes !== 1) throw userError("Exception has already been decided");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: `compliance.exception_${status}`, objectType: "exception", objectId: input.id, payload: { ucCode: row.uc_code, note: input.note } }, tx);
  });
  return { id: input.id, status };
}

export async function upsertPolicy(actor: Actor, input: { id?: string; title: string; version: string; status: "draft" | "in_review" | "approved" | "retired"; ownerId?: string; nextReview?: string; ucCodes: string[]; content?: string }) {
  for (const code of input.ucCodes) if (!UC_BY_CODE.has(code)) throw userError(`Unified control ${code} not found`);
  const db = await scope(actor.tenantId);
  const at = new Date().toISOString();
  const id = input.id ?? `pol_${randomUUID()}`;
  const hash = input.content ? sha256(input.content) : null;
  if (input.id) {
    const existing = await db.get("SELECT id FROM policy_register WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
    if (!existing) throw userError("Policy not found");
  }
  await db.transaction(async (tx) => {
    await tx.run(`INSERT INTO policy_register (id,tenant_id,title,version,owner_id,status,approved_at,next_review,uc_codes_json,document_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, version = excluded.version, owner_id = excluded.owner_id, status = excluded.status, approved_at = COALESCE(excluded.approved_at, policy_register.approved_at), next_review = excluded.next_review, uc_codes_json = excluded.uc_codes_json, document_hash = COALESCE(excluded.document_hash, policy_register.document_hash), updated_at = excluded.updated_at, source = 'attested'`,
      id, actor.tenantId, input.title, input.version, input.ownerId ?? null, input.status, input.status === "approved" ? at : null, input.nextReview ?? null, JSON.stringify(input.ucCodes), hash, at, at);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.policy_saved", objectType: "policy", objectId: id, payload: { title: input.title, version: input.version, status: input.status, documentHash: hash } }, tx);
  });
  return { id };
}

/** Records a reviewer's decision on a crosswalk link. `reset` returns it to the built-in state. */
export async function reviewMapping(actor: Actor, input: { frameworkId: FrameworkId; requirementId: string; ucCode: string; decision: "validated" | "rejected" | "added" | "reset"; note?: string }) {
  const framework = FRAMEWORK_BY_ID.get(input.frameworkId);
  const imported = (await loadCustomRequirements(actor.tenantId)).get(input.frameworkId)?.find((item) => item.id === input.requirementId);
  if (!imported && !framework?.requirements.some((requirement) => requirement.id === input.requirementId)) throw userError(`Requirement ${input.requirementId} not found`);
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const builtIn = (imported?.controls ?? baseControls(input.frameworkId, input.requirementId)).includes(input.ucCode);
  if (input.decision === "added" && builtIn) throw userError("This link already exists in the built-in crosswalk");
  if ((input.decision === "validated" || input.decision === "rejected") && !builtIn) throw userError("Only links of the built-in crosswalk can be validated or rejected; remove an added link with reset");
  if (input.decision !== "reset" && (input.note ?? "").trim().length < 10) throw userError("A review note of at least 10 characters is required");
  const db = await scope(actor.tenantId);
  await db.transaction(async (tx) => {
    if (input.decision === "reset") await tx.run("DELETE FROM mapping_reviews WHERE tenant_id = ? AND framework_id = ? AND requirement_id = ? AND uc_code = ?", actor.tenantId, input.frameworkId, input.requirementId, input.ucCode);
    else await tx.run(`INSERT INTO mapping_reviews (id,tenant_id,framework_id,requirement_id,uc_code,decision,note,reviewer_id,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, framework_id, requirement_id, uc_code) DO UPDATE SET decision = excluded.decision, note = excluded.note, reviewer_id = excluded.reviewer_id, reviewed_at = excluded.reviewed_at`,
      `map_${randomUUID()}`, actor.tenantId, input.frameworkId, input.requirementId, input.ucCode, input.decision, input.note!.trim(), actor.userId, new Date().toISOString());
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: `compliance.mapping_${input.decision}`, objectType: "mapping", objectId: linkKey(input.frameworkId, input.requirementId, input.ucCode), payload: { basis: builtIn ? linkBasis(input.frameworkId, input.requirementId, input.ucCode) : "tenant", note: input.note ?? null } }, tx);
  });
  await refreshSnapshots(actor);
  return { decision: input.decision };
}

const CSV_RISKY = /^[=+\-@\t\r]/;
function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (CSV_RISKY.test(text)) text = `'${text}`; // spreadsheet formula injection guard
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Statement of Applicability style export: every requirement, its applicability, justification, status and mapped controls. */
export async function exportStatement(tenantId: string, frameworkId: FrameworkId) {
  const detail = await frameworkDetail(tenantId, frameworkId);
  const { states } = await loadStates(tenantId);
  const header = ["requirement_id", "title", "group", "applicable", "justification", "status", "score_percent", "evidence_verified", "unified_controls", "mapping_basis", "control_statuses"];
  const rows = detail.requirements.map((requirement) => [
    requirement.id, requirement.title, requirement.group, requirement.status === "not_applicable" ? "no" : "yes", requirement.justification ?? "", requirement.status,
    requirement.score === null ? "" : Math.round(requirement.score * 100), requirement.verified ? "yes" : "no", requirement.controls.join(" "),
    requirement.links.map((link) => `${link.ucCode}=${link.review ?? link.basis}`).join(" "),
    requirement.controls.map((code) => `${code}=${states.get(code)?.status ?? "not_started"}`).join(" "),
  ]);
  return { json: { framework: { id: frameworkId, name: detail.framework?.name, version: detail.framework?.version }, generatedAt: new Date().toISOString(), score: detail.score, readiness: detail.readiness, requirements: detail.requirements }, csv: [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") };
}

const DEMO_POSTURE: Record<ImplementationStatus, string[]> = {
  implemented: ["GOV-01", "GOV-02", "GOV-03", "GOV-08", "CMP-01", "ASM-01", "DAT-03", "DAT-05", "IAM-01", "IAM-02", "IAM-04", "OPS-01", "OPS-03", "OPS-04", "OPS-05", "OPS-06", "SDL-01", "INC-01", "HR-01", "HR-02", "HR-03", "PHY-01", "PRV-01"],
  partial: ["GOV-04", "GOV-05", "GOV-06", "GOV-07", "DAT-01", "DAT-02", "DAT-04", "IAM-03", "OPS-02", "OPS-07", "OPS-08", "OPS-09", "OPS-11", "INC-02", "BCP-01", "PHY-02", "TPM-01", "TPM-02", "PRV-02", "PRV-03", "PRV-04", "AI-02", "AI-05"],
  planned: ["OPS-10", "BCP-02", "TPM-03", "TPM-04", "PRV-05", "AI-01", "AI-03", "AI-04", "AI-06"],
  not_started: [], not_applicable: [],
};
const DEMO_LINKS: Record<string, string> = { "UC-SDL-01": "CTL-SDLC-004", "UC-AI-05": "CTL-AI-014" };

/**
 * Removes everything the sample posture created (rows tagged `demo`), leaving real attestations, adoptions,
 * policies, exceptions and mapping reviews untouched. Trend points are recomputed from what remains.
 */
export async function purgeDemoPosture(actor: Actor) {
  const db = await scope(actor.tenantId);
  const counts = { controls: 0, adoptions: 0, policies: 0, exceptions: 0 };
  await db.transaction(async (tx) => {
    counts.controls = (await tx.run("DELETE FROM control_implementations WHERE tenant_id = ? AND source = 'demo'", actor.tenantId)).changes;
    counts.adoptions = (await tx.run("DELETE FROM framework_adoptions WHERE tenant_id = ? AND source = 'demo'", actor.tenantId)).changes;
    counts.policies = (await tx.run("DELETE FROM policy_register WHERE tenant_id = ? AND source = 'demo'", actor.tenantId)).changes;
    counts.exceptions = (await tx.run("DELETE FROM compliance_exceptions WHERE tenant_id = ? AND source = 'demo'", actor.tenantId)).changes;
    await tx.run("DELETE FROM compliance_snapshots WHERE tenant_id = ?", actor.tenantId);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.demo_posture_purged", objectType: "tenant", objectId: actor.tenantId, payload: counts }, tx);
  });
  await refreshSnapshots(actor, true);
  return { purged: counts };
}

/** Loads a clearly tagged sample posture into an empty tenant so the hub can be explored. Idempotent. */
export async function loadDemoPosture(actor: Actor) {
  const db = await scope(actor.tenantId);
  for (const table of ["control_implementations", "framework_adoptions", "policy_register", "compliance_exceptions"]) {
    const existing = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, actor.tenantId);
    if (Number(existing?.n) > 0) return { loaded: false };
  }
  const at = new Date().toISOString();
  const soon = (days: number) => new Date(Date.now() + days * DAY).toISOString();
  const knownControls = new Set((await db.all<{ code: string }>("SELECT code FROM controls WHERE tenant_id = ? AND valid_to IS NULL", actor.tenantId)).map((row) => row.code));
  const maturity: Record<string, number> = { implemented: 4, partial: 2, planned: 1, not_started: 0, not_applicable: 0 };

  await db.transaction(async (tx) => {
    for (const [status, codes] of Object.entries(DEMO_POSTURE) as Array<[ImplementationStatus, string[]]>) {
      for (const short of codes) {
        const ucCode = `UC-${short}`;
        const linked = DEMO_LINKS[ucCode] && knownControls.has(DEMO_LINKS[ucCode]) ? DEMO_LINKS[ucCode] : null;
        await tx.run(`INSERT INTO control_implementations (id,tenant_id,uc_code,status,maturity,owner_id,linked_control_code,notes,source,review_due,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          `impl_${randomUUID()}`, actor.tenantId, ucCode, status, maturity[status], null, linked, "Sample posture for demonstration", "demo", soon(120), actor.userId, at);
      }
    }
    for (const [frameworkId, scopeText] of [["iso27001", "Lending platform, cloud estate and supporting teams"], ["nist_csf", "Enterprise-wide"], ["soc2", "Lending decision service (Security, Availability, Confidentiality)"], ["gdpr", "EU customer personal data"], ["dora", "ICT services supporting critical functions"], ["eu_ai_act", "Lending Decision Copilot (high-risk)"]] as const) {
      await tx.run("INSERT INTO framework_adoptions (id,tenant_id,framework_id,scope,target_date,adopted_by,adopted_at,source) VALUES (?,?,?,?,?,?,?,?)", `demo_adopt_${randomUUID()}`, actor.tenantId, frameworkId, scopeText, soon(240).slice(0, 10), actor.userId, at, "demo");
    }
    for (const policy of [
      { title: "Information Security Policy", version: "3.1", status: "approved", review: soon(150), codes: ["UC-GOV-01"] },
      { title: "Acceptable Use Policy", version: "2.4", status: "approved", review: new Date(Date.now() - 20 * DAY).toISOString(), codes: ["UC-HR-03", "UC-ASM-01"] },
      { title: "AI Governance Policy", version: "0.9", status: "draft", review: null, codes: ["UC-AI-01", "UC-AI-02"] },
    ] as const) {
      await tx.run(`INSERT INTO policy_register (id,tenant_id,title,version,owner_id,status,approved_at,next_review,uc_codes_json,document_hash,created_at,updated_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `demo_pol_${randomUUID()}`, actor.tenantId, policy.title, policy.version, null, policy.status, policy.status === "approved" ? at : null, policy.review, JSON.stringify(policy.codes), null, at, at, "demo");
    }
    await tx.run(`INSERT INTO compliance_exceptions (id,tenant_id,uc_code,title,justification,compensating_controls,risk_level,requested_by,status,expires_at,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      `demo_exc_${randomUUID()}`, actor.tenantId, "UC-OPS-09", "Defer threat-led penetration test to next cycle", "Vendor availability pushes the TLPT window past the current quarter.", "Quarterly vulnerability scanning and an internal red-team exercise remain in place.", "medium", "system", "pending", soon(90), at, "demo");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.demo_posture_loaded", objectType: "tenant", objectId: actor.tenantId, payload: { controls: UNIFIED_CONTROLS.length } }, tx);
  });
  await refreshSnapshots(actor, true);
  return { loaded: true };
}
