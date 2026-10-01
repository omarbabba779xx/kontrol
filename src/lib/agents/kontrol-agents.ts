import "server-only";

import { ToolLoopAgent, gateway, isStepCount, tool } from "ai";
import { z } from "zod";
import type { Actor } from "@/lib/core/auth";
import { getDb } from "@/lib/db";
import { simulateRisk } from "@/lib/core/risk-engine";

export type AgentKind = "regulatory_analyst" | "control_engineer" | "evidence_analyst" | "risk_quantifier" | "audit_assistant" | "contradiction_detector";

const missions: Record<AgentKind, string> = {
  regulatory_analyst: "Analyse les obligations, leurs versions et leurs impacts. Ne donne jamais d'avis juridique définitif.",
  control_engineer: "Conçois et critique des contrôles testables, avec critères, fréquence et preuves attendues.",
  evidence_analyst: "Évalue la fraîcheur, la provenance, la couverture et les contradictions des preuves.",
  risk_quantifier: "Quantifie l'exposition et rend explicites hypothèses, distributions et incertitudes.",
  audit_assistant: "Prépare une piste d'audit factuelle sans inventer de preuve ni conclure à la place de l'auditeur.",
  contradiction_detector: "Recherche les incohérences entre politiques, contrôles, preuves, constats et décisions.",
};

async function provenance(actor: Actor, subjectId?: string) {
  const db = (await getDb()).scope(actor.tenantId);
  const evidence = await db.all("SELECT id, name, source, collection_method, collected_at, content_hash, status FROM evidence WHERE tenant_id = ? ORDER BY collected_at DESC LIMIT 12", actor.tenantId);
  const findings = await db.all("SELECT id, control_id, status, severity, title, opened_at, closed_at FROM findings WHERE tenant_id = ? ORDER BY opened_at DESC LIMIT 12", actor.tenantId);
  const obligations = await db.all("SELECT id, framework, citation, title, version_hash, effective_from FROM obligations WHERE tenant_id = ? ORDER BY recorded_at DESC LIMIT 12", actor.tenantId);
  const subject = subjectId ? (await db.get("SELECT id, type, name, attributes_json FROM assets WHERE tenant_id = ? AND id = ?", actor.tenantId, subjectId)) ?? null : null;
  return { subject, evidence, findings, obligations };
}

async function createTools(actor: Actor) {
  const db = (await getDb()).scope(actor.tenantId);
  return {
    graph: tool({
      description: "Retourne les relations du graphe GRC autour d'un objet.",
      inputSchema: z.object({ objectId: z.string() }),
      execute: async ({ objectId }) => db.all("SELECT * FROM graph_edges WHERE tenant_id = ? AND (source_id = ? OR target_id = ?) LIMIT 100", actor.tenantId, objectId, objectId),
    }),
    findings: tool({
      description: "Liste les constats ouverts avec leur sévérité et leur contrôle.",
      inputSchema: z.object({ severity: z.string().optional() }),
      execute: async ({ severity }) => severity
        ? db.all("SELECT * FROM findings WHERE tenant_id = ? AND status = 'open' AND severity = ? LIMIT 50", actor.tenantId, severity)
        : db.all("SELECT * FROM findings WHERE tenant_id = ? AND status = 'open' LIMIT 50", actor.tenantId),
    }),
    evidence: tool({
      description: "Lit les métadonnées et le contenu structuré d'une preuve.",
      inputSchema: z.object({ evidenceId: z.string() }),
      execute: async ({ evidenceId }) => (await db.get("SELECT id,name,source,collection_method,content_json,content_hash,collected_at,period_start,period_end,status FROM evidence WHERE tenant_id = ? AND id = ?", actor.tenantId, evidenceId)) ?? null,
    }),
    riskScenario: tool({
      description: "Exécute une simulation de risque reproductible et retourne les percentiles.",
      inputSchema: z.object({ materialDecision: z.boolean(), sensitiveData: z.boolean(), humanReview: z.boolean(), thirdPartyModel: z.boolean(), crossBorder: z.boolean(), annualEvents: z.number().int().min(1).max(1_000_000) }),
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
      answer: `${missions[kind]} Analyse locale: ${openFindings} constat(s) ouvert(s), ${(sources.evidence as unknown[]).length} preuve(s) récente(s) et ${(sources.obligations as unknown[]).length} obligation(s) ont été examinés. La question « ${question} » requiert une validation humaine avant toute décision ou modification.`,
      confidence: sources.evidence.length ? 0.78 : 0.42,
      assumptions: ["Données limitées au tenant actif", "Aucune conclusion juridique", "Toute mutation exige une approbation humaine"],
      sources,
    };
  }

  const agent = new ToolLoopAgent({
    model: gateway(modelId),
    instructions: `Tu es un agent spécialisé de la plateforme Kontrol. ${missions[kind]} Tu dois citer uniquement les identifiants retournés par les outils, signaler les lacunes, donner un niveau de confiance de 0 à 1 et expliciter les hypothèses. Tu es en lecture seule. Toute mutation ou décision finale doit être proposée pour approbation humaine. Réponds en français, de façon concise et structurée.`,
    tools: await createTools(actor),
    stopWhen: isStepCount(6),
  });
  const result = await agent.generate({ prompt: `${question}\nSujet: ${subjectId ?? "non spécifié"}` });
  return { mode: "gateway", agent: kind, answer: result.text, confidence: null, assumptions: ["Réponse assistée par modèle; validation humaine obligatoire"], sources };
}
