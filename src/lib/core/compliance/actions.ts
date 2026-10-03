import "server-only";

import { SUGGESTED_LINKS } from "@/lib/connectors/pack";
import type { Actor } from "@/lib/core/auth";
import { storeVaultDocument } from "@/lib/core/enterprise-engine";
import { userError } from "@/lib/core/errors";
import { appendAudit, sha256 } from "@/lib/core/integrity";
import { loadCustomRequirements } from "@/lib/core/licensed-content";
import { notify } from "@/lib/core/notifications";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { baseControls, linkBasis, linkKey } from "@/lib/frameworks/mapping";
import type { FrameworkId, ImplementationStatus } from "@/lib/frameworks/types";
import { UC_BY_CODE } from "@/lib/frameworks/unified";
import { randomUUID } from "node:crypto";
import { refreshSnapshots } from "@/lib/core/compliance/snapshot";
import { DAY, MAX_EXCEPTION_DAYS, REVIEW_DAYS, linkedCodes, scope } from "@/lib/core/compliance/state";
import type { EvidenceRow, ExceptionRow } from "@/lib/core/compliance/state";

export async function adoptFramework(actor: Actor, input: { frameworkId: FrameworkId; scope: string; targetDate?: string }) {
  if (!FRAMEWORK_BY_ID.has(input.frameworkId)) throw userError(`Framework ${input.frameworkId} not found`);
  const db = await scope(actor.tenantId);
  const at = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO framework_adoptions (id,tenant_id,framework_id,scope,target_date,adopted_by,adopted_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, framework_id) DO UPDATE SET scope = excluded.scope, target_date = excluded.target_date, source = 'attested'`,
      `adopt_${randomUUID()}`,
      actor.tenantId,
      input.frameworkId,
      input.scope,
      input.targetDate ?? null,
      actor.userId,
      at,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.framework_adopted",
        objectType: "framework",
        objectId: input.frameworkId,
        payload: { scope: input.scope, targetDate: input.targetDate ?? null },
      },
      tx,
    );
  });
  await refreshSnapshots(actor);
  return { frameworkId: input.frameworkId };
}

export async function setImplementation(
  actor: Actor,
  input: {
    ucCode: string;
    status: ImplementationStatus;
    maturity: number;
    ownerId?: string;
    linkedControlCode?: string;
    notes: string;
    reviewDue?: string;
  },
) {
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
  const previous = await db.get<{ status: string }>(
    "SELECT status FROM control_implementations WHERE tenant_id = ? AND uc_code = ?",
    actor.tenantId,
    input.ucCode,
  );
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO control_implementations (id,tenant_id,uc_code,status,maturity,owner_id,linked_control_code,notes,source,review_due,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, uc_code) DO UPDATE SET status = excluded.status, maturity = excluded.maturity, owner_id = excluded.owner_id, linked_control_code = excluded.linked_control_code, notes = excluded.notes, source = excluded.source, review_due = excluded.review_due, updated_by = excluded.updated_by, updated_at = excluded.updated_at, countersigned_by = NULL, countersigned_at = NULL`,
      `impl_${randomUUID()}`,
      actor.tenantId,
      input.ucCode,
      input.status,
      input.maturity,
      input.ownerId ?? null,
      linkedValue,
      input.notes,
      "attested",
      reviewDue,
      actor.userId,
      at,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.implementation_updated",
        objectType: "unified_control",
        objectId: input.ucCode,
        payload: { from: previous?.status ?? "not_started", to: input.status, maturity: input.maturity, linkedControlCode: linkedValue },
      },
      tx,
    );
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
  const existing = new Set(
    (await db.all<{ code: string }>("SELECT code FROM controls WHERE tenant_id = ? AND valid_to IS NULL", actor.tenantId)).map(
      (row) => row.code,
    ),
  );
  const at = new Date().toISOString();
  const linked: Array<{ ucCode: string; controls: string[] }> = [];
  await db.transaction(async (tx) => {
    for (const [ucCode, suggested] of Object.entries(SUGGESTED_LINKS)) {
      const available = suggested.filter((code) => existing.has(code));
      if (!available.length) continue;
      const row = await tx.get<{ linked_control_code: string | null }>(
        "SELECT linked_control_code FROM control_implementations WHERE tenant_id = ? AND uc_code = ?",
        actor.tenantId,
        ucCode,
      );
      const merged = [...new Set([...linkedCodes(row?.linked_control_code), ...available])];
      if (row && merged.join(",") === linkedCodes(row.linked_control_code).join(",")) continue;
      if (row)
        await tx.run(
          "UPDATE control_implementations SET linked_control_code = ?, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND uc_code = ?",
          merged.join(","),
          actor.userId,
          at,
          actor.tenantId,
          ucCode,
        );
      else
        await tx.run(
          `INSERT INTO control_implementations (id,tenant_id,uc_code,status,maturity,owner_id,linked_control_code,notes,source,review_due,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          `impl_${randomUUID()}`,
          actor.tenantId,
          ucCode,
          "not_started",
          0,
          null,
          merged.join(","),
          "Evidence linked; implementation not yet attested",
          "attested",
          null,
          actor.userId,
          at,
        );
      linked.push({ ucCode, controls: merged });
    }
    if (linked.length)
      await appendAudit(
        {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "compliance.evidence_linked",
          objectType: "tenant",
          objectId: actor.tenantId,
          payload: { linked },
        },
        tx,
      );
  });
  await refreshSnapshots(actor);
  return { linked };
}

/** Renews an attestation without changing it: the owner confirms the claim still holds. Restarts the review clock and clears the countersignature. */
export async function reattest(actor: Actor, input: { ucCode: string; note: string }) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const db = await scope(actor.tenantId);
  const row = await db.get<{ status: ImplementationStatus }>(
    "SELECT status FROM control_implementations WHERE tenant_id = ? AND uc_code = ?",
    actor.tenantId,
    input.ucCode,
  );
  const days = row ? REVIEW_DAYS[row.status] : undefined;
  if (!row || !days) throw userError("Only an implemented, partial or planned control can be re-attested");
  const at = new Date().toISOString();
  const reviewDue = new Date(Date.now() + days * DAY).toISOString();
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE control_implementations SET review_due = ?, updated_by = ?, updated_at = ?, countersigned_by = NULL, countersigned_at = NULL WHERE tenant_id = ? AND uc_code = ?",
      reviewDue,
      actor.userId,
      at,
      actor.tenantId,
      input.ucCode,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.attestation_renewed",
        objectType: "unified_control",
        objectId: input.ucCode,
        payload: { note: input.note, status: row.status },
      },
      tx,
    );
  });
  await refreshSnapshots(actor);
  return { ucCode: input.ucCode, reviewDue };
}

/** A second person confirms the current attestation. The person who made it cannot. Changing the attestation clears the countersignature. */
export async function countersign(actor: Actor, input: { ucCode: string; note: string }) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const db = await scope(actor.tenantId);
  const row = await db.get<{ status: ImplementationStatus; updated_by: string; countersigned_by: string | null }>(
    "SELECT status, updated_by, countersigned_by FROM control_implementations WHERE tenant_id = ? AND uc_code = ?",
    actor.tenantId,
    input.ucCode,
  );
  if (!row || (row.status !== "implemented" && row.status !== "partial"))
    throw userError("Only an implemented or partial attestation can be countersigned");
  if (row.updated_by === actor.userId) throw userError("Separation of duties: the person who made the attestation cannot countersign it");
  await db.transaction(async (tx) => {
    const result = await tx.run(
      "UPDATE control_implementations SET countersigned_by = ?, countersigned_at = ? WHERE tenant_id = ? AND uc_code = ? AND updated_by = ?",
      actor.userId,
      new Date().toISOString(),
      actor.tenantId,
      input.ucCode,
      row.updated_by,
    );
    if (result.changes !== 1) throw userError("The attestation changed while you were reviewing it; review it again");
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.attestation_countersigned",
        objectType: "unified_control",
        objectId: input.ucCode,
        payload: { note: input.note, attestedBy: row.updated_by },
      },
      tx,
    );
  });
  await refreshSnapshots(actor);
  return { ucCode: input.ucCode, countersignedBy: actor.userId };
}

const MAX_EVIDENCE_DAYS = 730;

/** Stores a document in the evidence vault (hashed, signed, versioned) and files it against a unified control, pending review. */
export async function attachEvidence(
  actor: Actor,
  input: {
    ucCode: string;
    title: string;
    kind: "document" | "record" | "report" | "certificate";
    validUntil: string;
    note: string;
    file: File;
  },
) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const until = Date.parse(input.validUntil);
  if (!(until > Date.now())) throw userError("Evidence must be valid until a future date");
  if (until - Date.now() > MAX_EVIDENCE_DAYS * DAY)
    throw userError(`Evidence cannot be declared valid for more than ${MAX_EVIDENCE_DAYS} days`);
  const stored = await storeVaultDocument(actor, input.file, `control-evidence:${input.kind}`);
  const id = `cev_${randomUUID()}`;
  const db = await scope(actor.tenantId);
  await db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO control_evidence (id,tenant_id,uc_code,title,kind,vault_document_id,content_hash,note,valid_until,uploaded_by,uploaded_at,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      actor.tenantId,
      input.ucCode,
      input.title,
      input.kind,
      stored.id,
      stored.hash,
      input.note,
      new Date(until).toISOString(),
      actor.userId,
      new Date().toISOString(),
      "pending",
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.evidence_attached",
        objectType: "control_evidence",
        objectId: id,
        payload: { ucCode: input.ucCode, hash: stored.hash, kind: input.kind, vaultDocumentId: stored.id },
      },
      tx,
    );
  });
  await notify(actor.tenantId, {
    type: "evidence.pending_review",
    severity: "low",
    title: `Evidence awaiting review: ${input.title}`,
    body: `${actor.name} uploaded evidence for ${input.ucCode}. Someone else must review it.`,
    dedupeKey: `evidence.pending:${id}:new`,
  }).catch(() => undefined);
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
    const result = await tx.run(
      "UPDATE control_evidence SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE tenant_id = ? AND id = ? AND status = 'pending'",
      status,
      actor.userId,
      new Date().toISOString(),
      input.note,
      actor.tenantId,
      input.id,
    );
    if (result.changes !== 1) throw userError("Evidence has already been reviewed");
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: `compliance.evidence_${status}`,
        objectType: "control_evidence",
        objectId: input.id,
        payload: { ucCode: row.uc_code, hash: row.content_hash, note: input.note },
      },
      tx,
    );
  });
  await refreshSnapshots(actor);
  return { id: input.id, status };
}

export async function setRequirementScope(
  actor: Actor,
  input: { frameworkId: FrameworkId; requirementId: string; applicable: boolean; justification?: string },
) {
  const framework = FRAMEWORK_BY_ID.get(input.frameworkId);
  const imported = (await loadCustomRequirements(actor.tenantId)).get(input.frameworkId)?.some((item) => item.id === input.requirementId);
  if (!imported && !framework?.requirements.some((requirement) => requirement.id === input.requirementId))
    throw userError(`Requirement ${input.requirementId} not found`);
  if (!input.applicable && (input.justification ?? "").trim().length < 15)
    throw userError("A justification of at least 15 characters is required to exclude a requirement");
  const db = await scope(actor.tenantId);
  await db.transaction(async (tx) => {
    if (input.applicable)
      await tx.run(
        "DELETE FROM requirement_scope WHERE tenant_id = ? AND framework_id = ? AND requirement_id = ?",
        actor.tenantId,
        input.frameworkId,
        input.requirementId,
      );
    else
      await tx.run(
        `INSERT INTO requirement_scope (id,tenant_id,framework_id,requirement_id,justification,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, framework_id, requirement_id) DO UPDATE SET justification = excluded.justification, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        `scope_${randomUUID()}`,
        actor.tenantId,
        input.frameworkId,
        input.requirementId,
        input.justification!.trim(),
        actor.userId,
        new Date().toISOString(),
      );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: input.applicable ? "compliance.requirement_included" : "compliance.requirement_excluded",
        objectType: "requirement",
        objectId: `${input.frameworkId}:${input.requirementId}`,
        payload: { justification: input.justification ?? null },
      },
      tx,
    );
  });
  await refreshSnapshots(actor);
  return { frameworkId: input.frameworkId, requirementId: input.requirementId, applicable: input.applicable };
}

