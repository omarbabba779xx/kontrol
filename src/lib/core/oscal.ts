import "server-only";

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";

export async function exportOscalAssessmentResults(tenantId: string) {
  const db = (await getDb()).scope(tenantId);
  const tenant = (await db.get<{ name: string }>("SELECT * FROM tenants WHERE id = ?", tenantId)) ?? { name: tenantId };
  const evidence = await db.all<Record<string, unknown>>("SELECT * FROM evidence WHERE tenant_id = ? ORDER BY collected_at DESC", tenantId);
  const findings = await db.all<Record<string, unknown>>("SELECT * FROM findings WHERE tenant_id = ? ORDER BY opened_at DESC", tenantId);
  const controls = await db.all<Record<string, unknown>>("SELECT * FROM controls WHERE tenant_id = ? AND valid_to IS NULL", tenantId);
  const now = new Date().toISOString();

  return {
    "assessment-results": {
      uuid: randomUUID(),
      metadata: {
        title: `${tenant.name} continuous assessment results`,
        "last-modified": now,
        version: now.slice(0, 10),
        "oscal-version": "1.1.3",
        roles: [{ id: "control-owner", title: "Control Owner" }, { id: "assessor", title: "Continuous Assessment Engine" }],
      },
      "import-ap": { href: "#kontrol-continuous-assessment-plan" },
      results: [{
        uuid: randomUUID(),
        title: "Kontrol continuous monitoring snapshot",
        description: "Machine-generated assessment result with evidence provenance and control findings.",
        start: evidence.at(-1)?.collected_at ?? now,
        end: now,
        "reviewed-controls": { "control-selections": [{ "include-controls": controls.map((control) => ({ "control-id": String(control.code) })) }] },
        observations: evidence.map((item) => ({
          uuid: randomUUID(), title: String(item.name), description: `Collected by ${item.collection_method} from ${item.source}`,
          methods: ["TEST"], collected: item.collected_at, expires: item.expires_at,
          props: [{ name: "content-hash", value: item.content_hash }, { name: "status", value: item.status }],
          "relevant-evidence": [{ href: `urn:kontrol:evidence:${item.id}`, description: `Integrity hash ${item.content_hash}` }],
        })),
        findings: findings.map((finding) => ({
          uuid: randomUUID(), title: String(finding.title), description: String(finding.reason),
          target: { type: "objective-id", "target-id": String(finding.control_id), status: { state: finding.status === "closed" ? "satisfied" : "not-satisfied" } },
          "related-observations": finding.evidence_id ? [{ "observation-uuid": String(finding.evidence_id) }] : [],
        })),
        risks: findings.filter((finding) => finding.status !== "closed").map((finding) => ({
          uuid: randomUUID(), title: String(finding.title), description: String(finding.reason), statement: String(finding.remediation), status: "open",
          characterizations: [{ origin: { actors: [{ type: "tool", "actor-uuid": "kontrol-policy-engine" }] }, facets: [{ name: "impact", system: "https://kontrol.dev/risk", value: String(finding.severity) }] }],
        })),
      }],
      "back-matter": { resources: evidence.map((item) => ({ uuid: randomUUID(), title: String(item.name), description: String(item.source), rlinks: [{ href: `urn:kontrol:evidence:${item.id}`, "media-type": String(item.content_type) }] })) },
    },
  };
}
