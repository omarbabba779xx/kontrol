import { randomUUID } from "node:crypto";
import type { Db } from "@/lib/db/types";

/**
 * Seeds the demonstration tenant once. Safe to call repeatedly. With `mode` "empty" only the organisation and its administrator
 * are created, under neutral names, so that a case can be worked from a clean slate.
 */
export async function seedDatabase(db: Db, mode: "sample" | "empty" = "sample") {
  const system = db.system();
  const existing = await system.get<{ count: number }>("SELECT COUNT(*) AS count FROM tenants");
  if (Number(existing?.count ?? 0) > 0) return;

  await system.transaction(async (tx) => {
    const now = new Date().toISOString();
    if (mode === "empty") {
      await tx.run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", "tenant_acme", "Organisation", "EU", now);
      await tx.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", "usr_leila", "tenant_acme", "administrator@organisation.example", "Administrator", "admin", now);
      return;
    }
    await tx.run("INSERT INTO tenants (id,name,region,created_at) VALUES (?,?,?,?)", "tenant_acme", "Acme Financial Europe", "EU", now);
    await tx.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", "usr_leila", "tenant_acme", "leila@acme.example", "Leila Mansour", "admin", now);
    await tx.run("INSERT INTO users (id,tenant_id,email,name,role,created_at) VALUES (?,?,?,?,?,?)", "usr_maya", "tenant_acme", "maya@acme.example", "Maya Chen", "risk_owner", now);

    await tx.run(`INSERT INTO assets (id,tenant_id,type,name,criticality,owner_id,attributes_json,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`, 
      "asset_ai_014", "tenant_acme", "ai_system", "Lending Decision Copilot", "critical", "usr_leila",
      JSON.stringify({ purpose: "credit recommendation", data: ["identity", "financial"], region: "EU" }), now, now,
    );
    await tx.run(`INSERT INTO assets (id,tenant_id,type,name,criticality,owner_id,attributes_json,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)`, 
      "asset_repo_lending", "tenant_acme", "repository", "lending-decision-service", "high", "usr_maya",
      JSON.stringify({ provider: "github", production: true, defaultBranch: "main" }), now, now,
    );

    await tx.run(`INSERT INTO obligations (id,tenant_id,framework,citation,title,text,source_url,effective_from,version_hash,confidence,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 
      "obl_euaia_14", "tenant_acme", "EU AI Act", "Article 14", "Human oversight", "High-risk AI systems shall be designed so they can be effectively overseen by natural persons.", "https://eur-lex.europa.eu/eli/reg/2024/1689", "2027-12-02", "euaia-art14-v2026", 1, now,
    );
    await tx.run(`INSERT INTO obligations (id,tenant_id,framework,citation,title,text,source_url,effective_from,version_hash,confidence,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 
      "obl_nist_prps", "tenant_acme", "NIST CSF 2.0", "PR.PS-06", "Secure software development", "Secure software development practices are integrated and their performance is monitored.", "https://doi.org/10.6028/NIST.CSWP.29", "2024-02-26", "nist-csf-2", 1, now,
    );

    await tx.run(`INSERT INTO controls (id,tenant_id,code,title,objective,owner_id,automation,frequency,policy_json,status,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 
      "control_human_override", "tenant_acme", "CTL-AI-014", "Meaningful human override", "Ensure a competent person can understand, disregard and override model output.", "usr_leila", "hybrid", "weekly",
      JSON.stringify({ all: [{ path: "humanOversight.enabled", op: "eq", value: true }, { path: "humanOversight.reasonRequired", op: "eq", value: true }, { path: "humanOversight.sampleRate", op: "gte", value: 0.1 }] }), "partial", now, now,
    );
    await tx.run(`INSERT INTO controls (id,tenant_id,code,title,objective,owner_id,automation,frequency,policy_json,status,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 
      "control_branch_protection", "tenant_acme", "CTL-SDLC-004", "Production branch protection", "Prevent unreviewed changes to production code.", "usr_maya", "automated", "hourly",
      JSON.stringify({ all: [{ path: "production", op: "eq", value: true }, { path: "branchProtection.enabled", op: "eq", value: true }, { path: "branchProtection.requiredReviews", op: "gte", value: 1 }] }), "effective", now, now,
    );

    const edgeSql = `INSERT INTO graph_edges (id,tenant_id,source_type,source_id,relation,target_type,target_id,confidence,rationale,source_ref,valid_from,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
    await tx.run(edgeSql, randomUUID(), "tenant_acme", "obligation", "obl_euaia_14", "satisfied_by", "control", "control_human_override", .98, "Direct implementation mapping reviewed by AI Risk Office", "MAP-2026-041", now, now);
    await tx.run(edgeSql, randomUUID(), "tenant_acme", "control", "control_human_override", "protects", "asset", "asset_ai_014", 1, "Control is scoped to the lending decision workflow", "SCOPE-014", now, now);
    await tx.run(edgeSql, randomUUID(), "tenant_acme", "obligation", "obl_nist_prps", "satisfied_by", "control", "control_branch_protection", .94, "Implementation example mapping", "MAP-2026-052", now, now);
    await tx.run(edgeSql, randomUUID(), "tenant_acme", "control", "control_branch_protection", "protects", "asset", "asset_repo_lending", 1, "Repository is production-scoped", "SCOPE-004", now, now);

    await tx.run(`INSERT INTO ai_models (id,tenant_id,asset_id,name,version,provider,purpose,classification,fingerprint,data_lineage_json,prompt_hash,status,approved_by,approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 
      "model_atlas_32", "tenant_acme", "asset_ai_014", "Atlas Finance", "3.2", "In-house", "Credit recommendation", "high-risk", "sha256:81ce097c2f540a3119ab220f", JSON.stringify({ sources: ["loan_applications_v7", "credit_outcomes_v5"], residency: "EU" }), "sha256:prompt91aa", "conditional", "usr_leila", now,
    );
    await tx.run(`INSERT INTO model_evaluations (id,tenant_id,model_id,kind,dataset_hash,metrics_json,thresholds_json,passed,evaluated_at,evaluator) VALUES (?,?,?,?,?,?,?,?,?,?)`, 
      "eval_atlas_fairness", "tenant_acme", "model_atlas_32", "fairness", "sha256:data7ea", JSON.stringify({ demographicParityRatio: .78, equalOpportunityDifference: .09 }), JSON.stringify({ demographicParityRatio: .8, equalOpportunityDifference: .1 }), 0, now, "eval-pipeline@kontrol",
    );

    await tx.run(`INSERT INTO vendors (id,tenant_id,name,tier,score,services_json,subprocessors_json,exit_tested,assessed_at) VALUES (?,?,?,?,?,?,?,?,?)`, 
      "vendor_aws", "tenant_acme", "Amazon Web Services", "critical", 86, JSON.stringify(["cloud", "storage", "compute"]), JSON.stringify(["Cloudflare", "Equinix"]), 0, now,
    );
    await tx.run(`INSERT INTO connectors (id,tenant_id,kind,name,config_json,status,last_sync_at) VALUES (?,?,?,?,?,?,?)`, 
      "connector_github", "tenant_acme", "github", "Production GitHub", JSON.stringify({ owner: "acme", repositories: ["lending-decision-service"] }), "demo", null,
    );
  });
}
