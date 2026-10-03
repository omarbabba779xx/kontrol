import "server-only";

import type { Actor } from "@/lib/core/auth";
import { appendAudit } from "@/lib/core/integrity";
import type { FrameworkId, ImplementationStatus } from "@/lib/frameworks/types";
import { UNIFIED_CONTROLS } from "@/lib/frameworks/unified";
import { randomUUID } from "node:crypto";
import { CSV_RISKY } from "@/lib/core/compliance/actions";
import { frameworkDetail, refreshSnapshots } from "@/lib/core/compliance/snapshot";
import { DAY, loadStates, scope } from "@/lib/core/compliance/state";

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (CSV_RISKY.test(text)) text = `'${text}`; // spreadsheet formula injection guard
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Statement of Applicability style export: every requirement, its applicability, justification, status and mapped controls. */
export async function exportStatement(tenantId: string, frameworkId: FrameworkId) {
  const detail = await frameworkDetail(tenantId, frameworkId);
  const { states } = await loadStates(tenantId);
  const header = [
    "requirement_id",
    "title",
    "group",
    "applicable",
    "justification",
    "status",
    "score_percent",
    "evidence_verified",
    "unified_controls",
    "mapping_basis",
    "control_statuses",
  ];
  const rows = detail.requirements.map((requirement) => [
    requirement.id,
    requirement.title,
    requirement.group,
    requirement.status === "not_applicable" ? "no" : "yes",
    requirement.justification ?? "",
    requirement.status,
    requirement.score === null ? "" : Math.round(requirement.score * 100),
    requirement.verified ? "yes" : "no",
    requirement.controls.join(" "),
    requirement.links.map((link) => `${link.ucCode}=${link.review ?? link.basis}`).join(" "),
    requirement.controls.map((code) => `${code}=${states.get(code)?.status ?? "not_started"}`).join(" "),
  ]);
  return {
    json: {
      framework: { id: frameworkId, name: detail.framework?.name, version: detail.framework?.version },
      generatedAt: new Date().toISOString(),
      score: detail.score,
      readiness: detail.readiness,
      requirements: detail.requirements,
    },
    csv: [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n"),
  };
}

const DEMO_POSTURE: Record<ImplementationStatus, string[]> = {
  implemented: [
    "GOV-01",
    "GOV-02",
    "GOV-03",
    "GOV-08",
    "CMP-01",
    "ASM-01",
    "DAT-03",
    "DAT-05",
    "IAM-01",
    "IAM-02",
    "IAM-04",
    "OPS-01",
    "OPS-03",
    "OPS-04",
    "OPS-05",
    "OPS-06",
    "SDL-01",
    "INC-01",
    "HR-01",
    "HR-02",
    "HR-03",
    "PHY-01",
    "PRV-01",
  ],
  partial: [
    "GOV-04",
    "GOV-05",
    "GOV-06",
    "GOV-07",
    "DAT-01",
    "DAT-02",
    "DAT-04",
    "IAM-03",
    "OPS-02",
    "OPS-07",
    "OPS-08",
    "OPS-09",
    "OPS-11",
    "INC-02",
    "BCP-01",
    "PHY-02",
    "TPM-01",
    "TPM-02",
    "PRV-02",
    "PRV-03",
    "PRV-04",
    "AI-02",
    "AI-05",
  ],
  planned: ["OPS-10", "BCP-02", "TPM-03", "TPM-04", "PRV-05", "AI-01", "AI-03", "AI-04", "AI-06"],
  not_started: [],
  not_applicable: [],
};
const DEMO_LINKS: Record<string, string> = { "UC-SDL-01": "CTL-SDLC-004", "UC-AI-05": "CTL-AI-014" };

/**
 * Removes everything the sample posture created (rows tagged `demo`), leaving real attestations, adoptions,
 * policies, exceptions and mapping reviews untouched. Trend points are recomputed from what remains.
 */
export async function purgeDemoPosture(actor: Actor) {
  const db = await scope(actor.tenantId);
  const counts = { controls: 0, adoptions: 0, policies: 0, exceptions: 0 };
  await db.transaction(async (tx) => {
    counts.controls = (await tx.run("DELETE FROM control_implementations WHERE tenant_id = ? AND source = 'demo'", actor.tenantId)).changes;
    counts.adoptions = (await tx.run("DELETE FROM framework_adoptions WHERE tenant_id = ? AND source = 'demo'", actor.tenantId)).changes;
    counts.policies = (await tx.run("DELETE FROM policy_register WHERE tenant_id = ? AND source = 'demo'", actor.tenantId)).changes;
    counts.exceptions = (await tx.run("DELETE FROM compliance_exceptions WHERE tenant_id = ? AND source = 'demo'", actor.tenantId)).changes;
    await tx.run("DELETE FROM compliance_snapshots WHERE tenant_id = ?", actor.tenantId);
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.demo_posture_purged",
        objectType: "tenant",
        objectId: actor.tenantId,
        payload: counts,
      },
      tx,
    );
  });
  await refreshSnapshots(actor, true);
  return { purged: counts };
}

