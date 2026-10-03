import "server-only";

import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/core/auth";
import { complianceSnapshot } from "@/lib/core/compliance-engine";
import { userError } from "@/lib/core/errors";
import { appendAudit } from "@/lib/core/integrity";
import { notify, type Severity } from "@/lib/core/notifications";
import { getDb } from "@/lib/db";

export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export const STATUSES = ["open", "in_progress", "blocked", "done", "cancelled"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type TaskStatus = (typeof STATUSES)[number];
const OPEN: TaskStatus[] = ["open", "in_progress", "blocked"];
const DAY = 86_400_000;

type TaskRow = {
  id: string;
  title: string;
  description: string;
  source_type: string;
  source_id: string | null;
  uc_code: string | null;
  assignee_id: string | null;
  created_by: string;
  priority: Priority;
  status: TaskStatus;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export const publicLink = (path: string) => `${(process.env.KONTROL_PUBLIC_URL ?? "").replace(/\/$/, "")}${path}`;

async function assignee(tenantId: string, userId: string | null | undefined) {
  if (!userId) return null;
  const user = await (
    await getDb()
  )
    .scope(tenantId)
    .get<{ id: string; email: string; name: string; status: string }>(
      "SELECT id, email, name, status FROM users WHERE tenant_id = ? AND id = ?",
      tenantId,
      userId,
    );
  if (!user) throw userError("Assignee not found");
  if (user.status !== "active") throw userError("Assignee is disabled");
  return user;
}

async function announceAssignment(
  actor: Actor,
  task: { id: string; title: string; priority: Priority; due_at: string | null },
  user: { id: string; email: string; name: string },
) {
  await notify(actor.tenantId, {
    type: "task.assigned",
    severity: task.priority,
    title: `Task assigned to ${user.name}: ${task.title}`,
    body: `${actor.name} assigned you a ${task.priority}-priority task${task.due_at ? `, due ${task.due_at.slice(0, 10)}` : ""}.`,
    link: publicLink("/tasks"),
    dedupeKey: `task.assigned:${task.id}:${user.id}`,
    payload: { taskId: task.id, assigneeId: user.id, assigneeEmail: user.email },
  });
}

export async function createTask(
  actor: Actor,
  input: {
    title: string;
    description?: string;
    priority: Priority;
    dueAt?: string;
    assigneeId?: string;
    sourceType?: string;
    sourceId?: string;
    ucCode?: string;
  },
) {
  const user = await assignee(actor.tenantId, input.assigneeId);
  if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) throw userError("Due date is invalid");
  const id = `task_${randomUUID()}`;
  const now = new Date().toISOString();
  await (await getDb()).scope(actor.tenantId).transaction(async (tx) => {
    await tx.run(
      "INSERT INTO tasks (id,tenant_id,title,description,source_type,source_id,uc_code,assignee_id,created_by,priority,status,due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      actor.tenantId,
      input.title.trim(),
      input.description ?? "",
      input.sourceType ?? "manual",
      input.sourceId ?? null,
      input.ucCode ?? null,
      user?.id ?? null,
      actor.userId,
      input.priority,
      "open",
      input.dueAt ?? null,
      now,
      now,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "task.created",
        objectType: "task",
        objectId: id,
        payload: {
          title: input.title,
          priority: input.priority,
          assigneeId: user?.id ?? null,
          sourceType: input.sourceType ?? "manual",
          sourceId: input.sourceId ?? null,
        },
      },
      tx,
    );
  });
  if (user) await announceAssignment(actor, { id, title: input.title, priority: input.priority, due_at: input.dueAt ?? null }, user);
  return { id };
}

export async function updateTask(
  actor: Actor,
  input: { id: string; status?: TaskStatus; assigneeId?: string | null; priority?: Priority; dueAt?: string | null; title?: string },
) {
  const db = (await getDb()).scope(actor.tenantId);
  const task = await db.get<TaskRow>("SELECT * FROM tasks WHERE tenant_id = ? AND id = ?", actor.tenantId, input.id);
  if (!task) throw userError("Task not found");
  const user = input.assigneeId === undefined ? undefined : await assignee(actor.tenantId, input.assigneeId);
  if (input.dueAt && Number.isNaN(Date.parse(input.dueAt))) throw userError("Due date is invalid");
  const status = input.status ?? task.status;
  const closing = !OPEN.includes(status);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE tasks SET title = ?, priority = ?, status = ?, assignee_id = ?, due_at = ?, updated_at = ?, closed_at = ? WHERE tenant_id = ? AND id = ?",
      input.title?.trim() || task.title,
      input.priority ?? task.priority,
      status,
      user === undefined ? task.assignee_id : (user?.id ?? null),
      input.dueAt === undefined ? task.due_at : input.dueAt,
      now,
      closing ? (task.closed_at ?? now) : null,
      actor.tenantId,
      task.id,
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "task.updated",
        objectType: "task",
        objectId: task.id,
        payload: {
          status: [task.status, status],
          assigneeId: user === undefined ? undefined : (user?.id ?? null),
          priority: input.priority,
        },
      },
      tx,
    );
  });
  if (user && user.id !== task.assignee_id)
    await announceAssignment(
      actor,
      {
        id: task.id,
        title: input.title ?? task.title,
        priority: input.priority ?? task.priority,
        due_at: input.dueAt === undefined ? task.due_at : input.dueAt,
      },
      user,
    );
  return { id: task.id, status };
}