export async function requestException(
  actor: Actor,
  input: {
    ucCode: string;
    title: string;
    justification: string;
    compensatingControls: string;
    riskLevel: "low" | "medium" | "high" | "critical";
    expiresAt: string;
  },
) {
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const expires = Date.parse(input.expiresAt);
  const now = Date.now();
  if (!(expires > now)) throw userError("An exception must expire in the future");
  if (expires - now > MAX_EXCEPTION_DAYS * DAY)
    throw userError(`An exception cannot last longer than ${MAX_EXCEPTION_DAYS} days; re-approve it instead`);
  const id = `exc_${randomUUID()}`;
  const at = new Date().toISOString();
  await (
    await scope(actor.tenantId)
  ).transaction(async (tx) => {
    await tx.run(
      `INSERT INTO compliance_exceptions (id,tenant_id,uc_code,title,justification,compensating_controls,risk_level,requested_by,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      actor.tenantId,
      input.ucCode,
      input.title,
      input.justification,
      input.compensatingControls,
      input.riskLevel,
      actor.userId,
      "pending",
      new Date(expires).toISOString(),
      at,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.exception_requested",
        objectType: "exception",
        objectId: id,
        payload: { ucCode: input.ucCode, riskLevel: input.riskLevel, expiresAt: input.expiresAt },
      },
      tx,
    );
  });
  await notify(actor.tenantId, {
    type: "exception.pending",
    severity: "medium",
    title: `Risk acceptance awaiting a decision: ${input.title}`,
    body: `${actor.name} requested an exception for ${input.ucCode} (${input.riskLevel} risk).`,
    dedupeKey: `exception.pending:${id}:requested`,
  }).catch(() => undefined);
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
    const result = await tx.run(
      "UPDATE compliance_exceptions SET status = ?, approved_by = ?, decided_at = ?, decision_note = ?, source = 'attested' WHERE tenant_id = ? AND id = ? AND status = 'pending'",
      status,
      actor.userId,
      new Date().toISOString(),
      input.note,
      actor.tenantId,
      input.id,
    );
    if (result.changes !== 1) throw userError("Exception has already been decided");
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: `compliance.exception_${status}`,
        objectType: "exception",
        objectId: input.id,
        payload: { ucCode: row.uc_code, note: input.note },
      },
      tx,
    );
  });
  return { id: input.id, status };
}

export async function upsertPolicy(
  actor: Actor,
  input: {
    id?: string;
    title: string;
    version: string;
    status: "draft" | "in_review" | "approved" | "retired";
    ownerId?: string;
    nextReview?: string;
    ucCodes: string[];
    content?: string;
  },
) {
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
    await tx.run(
      `INSERT INTO policy_register (id,tenant_id,title,version,owner_id,status,approved_at,next_review,uc_codes_json,document_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, version = excluded.version, owner_id = excluded.owner_id, status = excluded.status, approved_at = COALESCE(excluded.approved_at, policy_register.approved_at), next_review = excluded.next_review, uc_codes_json = excluded.uc_codes_json, document_hash = COALESCE(excluded.document_hash, policy_register.document_hash), updated_at = excluded.updated_at, source = 'attested'`,
      id,
      actor.tenantId,
      input.title,
      input.version,
      input.ownerId ?? null,
      input.status,
      input.status === "approved" ? at : null,
      input.nextReview ?? null,
      JSON.stringify(input.ucCodes),
      hash,
      at,
      at,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.policy_saved",
        objectType: "policy",
        objectId: id,
        payload: { title: input.title, version: input.version, status: input.status, documentHash: hash },
      },
      tx,
    );
  });
  return { id };
}

/** Records a reviewer's decision on a crosswalk link. `reset` returns it to the built-in state. */
export async function reviewMapping(
  actor: Actor,
  input: {
    frameworkId: FrameworkId;
    requirementId: string;
    ucCode: string;
    decision: "validated" | "rejected" | "added" | "reset";
    note?: string;
  },
) {
  const framework = FRAMEWORK_BY_ID.get(input.frameworkId);
  const imported = (await loadCustomRequirements(actor.tenantId)).get(input.frameworkId)?.find((item) => item.id === input.requirementId);
  if (!imported && !framework?.requirements.some((requirement) => requirement.id === input.requirementId))
    throw userError(`Requirement ${input.requirementId} not found`);
  if (!UC_BY_CODE.has(input.ucCode)) throw userError(`Unified control ${input.ucCode} not found`);
  const builtIn = (imported?.controls ?? baseControls(input.frameworkId, input.requirementId)).includes(input.ucCode);
  if (input.decision === "added" && builtIn) throw userError("This link already exists in the built-in crosswalk");
  if ((input.decision === "validated" || input.decision === "rejected") && !builtIn)
    throw userError("Only links of the built-in crosswalk can be validated or rejected; remove an added link with reset");
  if (input.decision !== "reset" && (input.note ?? "").trim().length < 10)
    throw userError("A review note of at least 10 characters is required");
  const db = await scope(actor.tenantId);
  await db.transaction(async (tx) => {
    if (input.decision === "reset")
      await tx.run(
        "DELETE FROM mapping_reviews WHERE tenant_id = ? AND framework_id = ? AND requirement_id = ? AND uc_code = ?",
        actor.tenantId,
        input.frameworkId,
        input.requirementId,
        input.ucCode,
      );
    else
      await tx.run(
        `INSERT INTO mapping_reviews (id,tenant_id,framework_id,requirement_id,uc_code,decision,note,reviewer_id,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, framework_id, requirement_id, uc_code) DO UPDATE SET decision = excluded.decision, note = excluded.note, reviewer_id = excluded.reviewer_id, reviewed_at = excluded.reviewed_at`,
        `map_${randomUUID()}`,
        actor.tenantId,
        input.frameworkId,
        input.requirementId,
        input.ucCode,
        input.decision,
        input.note!.trim(),
        actor.userId,
        new Date().toISOString(),
      );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: `compliance.mapping_${input.decision}`,
        objectType: "mapping",
        objectId: linkKey(input.frameworkId, input.requirementId, input.ucCode),
        payload: { basis: builtIn ? linkBasis(input.frameworkId, input.requirementId, input.ucCode) : "tenant", note: input.note ?? null },
      },
      tx,
    );
  });
  await refreshSnapshots(actor);
  return { decision: input.decision };
}

export const CSV_RISKY = /^[=+\-@\t\r]/;
