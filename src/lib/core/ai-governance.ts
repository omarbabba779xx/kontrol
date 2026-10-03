import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { classify, MODEL_CARD_FIELDS, type Answers, type Classification, type Role } from "@/lib/core/ai-act";
import { complianceSnapshot } from "@/lib/core/compliance-engine";
import { userError } from "@/lib/core/errors";
import { appendAudit, canonicalJson, sha256 } from "@/lib/core/integrity";
import { getDb } from "@/lib/db";

/**
 * AI governance: a register of AI use cases, each classified under the EU AI Act with its reasoning recorded, a versioned model
 * card, and a fundamental rights impact assessment where one is required. An AI system is approved for use only by someone other
 * than its owner, and a high-risk one only when the paperwork exists and the controls behind its obligations are in place.
 * Classification is a triage with recorded reasoning, not legal advice: see docs/AI_GOVERNANCE.md.
 */
type UseCaseRow = { id: string; ref: string; name: string; purpose: string; role: Role; owner_id: string | null; status: "draft" | "classified" | "approved" | "blocked" | "retired"; answers_json: string; tier: Classification["tier"] | null; classification_json: string; classified_by: string | null; classified_at: string | null; approved_by: string | null; approved_at: string | null; approval_note: string | null; created_by: string; created_at: string; updated_at: string; retired_at: string | null };
type CardRow = { id: string; use_case_id: string; version: number; content_json: string; content_hash: string; created_by: string; created_at: string };
type FriaRow = { id: string; use_case_id: string; content_json: string; status: "draft" | "completed"; created_by: string; created_at: string; updated_at: string; reviewed_by: string | null; reviewed_at: string | null };
export type FriaContent = { description: string; affectedGroups: string; rights: Array<{ right: string; impact: "none" | "low" | "medium" | "high"; note: string }>; mitigations: string; oversight: string; remedy: string };
const MIN_APPROVAL_WEIGHT = 0.5;

async function db(tenantId: string) { return (await getDb()).scope(tenantId); }

async function load(actor: Actor, id: string) {
  const row = await (await db(actor.tenantId)).get<UseCaseRow>("SELECT * FROM ai_use_cases WHERE tenant_id = ? AND id = ?", actor.tenantId, id);
  if (!row) throw userError("AI use case not found");
  return row;
}
const assertLive = (row: UseCaseRow) => { if (row.status === "retired") throw userError("This AI use case is retired (already final): it can no longer change"); };

export async function createUseCase(actor: Actor, input: { name: string; purpose?: string; role: Role; ownerId?: string }) {
  const scope = await db(actor.tenantId);
  if (input.ownerId && !(await scope.get("SELECT id FROM users WHERE tenant_id = ? AND id = ? AND status = 'active' AND external = 0", actor.tenantId, input.ownerId))) throw userError("Owner not found");
  const id = `ais_${randomUUID()}`;
  const now = new Date().toISOString();
  let ref = "";
  await scope.transaction(async (tx) => {
    const count = await tx.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM ai_use_cases WHERE tenant_id = ?", actor.tenantId);
    ref = `AIS-${String(Number(count?.n ?? 0) + 1).padStart(3, "0")}`;
    await tx.run("INSERT INTO ai_use_cases (id,tenant_id,ref,name,purpose,role,owner_id,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, actor.tenantId, ref, input.name.trim(), input.purpose ?? "", input.role, input.ownerId ?? null, "draft", actor.userId, now, now);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "ai.use_case_created", objectType: "ai_use_case", objectId: id, payload: { ref, name: input.name, role: input.role } }, tx);
  });
  return { id, ref };
}

export async function classifyUseCase(actor: Actor, input: { id: string; answers: Answers }) {
  const row = await load(actor, input.id);
  assertLive(row);
  const result = classify({ ...input.answers, role: row.role });
  const status = result.tier === "prohibited" ? "blocked" : "classified";
  // A different tier means a different set of obligations: any earlier approval was for a system that no longer exists as described.
  const voids = row.status === "approved" && (row.tier !== result.tier || canonicalJson(JSON.parse(row.classification_json).obligations ?? []) !== canonicalJson(result.obligations));
  const keepApproval = row.status === "approved" && !voids;
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE ai_use_cases SET answers_json = ?, tier = ?, classification_json = ?, status = ?, classified_by = ?, classified_at = ?, approved_by = ?, approved_at = ?, approval_note = ?, updated_at = ? WHERE tenant_id = ? AND id = ?",
      JSON.stringify(input.answers), result.tier, JSON.stringify(result), keepApproval ? "approved" : status, actor.userId, now, keepApproval ? row.approved_by : null, keepApproval ? row.approved_at : null, keepApproval ? row.approval_note : null, now, actor.tenantId, row.id);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "ai.use_case_classified", objectType: "ai_use_case", objectId: row.id, payload: { ref: row.ref, tier: result.tier, previousTier: row.tier, gpai: result.gpai, approvalVoided: voids, reasons: result.reasons } }, tx);
  });
  return { id: row.id, tier: result.tier, status: keepApproval ? "approved" : status, approvalVoided: voids, classification: result };
}