export async function addComment(actor: Actor, input: { taskId: string; body: string }) {
  const db = (await getDb()).scope(actor.tenantId);
  if (!(await db.get("SELECT id FROM tasks WHERE tenant_id = ? AND id = ?", actor.tenantId, input.taskId)))
    throw userError("Task not found");
  const id = `tcm_${randomUUID()}`;
  await db.run(
    "INSERT INTO task_comments (id,tenant_id,task_id,author_id,body,created_at) VALUES (?,?,?,?,?,?)",
    id,
    actor.tenantId,
    input.taskId,
    actor.userId,
    input.body.trim(),
    new Date().toISOString(),
  );
  return { id };
}

export async function listTasks(tenantId: string, filter: { status?: string; assigneeId?: string; open?: boolean } = {}) {
  const clauses = ["t.tenant_id = ?"];
  const params: unknown[] = [tenantId];
  if (filter.status) {
    clauses.push("t.status = ?");
    params.push(filter.status);
  }
  if (filter.open) clauses.push("t.status IN ('open','in_progress','blocked')");
  if (filter.assigneeId) {
    clauses.push("t.assignee_id = ?");
    params.push(filter.assigneeId);
  }
  const db = (await getDb()).scope(tenantId);
  const rows = await db.all<TaskRow & { assignee_name: string | null }>(
    `SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE ${clauses.join(" AND ")} ORDER BY CASE t.status WHEN 'done' THEN 2 WHEN 'cancelled' THEN 3 ELSE 0 END, t.due_at IS NULL, t.due_at, t.created_at DESC LIMIT 500`,
    ...params,
  );
  const comments = await db.all<{ task_id: string; id: string; author_id: string; body: string; created_at: string }>(
    "SELECT task_id, id, author_id, body, created_at FROM task_comments WHERE tenant_id = ? ORDER BY created_at",
    tenantId,
  );
  const now = new Date().toISOString();
  return rows.map((row) => ({
    ...row,
    overdue: OPEN.includes(row.status) && row.due_at !== null && row.due_at < now,
    comments: comments.filter((comment) => comment.task_id === row.id),
  }));
}

/** Turns the highest-leverage gaps of the compliance roadmap into tasks, skipping controls that already have an open one. */
export async function createTasksFromRoadmap(actor: Actor, input: { limit: number }) {
  const snapshot = await complianceSnapshot(actor.tenantId);
  const existing = new Set(
    (
      await (
        await getDb()
      )
        .scope(actor.tenantId)
        .all<{ uc_code: string | null }>(
          "SELECT uc_code FROM tasks WHERE tenant_id = ? AND source_type = 'roadmap' AND status IN ('open','in_progress','blocked')",
          actor.tenantId,
        )
    ).map((row) => row.uc_code),
  );
  // Priority follows the roadmap rank across batches, so only the overall top three are ever high.
  const alreadyCreated = Number(
    (
      await (
        await getDb()
      )
        .scope(actor.tenantId)
        .get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE tenant_id = ? AND source_type = 'roadmap'", actor.tenantId)
    )?.n ?? 0,
  );
  const created: string[] = [];
  for (const [index, item] of snapshot.roadmap
    .filter((entry) => !existing.has(entry.code))
    .slice(0, input.limit)
    .entries()) {
    const task = await createTask(actor, {
      title: `Implement ${item.code}: ${item.title}`,
      description: `Advances ${item.closes.map((close) => `${close.requirements} requirement(s) in ${close.frameworkId}`).join(", ")}. Typical effort ${item.effort}/5, leverage ${item.leverage}.${item.verification === "failing" ? " Its machine evidence is currently failing." : ""}`,
      priority: alreadyCreated + index < 3 ? "high" : alreadyCreated + index < 8 ? "medium" : "low",
      dueAt: new Date(Date.now() + (item.effort >= 4 ? 90 : item.effort >= 3 ? 60 : 30) * DAY).toISOString(),
      sourceType: "roadmap",
      sourceId: item.code,
      ucCode: item.code,
    });
    created.push(task.id);
  }
  return { created: created.length, ids: created };
}

const SEVERITY_PRIORITY: Record<string, Priority> = { critical: "critical", high: "high", medium: "medium", low: "low" };

export async function createTaskFromFinding(actor: Actor, findingId: string) {
  const db = (await getDb()).scope(actor.tenantId);
  const finding = await db.get<{ id: string; title: string; severity: string; remediation: string; due_at: string | null; status: string }>(
    "SELECT id, title, severity, remediation, due_at, status FROM findings WHERE tenant_id = ? AND id = ?",
    actor.tenantId,
    findingId,
  );
  if (!finding) throw userError("Finding not found");
  if (!["open", "remediating"].includes(finding.status)) throw userError("Finding is already closed");
  if (
    await db.get(
      "SELECT id FROM tasks WHERE tenant_id = ? AND source_type = 'finding' AND source_id = ? AND status IN ('open','in_progress','blocked')",
      actor.tenantId,
      findingId,
    )
  )
    throw userError("An open task already exists for this finding (duplicate)");
  return createTask(actor, {
    title: `Remediate: ${finding.title}`,
    description: finding.remediation,
    priority: SEVERITY_PRIORITY[finding.severity] ?? "medium",
    dueAt: finding.due_at ?? undefined,
    sourceType: "finding",
    sourceId: finding.id,
  });
}

export const taskSeverity = (priority: Priority): Severity => priority;
