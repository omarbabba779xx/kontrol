import "server-only";

import { getDb } from "@/lib/db";

/**
 * Operational metrics in the Prometheus text format. They are aggregates (counts and ages), never record contents, and are served
 * only with the bearer token in KONTROL_METRICS_TOKEN: without it the endpoint does not exist. Alert on:
 *   kontrol_collections_failing > 0           a connector has failed several times in a row
 *   kontrol_collection_oldest_success_seconds a collection has not succeeded for longer than its schedule allows
 *   kontrol_workflows_waiting_oldest_seconds  a workflow has waited too long for approval
 *   kontrol_notifications{status="dead"} > 0  an alert could not be delivered
 */
type Sample = { name: string; labels?: Record<string, string>; value: number };
const HELP: Record<string, [string, string]> = {
  kontrol_up: ["gauge", "The application can reach its database."],
  kontrol_schedules: ["gauge", "Collection schedules by state."],
  kontrol_collections_failing: ["gauge", "Schedules with at least three consecutive failures."],
  kontrol_collection_oldest_success_seconds: ["gauge", "Age of the oldest last-success among enabled schedules, per tenant."],
  kontrol_findings_open: ["gauge", "Open findings by severity."],
  kontrol_workflows: ["gauge", "Workflows by state."],
  kontrol_workflows_waiting_oldest_seconds: ["gauge", "Age of the longest-waiting workflow that needs approval."],
  kontrol_notifications: ["gauge", "Notifications by delivery status."],
  kontrol_audit_entries: ["gauge", "Audit log entries per tenant."],
};

const escapeLabel = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");

export function render(samples: Sample[]) {
  const names = [...new Set(samples.map((sample) => sample.name))];
  return (
    names
      .flatMap((name) => [
        `# HELP ${name} ${HELP[name]?.[1] ?? name}`,
        `# TYPE ${name} ${HELP[name]?.[0] ?? "gauge"}`,
        ...samples
          .filter((sample) => sample.name === name)
          .map((sample) => {
            const labels = Object.entries(sample.labels ?? {})
              .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
              .join(",");
            return `${name}${labels ? `{${labels}}` : ""} ${Number.isFinite(sample.value) ? sample.value : 0}`;
          }),
      ])
      .join("\n") + "\n"
  );
}

export async function collectMetrics(now = Date.now()) {
  const system = (await getDb()).system();
  const samples: Sample[] = [];
  const age = (iso: string | null) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : 0);
  await system.get("SELECT 1 AS ok");
  samples.push({ name: "kontrol_up", value: 1 });

  for (const row of await system.all<{ tenant_id: string; enabled: number | string; failing: number | string; total: number | string }>(
    "SELECT tenant_id, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled, SUM(CASE WHEN consecutive_failures >= 3 THEN 1 ELSE 0 END) AS failing, COUNT(*) AS total FROM connector_schedules GROUP BY tenant_id",
  )) {
    samples.push({ name: "kontrol_schedules", labels: { tenant: row.tenant_id, state: "enabled" }, value: Number(row.enabled) });
    samples.push({ name: "kontrol_schedules", labels: { tenant: row.tenant_id, state: "total" }, value: Number(row.total) });
    samples.push({ name: "kontrol_collections_failing", labels: { tenant: row.tenant_id }, value: Number(row.failing) });
  }
  for (const row of await system.all<{ tenant_id: string; oldest: string | null }>(
    "SELECT tenant_id, MIN(COALESCE(last_run_at, next_run_at)) AS oldest FROM connector_schedules WHERE enabled = 1 AND COALESCE(last_status, 'ok') = 'ok' GROUP BY tenant_id",
  )) {
    samples.push({ name: "kontrol_collection_oldest_success_seconds", labels: { tenant: row.tenant_id }, value: age(row.oldest) });
  }
  for (const row of await system.all<{ tenant_id: string; severity: string; n: number | string }>(
    "SELECT tenant_id, severity, COUNT(*) AS n FROM findings WHERE status IN ('open','remediating') GROUP BY tenant_id, severity",
  )) {
    samples.push({ name: "kontrol_findings_open", labels: { tenant: row.tenant_id, severity: row.severity }, value: Number(row.n) });
  }
  for (const row of await system.all<{ tenant_id: string; state: string; n: number | string }>(
    "SELECT tenant_id, state, COUNT(*) AS n FROM workflows GROUP BY tenant_id, state",
  )) {
    samples.push({ name: "kontrol_workflows", labels: { tenant: row.tenant_id, state: row.state }, value: Number(row.n) });
  }
  for (const row of await system.all<{ tenant_id: string; oldest: string | null }>(
    "SELECT tenant_id, MIN(updated_at) AS oldest FROM workflows WHERE state = 'awaiting_approval' GROUP BY tenant_id",
  )) {
    samples.push({ name: "kontrol_workflows_waiting_oldest_seconds", labels: { tenant: row.tenant_id }, value: age(row.oldest) });
  }
  for (const row of await system.all<{ tenant_id: string; status: string; n: number | string }>(
    "SELECT tenant_id, status, COUNT(*) AS n FROM notifications GROUP BY tenant_id, status",
  )) {
    samples.push({ name: "kontrol_notifications", labels: { tenant: row.tenant_id, status: row.status }, value: Number(row.n) });
  }
  for (const row of await system.all<{ tenant_id: string; n: number | string }>(
    "SELECT tenant_id, COUNT(*) AS n FROM audit_log GROUP BY tenant_id",
  )) {
    samples.push({ name: "kontrol_audit_entries", labels: { tenant: row.tenant_id }, value: Number(row.n) });
  }
  return render(samples);
}
