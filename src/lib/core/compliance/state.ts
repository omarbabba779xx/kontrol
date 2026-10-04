import "server-only";

import { backedByRecords, ismsClauses } from "@/lib/core/isms-checks";
import { loadCustomRequirements } from "@/lib/core/licensed-content";
import { getDb } from "@/lib/db";
import type { Executor } from "@/lib/db";
import { allLinks, allSuggestions, linkKey } from "@/lib/frameworks/mapping";
import { isBacked } from "@/lib/frameworks/scoring";
import type { ControlState, MappingOverrides, NotApplicable, Verification } from "@/lib/frameworks/scoring";
import type { FrameworkId, ImplementationStatus } from "@/lib/frameworks/types";

export const MAX_EXCEPTION_DAYS = 365;
export const DAY = 86_400_000;

type ImplementationRow = {
  uc_code: string;
  status: ImplementationStatus;
  maturity: number;
  owner_id: string | null;
  linked_control_code: string | null;
  notes: string;
  source: string;
  review_due: string | null;
  updated_by: string;
  updated_at: string;
  countersigned_by: string | null;
  countersigned_at: string | null;
};
export type ExceptionRow = {
  id: string;
  uc_code: string;
  title: string;
  justification: string;
  compensating_controls: string;
  risk_level: string;
  requested_by: string;
  approved_by: string | null;
  status: string;
  expires_at: string;
  created_at: string;
  decided_at: string | null;
  decision_note: string | null;
};
export type PolicyRow = {
  id: string;
  title: string;
  version: string;
  owner_id: string | null;
  status: string;
  approved_at: string | null;
  next_review: string | null;
  uc_codes_json: string;
  document_hash: string | null;
  updated_at: string;
  source: string;
};

export const scope = async (tenantId: string) => (await getDb()).scope(tenantId);

async function singleVerification(db: Executor, tenantId: string, controlCode: string): Promise<Verification> {
  const latest = await db.get<{ status: string; expires_at: string | null }>(
    "SELECT e.status, e.expires_at FROM evidence e JOIN controls c ON c.id = e.control_id WHERE e.tenant_id = ? AND c.code = ? AND c.valid_to IS NULL AND e.source NOT LIKE 'manual:%' ORDER BY e.collected_at DESC LIMIT 1",
    tenantId,
    controlCode,
  );
  if (!latest) return "unverified";
  if (latest.status === "failed") return "failing";
  if (latest.expires_at && latest.expires_at < new Date().toISOString()) return "stale";
  return "verified";
}

/** A unified control may be backed by several executable controls (comma-separated codes). One failing control fails the lot. */
export function linkedCodes(value: string | null | undefined) {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((code) => code.trim())
        .filter(Boolean),
    ),
  ];
}

async function evidenceVerification(db: Executor, tenantId: string, linked: string | null): Promise<Verification> {
  const codes = linkedCodes(linked);
  if (!codes.length) return "unverified";
  const results = await Promise.all(codes.map((code) => singleVerification(db, tenantId, code)));
  if (results.includes("failing")) return "failing";
  if (results.includes("stale")) return "stale";
  return results.every((result) => result === "verified") ? "verified" : "unverified";
}

export type EvidenceRow = {
  id: string;
  uc_code: string;
  title: string;
  kind: string;
  vault_document_id: string | null;
  content_hash: string;
  note: string;
  valid_until: string;
  uploaded_by: string;
  uploaded_at: string;
  status: "pending" | "accepted" | "rejected";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
};

export const requireCountersignature = () => process.env.KONTROL_REQUIRE_COUNTERSIGN === "true";
export const REVIEW_DAYS: Partial<Record<ImplementationStatus, number>> = { implemented: 365, partial: 180, planned: 90 };

/**
 * Machine evidence wins over documents; documents back a claim only while an accepted one is still valid. A governance control whose
 * own management-system records exist, are approved and are current (see isms-checks.ts) is documented by those records.
 */
function combineVerification(machine: Verification, documents: EvidenceRow[], now: string, backedByOwnRecords = false): Verification {
  if (machine === "failing" || machine === "verified") return machine;
  const accepted = documents.filter((row) => row.status === "accepted");
  if (accepted.some((row) => row.valid_until > now) || backedByOwnRecords) return "documented";
  return machine === "stale" || accepted.length > 0 ? "stale" : "unverified";
}