/** Loads a clearly tagged sample posture into an empty tenant so the hub can be explored. Idempotent. */
export async function loadDemoPosture(actor: Actor) {
  const db = await scope(actor.tenantId);
  for (const table of ["control_implementations", "framework_adoptions", "policy_register", "compliance_exceptions"]) {
    const existing = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, actor.tenantId);
    if (Number(existing?.n) > 0) return { loaded: false };
  }
  const at = new Date().toISOString();
  const soon = (days: number) => new Date(Date.now() + days * DAY).toISOString();
  const knownControls = new Set(
    (await db.all<{ code: string }>("SELECT code FROM controls WHERE tenant_id = ? AND valid_to IS NULL", actor.tenantId)).map(
      (row) => row.code,
    ),
  );
  const maturity: Record<string, number> = { implemented: 4, partial: 2, planned: 1, not_started: 0, not_applicable: 0 };

  await db.transaction(async (tx) => {
    for (const [status, codes] of Object.entries(DEMO_POSTURE) as Array<[ImplementationStatus, string[]]>) {
      for (const short of codes) {
        const ucCode = `UC-${short}`;
        const linked = DEMO_LINKS[ucCode] && knownControls.has(DEMO_LINKS[ucCode]) ? DEMO_LINKS[ucCode] : null;
        await tx.run(
          `INSERT INTO control_implementations (id,tenant_id,uc_code,status,maturity,owner_id,linked_control_code,notes,source,review_due,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          `impl_${randomUUID()}`,
          actor.tenantId,
          ucCode,
          status,
          maturity[status],
          null,
          linked,
          "Sample posture for demonstration",
          "demo",
          soon(120),
          actor.userId,
          at,
        );
      }
    }
    for (const [frameworkId, scopeText] of [
      ["iso27001", "Lending platform, cloud estate and supporting teams"],
      ["nist_csf", "Enterprise-wide"],
      ["soc2", "Lending decision service (Security, Availability, Confidentiality)"],
      ["gdpr", "EU customer personal data"],
      ["dora", "ICT services supporting critical functions"],
      ["eu_ai_act", "Lending Decision Copilot (high-risk)"],
    ] as const) {
      await tx.run(
        "INSERT INTO framework_adoptions (id,tenant_id,framework_id,scope,target_date,adopted_by,adopted_at,source) VALUES (?,?,?,?,?,?,?,?)",
        `demo_adopt_${randomUUID()}`,
        actor.tenantId,
        frameworkId,
        scopeText,
        soon(240).slice(0, 10),
        actor.userId,
        at,
        "demo",
      );
    }
    for (const policy of [
      { title: "Information Security Policy", version: "3.1", status: "approved", review: soon(150), codes: ["UC-GOV-01"] },
      {
        title: "Acceptable Use Policy",
        version: "2.4",
        status: "approved",
        review: new Date(Date.now() - 20 * DAY).toISOString(),
        codes: ["UC-HR-03", "UC-ASM-01"],
      },
      { title: "AI Governance Policy", version: "0.9", status: "draft", review: null, codes: ["UC-AI-01", "UC-AI-02"] },
    ] as const) {
      await tx.run(
        `INSERT INTO policy_register (id,tenant_id,title,version,owner_id,status,approved_at,next_review,uc_codes_json,document_hash,created_at,updated_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        `demo_pol_${randomUUID()}`,
        actor.tenantId,
        policy.title,
        policy.version,
        null,
        policy.status,
        policy.status === "approved" ? at : null,
        policy.review,
        JSON.stringify(policy.codes),
        null,
        at,
        at,
        "demo",
      );
    }
    await tx.run(
      `INSERT INTO compliance_exceptions (id,tenant_id,uc_code,title,justification,compensating_controls,risk_level,requested_by,status,expires_at,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      `demo_exc_${randomUUID()}`,
      actor.tenantId,
      "UC-OPS-09",
      "Defer threat-led penetration test to next cycle",
      "Vendor availability pushes the TLPT window past the current quarter.",
      "Quarterly vulnerability scanning and an internal red-team exercise remain in place.",
      "medium",
      "system",
      "pending",
      soon(90),
      at,
      "demo",
    );
    await appendAudit(
      {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "compliance.demo_posture_loaded",
        objectType: "tenant",
        objectId: actor.tenantId,
        payload: { controls: UNIFIED_CONTROLS.length },
      },
      tx,
    );
  });
  await refreshSnapshots(actor, true);
  return { loaded: true };
}