const FIELD_IDS: readonly string[] = MODEL_CARD_FIELDS.map((field) => field.id);

/** Model cards are append-only: a new version never overwrites an old one, so what was documented when a decision was made stays provable. */
export async function saveModelCard(actor: Actor, input: { id: string; content: Record<string, string> }) {
  const row = await load(actor, input.id);
  assertLive(row);
  for (const key of Object.keys(input.content)) if (!FIELD_IDS.includes(key)) throw userError(`Unknown model card field ${key}`);
  const missing = MODEL_CARD_FIELDS.filter((field) => field.required && (input.content[field.id] ?? "").trim().length < 10);
  if (missing.length) throw userError(`Complete the required sections: ${missing.map((field) => field.label.split(":")[0]).join("; ")}`);
  const scope = await db(actor.tenantId);
  const content = Object.fromEntries(Object.entries(input.content).map(([key, value]) => [key, value.trim()]));
  const hash = sha256(canonicalJson(content));
  let version = 0;
  await scope.transaction(async (tx) => {
    const latest = await tx.get<{ v: number | string | null }>("SELECT MAX(version) AS v FROM ai_model_cards WHERE tenant_id = ? AND use_case_id = ?", actor.tenantId, row.id);
    const previous = await tx.get<CardRow>("SELECT * FROM ai_model_cards WHERE tenant_id = ? AND use_case_id = ? ORDER BY version DESC LIMIT 1", actor.tenantId, row.id);
    if (previous && previous.content_hash === hash) throw userError("The model card is unchanged (duplicate of the current version)");
    version = Number(latest?.v ?? 0) + 1;
    await tx.run("INSERT INTO ai_model_cards (id,tenant_id,use_case_id,version,content_json,content_hash,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)", `card_${randomUUID()}`, actor.tenantId, row.id, version, JSON.stringify(content), hash, actor.userId, new Date().toISOString());
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "ai.model_card_saved", objectType: "ai_use_case", objectId: row.id, payload: { ref: row.ref, version, sha256: hash } }, tx);
  });
  return { id: row.id, version, sha256: hash };
}

export async function saveFria(actor: Actor, input: { id: string; content: FriaContent; complete: boolean }) {
  const row = await load(actor, input.id);
  assertLive(row);
  const scope = await db(actor.tenantId);
  const existing = await scope.get<FriaRow>("SELECT * FROM ai_fria WHERE tenant_id = ? AND use_case_id = ?", actor.tenantId, row.id);
  if (input.complete) {
    const c = input.content;
    const gaps = [c.description, c.affectedGroups, c.mitigations, c.oversight, c.remedy].some((text) => text.trim().length < 10);
    if (gaps) throw userError("A completed assessment needs a description, the affected groups, mitigations, oversight and a remedy");
    if (c.rights.length === 0) throw userError("Assess at least one fundamental right");
    if (c.rights.some((item) => (item.impact === "medium" || item.impact === "high") && item.note.trim().length < 10)) throw userError("Explain every medium or high impact");
  }
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    // Any edit clears the review: a reviewer approved the text that existed then.
    if (existing) await tx.run("UPDATE ai_fria SET content_json = ?, status = ?, updated_at = ?, reviewed_by = NULL, reviewed_at = NULL WHERE tenant_id = ? AND use_case_id = ?", JSON.stringify(input.content), input.complete ? "completed" : "draft", now, actor.tenantId, row.id);
    else await tx.run("INSERT INTO ai_fria (id,tenant_id,use_case_id,content_json,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", `fria_${randomUUID()}`, actor.tenantId, row.id, JSON.stringify(input.content), input.complete ? "completed" : "draft", actor.userId, now, now);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "ai.fria_saved", objectType: "ai_use_case", objectId: row.id, payload: { ref: row.ref, complete: input.complete, sha256: sha256(canonicalJson(input.content)) } }, tx);
  });
  return { id: row.id, status: input.complete ? "completed" : "draft" };
}

