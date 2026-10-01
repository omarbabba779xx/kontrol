import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/db";
import { appendAudit, canonicalJson, sha256 } from "@/lib/core/integrity";
import { crossCheckWithOpa } from "@/lib/core/opa";

export type Operator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "not_in" | "includes" | "exists" | "not_exists" | "length_gte" | "length_lte" | "matches" | "within_days" | "older_than_days";
export type Condition = { path: string; op: Operator; value?: unknown };
/** `all` must hold, at least one of `any` must hold (when present) and none of `none` may hold. */
export type Policy = { all?: Condition[]; any?: Condition[]; none?: Condition[] };

const DAY_MS = 86_400_000;
const MAX_PATTERN = 120;
const MAX_SUBJECT = 10_000;

function getPath(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, input);
}

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Structural equality, so arrays and objects compare by value (as they do in Rego), never by reference. */
function same(left: unknown, right: unknown): boolean {
  return left === right || (left !== null && right !== null && typeof left === "object" && typeof right === "object" && canonicalJson(left) === canonicalJson(right));
}

/** Rejects patterns that are long or that nest quantifiers, the classic source of catastrophic backtracking. */
function safeRegex(pattern: unknown): RegExp | null {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN) return null;
  // No back-references, no quantified groups, no stacked quantifiers.
  if (/\\[1-9]/.test(pattern) || /\)\s*[*+?{]/.test(pattern) || /[*+?}]\s*[*+{]/.test(pattern)) return null;
  try { return new RegExp(pattern); } catch { return null; }
}