/** Merges attested implementation, machine and documentary evidence, expiry and approved risk acceptances into one state per unified control. */
export async function loadStates(tenantId: string) {
  const db = await scope(tenantId);
  const rows = await db.all<ImplementationRow>("SELECT * FROM control_implementations WHERE tenant_id = ?", tenantId);
  const documents = await db.all<EvidenceRow>("SELECT * FROM control_evidence WHERE tenant_id = ?", tenantId);
  const now = new Date().toISOString();
  const excepted = new Set(
    (
      await db.all<{ uc_code: string }>(
        "SELECT uc_code FROM compliance_exceptions WHERE tenant_id = ? AND status = 'approved' AND expires_at > ?",
        tenantId,
        now,
      )
    ).map((row) => row.uc_code),
  );
  const records = backedByRecords(await ismsClauses(db, tenantId));
  const states = new Map<string, ControlState>();
  for (const row of rows) {
    const verification = combineVerification(
      await evidenceVerification(db, tenantId, row.linked_control_code),
      documents.filter((item) => item.uc_code === row.uc_code),
      now,
      records.has(row.uc_code),
    );
    const claimed = row.status === "implemented" || row.status === "partial";
    states.set(row.uc_code, {
      status: row.status,
      maturity: row.maturity,
      verification,
      excepted: excepted.has(row.uc_code),
      attestationExpired: claimed && row.review_due !== null && row.review_due < now && !isBacked(verification),
      awaitingCountersignature:
        requireCountersignature() && row.status === "implemented" && !row.countersigned_by && !isBacked(verification),
    });
  }
  return { states, rows, documents };
}

export async function loadScope(tenantId: string) {
  const rows = await (
    await scope(tenantId)
  ).all<{ framework_id: FrameworkId; requirement_id: string; justification: string }>(
    "SELECT framework_id, requirement_id, justification FROM requirement_scope WHERE tenant_id = ?",
    tenantId,
  );
  const byFramework = new Map<FrameworkId, NotApplicable>();
  for (const row of rows) {
    const map = byFramework.get(row.framework_id) ?? new Map<string, string>();
    map.set(row.requirement_id, row.justification);
    byFramework.set(row.framework_id, map);
  }
  return byFramework;
}

type ReviewRow = {
  framework_id: FrameworkId;
  requirement_id: string;
  uc_code: string;
  decision: "validated" | "rejected" | "added";
  note: string;
  reviewer_id: string;
  reviewed_at: string;
};

export async function loadReviews(tenantId: string) {
  return (await scope(tenantId)).all<ReviewRow>(
    "SELECT framework_id, requirement_id, uc_code, decision, note, reviewer_id, reviewed_at FROM mapping_reviews WHERE tenant_id = ?",
    tenantId,
  );
}

export function toOverrides(rows: ReviewRow[], custom?: MappingOverrides["custom"]): MappingOverrides {
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

export async function loadOverrides(tenantId: string) {
  return toOverrides(await loadReviews(tenantId), await loadCustomRequirements(tenantId));
}

/** Review coverage of the built-in crosswalk for one framework. */
export function mappingStats(frameworkId: FrameworkId, reviews: ReviewRow[]) {
  const links = allLinks().filter((link) => link.frameworkId === frameworkId);
  const mine = reviews.filter((row) => row.framework_id === frameworkId);
  const decided = new Set(mine.filter((row) => row.decision !== "added").map((row) => `${row.requirement_id}|${row.uc_code}`));
  return {
    links: links.length,
    published: links.filter((link) => link.basis === "published").length,
    validated: mine.filter((row) => row.decision === "validated").length,
    rejected: mine.filter((row) => row.decision === "rejected").length,
    added: mine.filter((row) => row.decision === "added").length,
    suggested: allSuggestions().filter(
      (item) =>
        item.frameworkId === frameworkId && !mine.some((row) => row.requirement_id === item.requirementId && row.uc_code === item.ucCode),
    ).length,
    reviewedShare: links.length
      ? Math.round(
          (links.filter((link) => decided.has(`${link.requirementId}|${link.ucCode}`) || link.basis === "published").length /
            links.length) *
            1000,
        ) / 10
      : 0,
  };
}

export async function adoptedIds(tenantId: string) {
  return await (
    await scope(tenantId)
  ).all<{ framework_id: FrameworkId; scope: string; target_date: string | null; adopted_at: string; source: string }>(
    "SELECT framework_id, scope, target_date, adopted_at, source FROM framework_adoptions WHERE tenant_id = ? ORDER BY adopted_at",
    tenantId,
  );
}