export async function reviewFria(actor: Actor, input: { id: string }) {
  const row = await load(actor, input.id);
  const scope = await db(actor.tenantId);
  const fria = await scope.get<FriaRow>("SELECT * FROM ai_fria WHERE tenant_id = ? AND use_case_id = ?", actor.tenantId, row.id);
  if (!fria || fria.status !== "completed") throw userError("The impact assessment is not completed: nothing to review");
  if (fria.reviewed_by) throw userError("This assessment is already reviewed");
  if (fria.created_by === actor.userId || row.owner_id === actor.userId) throw userError("Separation of duties: the author or owner cannot review the assessment");
  await scope.transaction(async (tx) => {
    const changed = await tx.run("UPDATE ai_fria SET reviewed_by = ?, reviewed_at = ? WHERE tenant_id = ? AND use_case_id = ? AND reviewed_by IS NULL AND status = 'completed'", actor.userId, new Date().toISOString(), actor.tenantId, row.id);
    if (changed.changes !== 1) throw userError("The assessment changed while you were reviewing it");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "ai.fria_reviewed", objectType: "ai_use_case", objectId: row.id, payload: { ref: row.ref } }, tx);
  });
  return { id: row.id };
}

/** Coverage of each obligation by the unified control that supports it, from the live compliance posture. */
async function coverage(tenantId: string, classification: Classification) {
  const snapshot = await complianceSnapshot(tenantId);
  const posture = new Map(snapshot.controls.map((control) => [control.code, control]));
  return classification.obligations.map((obligation) => {
    const control = posture.get(obligation.ucCode);
    const weight = control?.weight ?? 0;
    return { ...obligation, control: { code: obligation.ucCode, title: control?.title ?? obligation.ucCode, status: control?.status ?? "not_started", verification: control?.verification ?? "unverified" }, state: weight >= 0.85 ? "met" as const : weight >= 0.4 ? "partial" as const : "open" as const, weight };
  });
}

export async function approveUseCase(actor: Actor, input: { id: string; note: string }) {
  const row = await load(actor, input.id);
  assertLive(row);
  if (row.status === "approved") throw userError("This AI use case is already approved");
  if (row.status === "blocked" || row.tier === "prohibited") throw userError("A prohibited AI practice cannot be approved");
  if (row.status !== "classified" || !row.tier) throw userError("Classify the use case before approving it");
  if (!row.owner_id) throw userError("Assign an owner before approving the use case");
  if (row.owner_id === actor.userId) throw userError("Separation of duties: the owner of an AI system cannot approve it");
  if (row.created_by === actor.userId) throw userError("Separation of duties: the person who registered an AI system cannot approve it");
  const classification = JSON.parse(row.classification_json) as Classification;
  const scope = await db(actor.tenantId);
  if (row.tier === "high" || classification.gpai.provider) {
    const card = await scope.get("SELECT id FROM ai_model_cards WHERE tenant_id = ? AND use_case_id = ?", actor.tenantId, row.id);
    if (!card) throw userError("A model card is required before this system can be approved");
  }
  if (classification.friaRequired) {
    const fria = await scope.get<FriaRow>("SELECT * FROM ai_fria WHERE tenant_id = ? AND use_case_id = ?", actor.tenantId, row.id);
    if (!fria || fria.status !== "completed") throw userError("A completed fundamental rights impact assessment is required (Art.27)");
    if (!fria.reviewed_by) throw userError("The impact assessment must be reviewed by someone other than its author before approval");
  }
  if (row.tier === "high") {
    const weak = (await coverage(actor.tenantId, classification)).filter((item) => item.weight < MIN_APPROVAL_WEIGHT);
    const codes = [...new Set(weak.map((item) => item.ucCode))];
    if (codes.length) throw userError(`Controls behind the obligations are not in place yet: ${codes.join(", ")} must be at least partially implemented`);
  }
  await scope.transaction(async (tx) => {
    const changed = await tx.run("UPDATE ai_use_cases SET status = 'approved', approved_by = ?, approved_at = ?, approval_note = ?, updated_at = ? WHERE tenant_id = ? AND id = ? AND status = 'classified'", actor.userId, new Date().toISOString(), input.note, new Date().toISOString(), actor.tenantId, row.id);
    if (changed.changes !== 1) throw userError("This AI use case already changed while you were deciding");
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "ai.use_case_approved", objectType: "ai_use_case", objectId: row.id, payload: { ref: row.ref, tier: row.tier, note: input.note } }, tx);
  });
  return { id: row.id };
}