function timestamp(value: unknown): number | null {
  if (isNumber(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Every operator fails closed: a missing fact, a wrong type or a malformed expectation never passes. */
export function testCondition(facts: Record<string, unknown>, condition: Condition, now = Date.now()) {
  const actual = getPath(facts, condition.path);
  const expected = condition.value;
  switch (condition.op) {
    case "eq": return actual !== undefined && same(actual, expected);
    case "neq": return actual !== undefined && !same(actual, expected);
    case "gt": return isNumber(actual) && isNumber(expected) && actual > expected;
    case "gte": return isNumber(actual) && isNumber(expected) && actual >= expected;
    case "lt": return isNumber(actual) && isNumber(expected) && actual < expected;
    case "lte": return isNumber(actual) && isNumber(expected) && actual <= expected;
    case "between": return isNumber(actual) && Array.isArray(expected) && expected.length === 2 && isNumber(expected[0]) && isNumber(expected[1]) && actual >= expected[0] && actual <= expected[1];
    case "in": return Array.isArray(expected) && actual !== undefined && expected.some((item) => same(item, actual));
    case "not_in": return Array.isArray(expected) && actual !== undefined && !expected.some((item) => same(item, actual));
    case "includes": return Array.isArray(actual) ? actual.some((item) => same(item, expected)) : typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "exists": return expected === false ? actual === undefined : actual !== undefined;
    case "not_exists": return actual === undefined;
    case "length_gte": return (Array.isArray(actual) || typeof actual === "string") && isNumber(expected) && actual.length >= expected;
    case "length_lte": return (Array.isArray(actual) || typeof actual === "string") && isNumber(expected) && actual.length <= expected;
    case "matches": { const pattern = safeRegex(expected); return pattern !== null && typeof actual === "string" && actual.length <= MAX_SUBJECT && pattern.test(actual); }
    case "within_days": { const at = timestamp(actual); return at !== null && isNumber(expected) && expected >= 0 && at <= now && now - at <= expected * DAY_MS; }
    case "older_than_days": { const at = timestamp(actual); return at !== null && isNumber(expected) && expected >= 0 && now - at > expected * DAY_MS; }
    default: return false;
  }
}

export function evaluatePolicy(policy: Policy, facts: Record<string, unknown>, now = Date.now()) {
  const run = (conditions: Condition[] | undefined) => (conditions ?? []).map((condition) => ({ condition, actual: getPath(facts, condition.path), passed: testCondition(facts, condition, now) }));
  const allResults = run(policy.all);
  const anyResults = run(policy.any);
  const noneResults = run(policy.none).map((result) => ({ ...result, passed: !result.passed }));
  const passed = allResults.every((result) => result.passed) && (anyResults.length === 0 || anyResults.some((result) => result.passed)) && noneResults.every((result) => result.passed);
  const tests = [...allResults, ...anyResults, ...noneResults];
  // For an `any` group the individual misses only matter when the whole group failed.
  const anyFailed = anyResults.length === 0 || anyResults.some((result) => result.passed) ? [] : anyResults;
  return { passed, tests, failed: [...allResults.filter((result) => !result.passed), ...anyFailed, ...noneResults.filter((result) => !result.passed)] };
}

export async function evaluateControl(actor: Actor, input: { controlCode: string; assetId: string; facts: Record<string, unknown>; source: string; periodStart?: string; periodEnd?: string; /** How long the evidence stays current; defaults to one day. */ validForDays?: number }) {
  const db = (await getDb()).scope(actor.tenantId);
  const control = await db.get<{ id: string; code: string; title: string; objective: string; policy_json: string }>("SELECT * FROM controls WHERE tenant_id = ? AND code = ? AND valid_to IS NULL", actor.tenantId, input.controlCode);
  if (!control) throw new Error(`Control ${input.controlCode} not found`);
  const asset = await db.get<{ id: string; name: string }>("SELECT id, name FROM assets WHERE tenant_id = ? AND id = ? AND valid_to IS NULL", actor.tenantId, input.assetId);
  if (!asset) throw new Error(`Asset ${input.assetId} not found`);

  const nowMs = Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();
  const policy = JSON.parse(control.policy_json) as Policy;
  const result = evaluatePolicy(policy, input.facts, nowMs);
  const opa = await crossCheckWithOpa(policy, input.facts, nowMs, result.passed);
  const evidenceId = `evidence_${randomUUID()}`;
  const evidencePayload = { control: control.code, asset: asset.id, facts: input.facts, result, opa, evaluatedAt };
  const content = canonicalJson(evidencePayload);

  const finding = await db.transaction(async (tx) => {
    await tx.run(`INSERT INTO evidence (id,tenant_id,control_id,asset_id,name,source,collection_method,content_type,content_json,content_hash,period_start,period_end,collected_at,expires_at,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      evidenceId, actor.tenantId, control.id, asset.id, `${control.title} evaluation`, input.source, "automated policy evaluation", "application/vnd.kontrol.control-result+json", content, sha256(content), input.periodStart ?? null, input.periodEnd ?? null, evaluatedAt, new Date(nowMs + Math.max(1, input.validForDays ?? 1) * 86_400_000).toISOString(), result.passed ? "healthy" : "failed", actor.userId);

    let outcome: string | string[];
    if (!result.passed) {
      const existing = await tx.get<{ id: string }>("SELECT id FROM findings WHERE tenant_id = ? AND control_id = ? AND asset_id = ? AND status IN ('open','remediating') LIMIT 1", actor.tenantId, control.id, asset.id);
      if (existing) {
        await tx.run("UPDATE findings SET evidence_id = ?, reason = ?, opened_at = ? WHERE id = ?", evidenceId, JSON.stringify(result.failed), evaluatedAt, existing.id);
        outcome = existing.id;
      } else {
        const findingId = `finding_${randomUUID()}`;
        await tx.run(`INSERT INTO findings (id,tenant_id,control_id,asset_id,evidence_id,title,severity,status,reason,remediation,owner_id,due_at,opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          findingId, actor.tenantId, control.id, asset.id, evidenceId, `${control.title} failed on ${asset.name}`, "high", "open", JSON.stringify(result.failed), `Remediate failed policy conditions for ${control.code}, then trigger a re-test.`, actor.userId, new Date(Date.now() + 14 * 86_400_000).toISOString(), evaluatedAt);
        outcome = findingId;
      }
    } else {
      const openFindings = await tx.all<{ id: string }>("SELECT id FROM findings WHERE tenant_id = ? AND control_id = ? AND asset_id = ? AND status IN ('open','remediating')", actor.tenantId, control.id, asset.id);
      for (const item of openFindings) await tx.run("UPDATE findings SET status = 'closed', closed_at = ?, evidence_id = ? WHERE id = ?", evaluatedAt, evidenceId, item.id);
      outcome = openFindings.map((item) => item.id);
    }
    if (opa.status === "disagree") {
      // Two independent engines disagree on the same policy and facts: surface it for investigation.
      const fingerprint = sha256(`policy-divergence:${control.id}:${asset.id}:${result.passed}:${opa.opaPassed}`);
      await tx.run(`INSERT INTO drift_events (id,tenant_id,fingerprint,kind,subject_type,subject_id,severity,title,details_json,status,detected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(tenant_id, fingerprint) DO UPDATE SET detected_at = excluded.detected_at, status = 'open'`,
        `drift_${randomUUID()}`, actor.tenantId, fingerprint, "policy_engine_divergence", "control", control.id, "high", `Policy engines disagree on ${control.code}`, JSON.stringify({ evidenceId, local: result.passed, opa: opa.opaPassed, asset: asset.id }), "open", evaluatedAt);
    }
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "control.evaluated", objectType: "control", objectId: control.id, payload: { assetId: asset.id, evidenceId, result, opa: opa.status, finding: outcome } }, tx);
    return outcome;
  });

  return { control: { id: control.id, code: control.code, title: control.title }, asset, evidenceId, finding, ...result, opa, evaluatedAt };
}
