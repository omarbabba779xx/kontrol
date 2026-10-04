import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { UserError, userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import type { FrameworkId } from "@/lib/frameworks/types";
import { getDb } from "@/lib/db";

/**
 * Target capability levels. COBIT 2019 does not ask every objective to reach the same level: the organisation decides, objective by
 * objective, how capable each process needs to be (that is what its design factors are for). The decision is recorded here, with its
 * reason, and the framework view reports the gap between the level reached and the level aimed for. The same works for any framework.
 *
 * A target of 0 means the objective is deliberately not pursued; it still shows in the list, with the reason.
 */
const db = async (tenantId: string) => (await getDb()).scope(tenantId);

export async function setCapabilityTargets(actor: Actor, input: { frameworkId: FrameworkId; targets: Array<{ requirementId: string; target: number }>; rationale: string }) {
  if (actor.role !== "admin") throw new UserError("Only an administrator can set capability targets: it is a management decision", 403);
  const framework = FRAMEWORK_BY_ID.get(input.frameworkId);
  if (!framework) throw userError(`Framework ${input.frameworkId} not found`);
  const known = new Set(framework.requirements.map((requirement) => requirement.id));
  for (const item of input.targets) {
    if (!known.has(item.requirementId)) throw userError(`Requirement ${item.requirementId} not found in ${framework.name}`);
    if (!Number.isInteger(item.target) || item.target < 0 || item.target > 5) throw userError("A capability target is between 0 and 5");
  }
  const scope = await db(actor.tenantId);
  const now = new Date().toISOString();
  await scope.transaction(async (tx) => {
    for (const item of input.targets) {
      await tx.run(
        "INSERT INTO capability_targets (id,tenant_id,framework_id,requirement_id,target,rationale,set_by,set_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id, framework_id, requirement_id) DO UPDATE SET target = excluded.target, rationale = excluded.rationale, set_by = excluded.set_by, set_at = excluded.set_at",
        `cap_${randomUUID()}`, actor.tenantId, input.frameworkId, item.requirementId, item.target, input.rationale.trim(), actor.userId, now);
    }
    await appendAudit({ tenantId: actor.tenantId, actorId: actor.userId, action: "compliance.capability_targets_set", objectType: "framework", objectId: input.frameworkId, payload: { targets: input.targets, rationale: input.rationale.trim() } }, tx);
  });
  return { frameworkId: input.frameworkId, set: input.targets.length };
}

export async function capabilityTargetsOf(tenantId: string, frameworkId: FrameworkId) {
  const rows = await (await db(tenantId)).all<{ requirement_id: string; target: number; rationale: string }>("SELECT requirement_id, target, rationale FROM capability_targets WHERE tenant_id = ? AND framework_id = ?", tenantId, frameworkId);
  return new Map(rows.map((row) => [row.requirement_id, { target: Number(row.target), rationale: row.rationale }]));
}

/** Reads the levels reached against the levels aimed for. A requirement with no target is not part of the gap. */
export function capabilityGap(requirements: Array<{ id: string; capability?: number | null }>, targets: Map<string, { target: number; rationale: string }>) {
  const rows = requirements.filter((requirement) => targets.has(requirement.id)).map((requirement) => {
    const target = targets.get(requirement.id)!.target;
    // No assessed level (no control, or out of scope) counts as level 0 against a target: a target cannot be met by nothing.
    const reached = typeof requirement.capability === "number" ? requirement.capability : 0;
    return { id: requirement.id, target, reached, gap: Math.max(0, target - reached) };
  });
  return {
    targeted: rows.length,
    met: rows.filter((row) => row.gap === 0).length,
    below: rows.filter((row) => row.gap > 0).sort((a, b) => b.gap - a.gap || a.id.localeCompare(b.id)),
    totalGap: rows.reduce((sum, row) => sum + row.gap, 0),
  };
}
