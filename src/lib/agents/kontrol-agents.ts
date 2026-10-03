import "server-only";

import { ToolLoopAgent, gateway, isStepCount, tool } from "ai";
import { z } from "zod";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/db";
import { simulateRisk } from "@/lib/core/risk-engine";

export type AgentKind =
  "regulatory_analyst" | "control_engineer" | "evidence_analyst" | "risk_quantifier" | "audit_assistant" | "contradiction_detector";

const missions: Record<AgentKind, string> = {
  regulatory_analyst: "Analyse the obligations, their versions and their impacts. Never give a definitive legal opinion.",
  control_engineer: "Design and critique testable controls, with criteria, frequency and expected evidence.",
  evidence_analyst: "Assess the freshness, provenance, coverage and contradictions of evidence.",
  risk_quantifier: "Quantify exposure and make assumptions, distributions and uncertainty explicit.",
  audit_assistant: "Prepare a factual audit trail without inventing evidence or concluding in the auditor's place.",
  contradiction_detector: "Look for inconsistencies between policies, controls, evidence, findings and decisions.",
};

async function provenance(actor: Actor, subjectId?: string) {
  const db = (await getDb()).scope(actor.tenantId);
  const evidence = await db.all(
    "SELECT id, name, source, collection_method, collected_at, content_hash, status FROM evidence WHERE tenant_id = ? ORDER BY collected_at DESC LIMIT 12",
    actor.tenantId,
  );
  const findings = await db.all(
    "SELECT id, control_id, status, severity, title, opened_at, closed_at FROM findings WHERE tenant_id = ? ORDER BY opened_at DESC LIMIT 12",
    actor.tenantId,
  );
  const obligations = await db.all(
    "SELECT id, framework, citation, title, version_hash, effective_from FROM obligations WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT 12",
    actor.tenantId,
  );
  const subject = subjectId
    ? ((await db.get("SELECT id, type, name, attributes_json FROM assets WHERE tenant_id = ? AND id = ?", actor.tenantId, subjectId)) ??
      null)
    : null;
  return { subject, evidence, findings, obligations };
}

async function createTools(actor: Actor) {
  const db = (await getDb()).scope(actor.tenantId);
  return {
    graph: tool({
      description: "Retourne les relations du graphe GRC autour d'un objet.",
      inputSchema: z.object({ objectId: z.string() }),
      execute: async ({ objectId }) =>
        db.all(
          "SELECT * FROM graph_edges WHERE tenant_id = ? AND (source_id = ? OR target_id = ?) LIMIT 100",
          actor.tenantId,
          objectId,
          objectId,
        ),
    }),
    findings: tool({
      description: "Lists open findings with their severity and control.",
      inputSchema: z.object({ severity: z.string().optional() }),
      execute: async ({ severity }) =>
        severity
          ? db.all("SELECT * FROM findings WHERE tenant_id = ? AND status = 'open' AND severity = ? LIMIT 50", actor.tenantId, severity)
          : db.all("SELECT * FROM findings WHERE tenant_id = ? AND status = 'open' LIMIT 50", actor.tenantId),
    }),
    evidence: tool({
      description: "Reads the metadata and structured content of an item of evidence.",
      inputSchema: z.object({ evidenceId: z.string() }),
      execute: async ({ evidenceId }) =>
        (await db.get(
          "SELECT id,name,source,collection_method,content_json,content_hash,collected_at,period_start,period_end,status FROM evidence WHERE tenant_id = ? AND id = ?",
          actor.tenantId,
          evidenceId,
        )) ?? null,
    }),
    riskScenario: tool({
      description: "Runs a reproducible risk simulation and returns the percentiles.",
      inputSchema: z.object({
        materialDecision: z.boolean(),
        sensitiveData: z.boolean(),
        humanReview: z.boolean(),
        thirdPartyModel: z.boolean(),
        crossBorder: z.boolean(),
        annualEvents: z.number().int().min(1).max(1_000_000),
      }),
      execute: async (input) => simulateRisk({ name: "Agent scenario", iterations: 10_000, ...input }),
    }),
  };
}

export async function runKontrolAgent(actor: Actor, kind: AgentKind, question: string, subjectId?: string) {
  const sources = await provenance(actor, subjectId);
  const modelId = process.env.KONTROL_AGENT_MODEL;
  if (!process.env.AI_GATEWAY_API_KEY || !modelId) {
    const openFindings = (sources.findings as Array<{ status: string }>).filter((item) => item.status === "open").length;
    return {
      mode: "deterministic",
      agent: kind,
      answer: `${missions[kind]} Local analysis: ${openFindings} open finding(s), ${(sources.evidence as unknown[]).length} recent item(s) of evidence and ${(sources.obligations as unknown[]).length} obligation(s) were examined. The question "${question}" requires human validation before any decision or change.`,
      confidence: sources.evidence.length ? 0.78 : 0.42,
      assumptions: ["Data is limited to the active tenant", "No legal conclusion", "Any change requires human approval"],
      sources,
    };
  }

  const agent = new ToolLoopAgent({
    model: gateway(modelId),
    instructions: `You are a specialised agent of the Kontrol platform. ${missions[kind]} Cite only identifiers returned by the tools, point out gaps, give a confidence level from 0 to 1 and state your assumptions. You are read-only. Any change or final decision must be proposed for human approval. Answer in the language of the question, concisely and in a structured way.`,
    tools: await createTools(actor),
    stopWhen: isStepCount(6),
  });
  const result = await agent.generate({ prompt: `${question}\nSubject: ${subjectId ?? "not specified"}` });
  return {
    mode: "gateway",
    agent: kind,
    answer: result.text,
    confidence: null,
    assumptions: ["Model-assisted answer; human validation is required"],
    sources,
  };
}
