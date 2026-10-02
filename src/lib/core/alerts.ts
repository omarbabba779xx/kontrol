import "server-only";

import { deliverPending, notify, type DeliveryDeps, type Severity } from "@/lib/core/notifications";
import { onScheduleFailing, onScheduleRecovered } from "@/lib/core/scheduler";
import { publicLink } from "@/lib/core/tasks";
import { getDb } from "@/lib/db";

/**
 * Turns the state of the platform into notifications. Every alert has a deduplication key naming the object and the
 * state it is in, so a condition raises one notification, not one per scan; overdue work is repeated weekly.
 */
const DAY = 86_400_000;
const isoWeek = (at: number) => `${new Date(at).getUTCFullYear()}-w${Math.floor((at - Date.UTC(new Date(at).getUTCFullYear(), 0, 1)) / (7 * DAY))}`;
const escalate = (severity: Severity): Severity => (severity === "low" ? "medium" : severity === "medium" ? "high" : "critical");

export async function scanAndNotify(tenantId: string, now = Date.now()) {
  const db = (await getDb()).scope(tenantId);
  const iso = new Date(now).toISOString();
  const soon = new Date(now + 14 * DAY).toISOString();
  let queued = 0;
  const send = async (event: Parameters<typeof notify>[1]) => { queued += await notify(tenantId, event); };

  for (const task of await db.all<{ id: string; title: string; priority: Severity; due_at: string; email: string | null; name: string | null }>(
    "SELECT t.id, t.title, t.priority, t.due_at, u.email, u.name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id = ? AND t.status IN ('open','in_progress','blocked') AND t.due_at IS NOT NULL AND t.due_at < ?", tenantId, iso)) {
    await send({ type: "task.overdue", severity: escalate(task.priority), title: `Overdue: ${task.title}`, body: `Due ${task.due_at.slice(0, 10)}${task.name ? `, assigned to ${task.name}` : ", unassigned"}.`, link: publicLink("/tasks"), dedupeKey: `task.overdue:${task.id}:${isoWeek(now)}`, payload: { taskId: task.id, assigneeEmail: task.email } });
  }

  for (const row of await db.all<{ id: string; uc_code: string; title: string; expires_at: string }>("SELECT id, uc_code, title, expires_at FROM compliance_exceptions WHERE tenant_id = ? AND status = 'approved' AND expires_at > ? AND expires_at < ?", tenantId, iso, soon)) {
    await send({ type: "exception.expiring", severity: "medium", title: `Risk acceptance expires ${row.expires_at.slice(0, 10)}: ${row.title}`, body: `${row.uc_code} loses its risk acceptance. Re-approve it or close the gap.`, link: publicLink("/compliance"), dedupeKey: `exception.expiring:${row.id}` });
  }
  for (const row of await db.all<{ id: string; uc_code: string; title: string }>("SELECT id, uc_code, title FROM compliance_exceptions WHERE tenant_id = ? AND status = 'pending' AND created_at < ?", tenantId, new Date(now - 2 * DAY).toISOString())) {
    await send({ type: "exception.pending", severity: "medium", title: `Risk acceptance awaiting a decision: ${row.title}`, body: `${row.uc_code}: pending for more than two days.`, link: publicLink("/compliance"), dedupeKey: `exception.pending:${row.id}:${isoWeek(now)}` });
  }

  for (const row of await db.all<{ uc_code: string; review_due: string; status: string }>("SELECT uc_code, review_due, status FROM control_implementations WHERE tenant_id = ? AND status IN ('implemented','partial','planned') AND review_due IS NOT NULL AND review_due < ?", tenantId, soon)) {
    const expired = row.review_due < iso;
    await send({ type: expired ? "attestation.expired" : "attestation.expiring", severity: expired ? "high" : "low", title: `${row.uc_code}: attestation ${expired ? "expired" : "expires soon"}`, body: `Review due ${row.review_due.slice(0, 10)}. ${expired ? "The control counts as partial until it is re-attested." : "Re-attest it to keep full credit."}`, link: publicLink("/compliance"), dedupeKey: `attestation:${row.uc_code}:${row.review_due}:${expired ? "expired" : "expiring"}` });
  }

  for (const row of await db.all<{ id: string; title: string; uc_code: string }>("SELECT id, title, uc_code FROM control_evidence WHERE tenant_id = ? AND status = 'pending' AND uploaded_at < ?", tenantId, new Date(now - 2 * DAY).toISOString())) {
    await send({ type: "evidence.pending_review", severity: "low", title: `Evidence awaiting review: ${row.title}`, body: `${row.uc_code}: uploaded more than two days ago.`, link: publicLink("/compliance"), dedupeKey: `evidence.pending:${row.id}:${isoWeek(now)}` });
  }

  for (const row of await db.all<{ id: string; title: string; next_review: string }>("SELECT id, title, next_review FROM policy_register WHERE tenant_id = ? AND status = 'approved' AND next_review IS NOT NULL AND next_review < ?", tenantId, iso)) {
    await send({ type: "policy.review_overdue", severity: "medium", title: `Policy review overdue: ${row.title}`, body: `Review was due ${row.next_review.slice(0, 10)}.`, link: publicLink("/compliance"), dedupeKey: `policy.review:${row.id}:${row.next_review}` });
  }

  for (const row of await db.all<{ id: string; title: string; severity: Severity }>("SELECT id, title, severity FROM findings WHERE tenant_id = ? AND status = 'open' AND severity IN ('high','critical') AND opened_at > ?", tenantId, new Date(now - 2 * DAY).toISOString())) {
    await send({ type: "finding.opened", severity: row.severity, title: `New ${row.severity} finding: ${row.title}`, body: "A control evaluation failed. Create a remediation task and assign an owner.", link: publicLink("/controls"), dedupeKey: `finding.opened:${row.id}` });
  }
  return { queued };
}

/** Scans every tenant, then delivers what is due. Meant for the scheduler tick and the jobs endpoint. */
export async function runMaintenance(options: DeliveryDeps & { now?: number } = {}) {
  const now = options.now ?? Date.now();
  const tenants = await (await getDb()).system().all<{ id: string }>("SELECT id FROM tenants");
  let queued = 0;
  for (const tenant of tenants) queued += (await scanAndNotify(tenant.id, now)).queued;
  const delivered = await deliverPending({ ...options, now });
  return { queued, delivered: delivered.filter((item) => item.status === "sent").length, failed: delivered.filter((item) => item.status !== "sent").length };
}

let registered = false;
/** Connects scheduler outcomes to the notification system. Idempotent. */
export function registerNotificationHooks() {
  if (registered) return;
  registered = true;
  onScheduleFailing((event) => notify(event.tenantId, { type: "connector.failing", severity: "high", title: `${event.kind} collection is failing`, body: `${event.failures} failures in a row${event.target ? ` for ${event.target}` : ""}: ${event.error}`, link: publicLink("/admin"), dedupeKey: `connector.failing:${event.kind}:${event.target}:${Math.floor(Date.now() / DAY)}` }).then(() => undefined));
  onScheduleRecovered((event) => notify(event.tenantId, { type: "connector.recovered", severity: "low", title: `${event.kind} collection recovered`, body: `Collection works again${event.target ? ` for ${event.target}` : ""}.`, link: publicLink("/admin"), dedupeKey: `connector.recovered:${event.kind}:${event.target}:${Date.now()}` }).then(() => undefined));
}
registerNotificationHooks();