export async function retireUseCase(actor: Actor, input: { id: string; note: string }) {
  const row = await load(actor, input.id);
  assertLive(row);
  const scope = await db(actor.tenantId);
  await scope.transaction(async (tx) => {
    await tx.run("UPDATE ai_use_cases SET status = 'retired', retired_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", new Date().toISOString(), new Date().toISOString(), actor.tenantId, row.id);
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "ai.use_case_retired", objectType: "ai_use_case", objectId: row.id, payload: { ref: row.ref, note: input.note } }, tx);
  });
  return { id: row.id };
}

export async function aiSnapshot(tenantId: string) {
  const scope = await db(tenantId);
  const rows = await scope.all<UseCaseRow>("SELECT * FROM ai_use_cases WHERE tenant_id = ? ORDER BY ref", tenantId);
  const cards = await scope.all<CardRow>("SELECT * FROM ai_model_cards WHERE tenant_id = ? ORDER BY version", tenantId);
  const frias = await scope.all<FriaRow>("SELECT * FROM ai_fria WHERE tenant_id = ?", tenantId);
  const useCases = [];
  for (const row of rows) {
    const classification = row.tier ? (JSON.parse(row.classification_json) as Classification) : null;
    const obligations = classification ? await coverage(tenantId, classification) : [];
    const mine = cards.filter((card) => card.use_case_id === row.id);
    const latest = mine[mine.length - 1];
    const fria = frias.find((item) => item.use_case_id === row.id);
    useCases.push({
      id: row.id, ref: row.ref, name: row.name, purpose: row.purpose, role: row.role, ownerId: row.owner_id, status: row.status, tier: row.tier, createdBy: row.created_by,
      answers: JSON.parse(row.answers_json) as Partial<Answers>, classification, classifiedAt: row.classified_at, approvedBy: row.approved_by, approvedAt: row.approved_at, approvalNote: row.approval_note,
      obligations, readiness: obligations.length ? Math.round((obligations.reduce((sum, item) => sum + Math.min(1, item.weight), 0) / obligations.length) * 100) : null,
      modelCard: latest ? { version: latest.version, sha256: latest.content_hash, savedAt: latest.created_at, content: JSON.parse(latest.content_json) as Record<string, string>, versions: mine.length } : null,
      fria: fria ? { status: fria.status, reviewedBy: fria.reviewed_by, content: JSON.parse(fria.content_json) as FriaContent } : null,
    });
  }
  const live = useCases.filter((item) => item.status !== "retired");
  return { useCases, summary: { total: live.length, high: live.filter((item) => item.tier === "high").length, prohibited: live.filter((item) => item.tier === "prohibited").length, unclassified: live.filter((item) => item.status === "draft").length, approved: live.filter((item) => item.status === "approved").length, awaitingApproval: live.filter((item) => item.status === "classified").length } };
}
