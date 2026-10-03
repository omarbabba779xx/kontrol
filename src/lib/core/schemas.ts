import { z } from "zod";

export const scenarioSchema = z.object({
  name: z.string().min(3).max(120).default("AI deployment scenario"),
  materialDecision: z.boolean(),
  sensitiveData: z.boolean(),
  humanReview: z.boolean(),
  thirdPartyModel: z.boolean(),
  crossBorder: z.boolean(),
  annualEvents: z.number().int().min(1).max(1_000_000).default(120_000),
  iterations: z.number().int().min(1_000).max(100_000).default(10_000),
});

export const controlEvaluationSchema = z.object({
  controlCode: z.string().min(3),
  assetId: z.string().min(3),
  facts: z.record(z.string(), z.unknown()),
  source: z.string().min(2).default("api"),
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
});

export const decisionSchema = z.object({
  subjectType: z.enum(["risk", "ai_model", "control", "vendor", "review"]),
  subjectId: z.string().min(3),
  outcome: z.enum(["approved", "conditional", "rejected", "accepted"]),
  conditions: z.array(z.string().min(3)).max(20),
  rationale: z.string().min(20).max(5000),
  evidenceIds: z.array(z.string()).max(200),
});

export const regulatoryIngestSchema = z.object({
  framework: z.string().min(2),
  citation: z.string().min(2),
  title: z.string().min(3),
  text: z.string().min(20).max(100_000),
  sourceUrl: z.string().url(),
  effectiveFrom: z.string().date().optional(),
  supersedesId: z.string().optional(),
});

export const githubSyncSchema = z.object({
  owner: z.string().min(1).max(100),
  repository: z.string().min(1).max(100),
  assetId: z.string().min(3).optional(),
  demo: z.boolean().default(false),
});

export const agentRequestSchema = z.object({
  agent: z.enum([
    "regulatory_analyst",
    "control_engineer",
    "evidence_analyst",
    "risk_quantifier",
    "audit_assistant",
    "contradiction_detector",
  ]),
  question: z.string().min(5).max(4000),
  subjectId: z.string().optional(),
});
