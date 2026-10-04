import "server-only";

import { userError } from "@/lib/core/errors";
import { getDb } from "@/lib/db";

/**
 * One way to read any long list: a page of rows, the total, and where the page sits. The pages of the application show the first
 * rows of each list; an organisation with more than that reads the rest here, so nothing is ever cut off without saying so.
 *
 * The collections, their columns and their order are fixed in this file: nothing from the request reaches the SQL text.
 */
type Collection = { table: string; columns: string; order: string; filters: Record<string, string>; permission: "graph:read" | "evidence:read" };

export const COLLECTIONS = {
  risks: { table: "risk_items", columns: "id, ref, title, category, asset, owner_id, likelihood, impact, treatment, status, target_date, accepted_until, threat_id, updated_at", order: "ref", filters: { status: "status", category: "category", owner: "owner_id" }, permission: "graph:read" },
  tasks: { table: "tasks", columns: "id, title, source_type, source_id, uc_code, assignee_id, priority, status, due_at, created_at, completed_at", order: "created_at DESC, id", filters: { status: "status", assignee: "assignee_id", source: "source_type" }, permission: "graph:read" },
  nonconformities: { table: "isms_nonconformities", columns: "id, ref, source, severity, title, requirement, uc_code, owner_id, due_at, status, audit_id, incident_id, raised_at, verified_at", order: "raised_at DESC, id", filters: { status: "status", severity: "severity", source: "source" }, permission: "graph:read" },
  incidents: { table: "isms_incidents", columns: "id, ref, title, severity, status, detected_at, asset_id, personal_data, notification_due, notified_at, owner_id, nonconformity_id, closed_at", order: "detected_at DESC, id", filters: { status: "status", severity: "severity" }, permission: "graph:read" },
  context: { table: "isms_context", columns: "id, kind, title, detail, requirement, updated_at", order: "kind, title, id", filters: { kind: "kind" }, permission: "graph:read" },
  objectives: { table: "isms_objectives", columns: "id, title, measure, target, current_value, owner_id, due_at, status, measured_at", order: "due_at, id", filters: { status: "status" }, permission: "graph:read" },
  records: { table: "isms_records", columns: "id, kind, title, detail_json, status, owner_id, due_at, updated_at", order: "kind, updated_at DESC, id", filters: { kind: "kind", status: "status" }, permission: "graph:read" },
  evidence: { table: "evidence", columns: "id, control_id, asset_id, name, source, collection_method, content_hash, collected_at, expires_at, status", order: "collected_at DESC, id", filters: { status: "status", control: "control_id", asset: "asset_id" }, permission: "evidence:read" },
  policies: { table: "policy_register", columns: "id, title, version, owner_id, status, approved_at, next_review, updated_at", order: "updated_at DESC, id", filters: { status: "status" }, permission: "graph:read" },
  exceptions: { table: "compliance_exceptions", columns: "id, uc_code, title, risk_level, requested_by, approved_by, status, expires_at, created_at", order: "created_at DESC, id", filters: { status: "status", control: "uc_code" }, permission: "graph:read" },
} as const satisfies Record<string, Collection>;

export type CollectionName = keyof typeof COLLECTIONS;
export const MAX_PAGE = 200;

export async function page(tenantId: string, name: string, input: { limit?: number; offset?: number; filters?: Record<string, string> } = {}) {
  const collection = (COLLECTIONS as Record<string, Collection>)[name];
  if (!collection) throw userError(`Collection ${name} not found`);
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const clauses = ["tenant_id = ?"];
  const params: unknown[] = [tenantId];
  for (const [key, value] of Object.entries(input.filters ?? {})) {
    const column = collection.filters[key];
    if (!column) throw userError(`${name} cannot be filtered by ${key}; use ${Object.keys(collection.filters).join(", ")}`);
    clauses.push(`${column} = ?`);
    params.push(value);
  }
  const where = clauses.join(" AND ");
  const db = (await getDb()).scope(tenantId);
  const total = Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${collection.table} WHERE ${where}`, ...params))?.n ?? 0);
  const items = await db.all<Record<string, unknown>>(`SELECT ${collection.columns} FROM ${collection.table} WHERE ${where} ORDER BY ${collection.order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { collection: name, items, total, limit, offset, next: offset + items.length < total ? offset + items.length : null };
}
