import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/core/database";
import { appendAudit, canonicalJson, sha256 } from "@/lib/core/integrity";

type Operator = "eq" | "neq" | "gte" | "lte" | "includes" | "exists";
type Condition = { path: string; op: Operator; value?: unknown };
type Policy = { all?: Condition[]; any?: Condition[] };

function getPath(input: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, input);
}

function testCondition(facts: Record<string, unknown>, condition: Condition) {
  const actual = getPath(facts, condition.path);
  switch (condition.op) {
    case "eq": return actual === condition.value;
    case "neq": return actual !== condition.value;
    case "gte": return typeof actual === "number" && typeof condition.value === "number" && actual >= condition.value;
    case "lte": return typeof actual === "number" && typeof condition.value === "number" && actual <= condition.value;
    case "includes": return Array.isArray(actual) ? actual.includes(condition.value) : typeof actual === "string" && actual.includes(String(condition.value));
    case "exists": return condition.value === false ? actual === undefined : actual !== undefined;
    default: return false;
  }
}

export function evaluatePolicy(policy: Policy, facts: Record<string, unknown>) {
  const allResults = (policy.all ?? []).map((condition) => ({ condition, actual: getPath(facts, condition.path), passed: testCondition(facts, condition) }));
  const anyResults = (policy.any ?? []).map((condition) => ({ condition, actual: getPath(facts, condition.path), passed: testCondition(facts, condition) }));
  const passed = allResults.every((result) => result.passed) && (anyResults.length === 0 || anyResults.some((result) => result.passed));
  return { passed, tests: [...allResults, ...anyResults], failed: [...allResults, ...anyResults].filter((result) => !result.passed) };
}

export function evaluateControl(actor: Actor, input: { controlCode: string; assetId: string; facts: Record<string, unknown>; source: string; periodStart?: string; periodEnd?: string }) {
  const db = getDb();
  const control = db.prepare("SELECT * FROM controls WHERE tenant_id = ? AND code = ? AND valid_to IS NULL").get(actor.tenantId, input.controlCode) as { id: string; code: string; title: string; objective: string; policy_json: string } | undefined;
  if (!control) throw new Error(`Control ${input.controlCode} not found`);
  const asset = db.prepare("SELECT id, name FROM assets WHERE tenant_id = ? AND id = ? AND valid_to IS NULL").get(actor.tenantId, input.assetId) as { id: string; name: string } | undefined;
  if (!asset) throw new Error(`Asset ${input.assetId} not found`);

  const evaluatedAt = new Date().toISOString();
  const result = evaluatePolicy(JSON.parse(control.policy_json) as Policy, input.facts);
  const evidenceId = `evidence_${randomUUID()}`;
  const evidencePayload = { control: control.code, asset: asset.id, facts: input.facts, result, evaluatedAt };
  const content = canonicalJson(evidencePayload);

  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO evidence (id,tenant_id,control_id,asset_id,name,source,collection_method,content_type,content_json,content_hash,period_start,period_end,collected_at,expires_at,status,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      evidenceId, actor.tenantId, control.id, asset.id, `${control.title} evaluation`, input.source, "automated policy evaluation", "application/vnd.kontrol.control-result+json", content, sha256(content), input.periodStart ?? null, input.periodEnd ?? null, evaluatedAt, new Date(Date.now() + 86_400_000).toISOString(), result.passed ? "healthy" : "failed", actor.userId,
    );

    if (!result.passed) {
      const existing = db.prepare("SELECT id FROM findings WHERE tenant_id = ? AND control_id = ? AND asset_id = ? AND status IN ('open','remediating') LIMIT 1").get(actor.tenantId, control.id, asset.id) as { id: string } | undefined;
      if (existing) {
        db.prepare("UPDATE findings SET evidence_id = ?, reason = ?, opened_at = ? WHERE id = ?").run(evidenceId, JSON.stringify(result.failed), evaluatedAt, existing.id);
        return existing.id;
      }
      const findingId = `finding_${randomUUID()}`;
      db.prepare(`INSERT INTO findings (id,tenant_id,control_id,asset_id,evidence_id,title,severity,status,reason,remediation,owner_id,due_at,opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        findingId, actor.tenantId, control.id, asset.id, evidenceId, `${control.title} failed on ${asset.name}`, "high", "open", JSON.stringify(result.failed), `Remediate failed policy conditions for ${control.code}, then trigger a re-test.`, actor.userId, new Date(Date.now() + 14 * 86_400_000).toISOString(), evaluatedAt,
      );
      return findingId;
    }

    const openFindings = db.prepare("SELECT id FROM findings WHERE tenant_id = ? AND control_id = ? AND asset_id = ? AND status IN ('open','remediating')").all(actor.tenantId, control.id, asset.id) as Array<{ id: string }>;
    for (const finding of openFindings) db.prepare("UPDATE findings SET status = 'closed', closed_at = ?, evidence_id = ? WHERE id = ?").run(evaluatedAt, evidenceId, finding.id);
    return openFindings.map((finding) => finding.id);
  });

  const finding = transaction();
  appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "control.evaluated", objectType: "control", objectId: control.id, payload: { assetId: asset.id, evidenceId, result, finding } });
  return { control: { id: control.id, code: control.code, title: control.title }, asset, evidenceId, finding, ...result, evaluatedAt };
}
