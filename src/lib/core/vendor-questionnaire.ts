import { UC_BY_CODE } from "@/lib/frameworks/unified";

/**
 * Baseline security and resilience questionnaire for ICT third parties. Every question is mapped to a unified control so an
 * answer can be traced to the frameworks it supports (ISO 27001, NIS2 Art.21(2)(d), DORA Art.28-30, SOC 2 CC9). Answers are
 * self-declared: the score ranks vendors for follow-up, it is not an audit of them.
 */
export type Answer = "yes" | "partial" | "no" | "na";
export type Question = { id: string; section: string; text: string; weight: 1 | 2 | 3; ucCode: string; /** A "no" here is a blocking finding whatever the score. */ critical?: boolean; evidence?: string };

const q = (id: string, section: string, text: string, weight: 1 | 2 | 3, ucCode: string, extra: { critical?: boolean; evidence?: string } = {}): Question => ({ id, section, text, weight, ucCode, ...extra });

export const TEMPLATE_ID = "baseline-v1";

export const QUESTIONS: Question[] = [
  q("GOV-1", "Governance", "Do you maintain an approved information security policy reviewed at least annually?", 2, "UC-GOV-01", { evidence: "Policy title and last review date" }),
  q("GOV-2", "Governance", "Is a named executive accountable for information security and ICT risk?", 1, "UC-GOV-02"),
  q("CERT-1", "Certification", "Do you hold a current ISO/IEC 27001 certificate or a SOC 2 Type II report covering the services provided to us?", 3, "UC-TPM-01", { evidence: "Certificate or report reference, scope and expiry" }),
  q("IAM-1", "Access control", "Is multi-factor authentication enforced for all administrative and remote access to systems that process our data?", 3, "UC-IAM-02", { critical: true }),
  q("IAM-2", "Access control", "Are user access rights reviewed at least quarterly and revoked on departure within one working day?", 2, "UC-IAM-01"),
  q("DATA-1", "Data protection", "Is our data encrypted in transit and at rest with industry-standard algorithms?", 3, "UC-DAT-03", { critical: true }),
  q("DATA-2", "Data protection", "Can you state in which countries our data is stored and processed, and do you commit to notify us before that changes?", 2, "UC-PRV-05"),
  q("DATA-3", "Data protection", "Do you have a data processing agreement covering GDPR Art.28 and a list of sub-processors?", 2, "UC-PRV-04", { evidence: "Date of the DPA" }),
  q("VUL-1", "Vulnerability management", "Are critical vulnerabilities patched within 15 days, and is penetration testing carried out at least annually?", 2, "UC-OPS-02"),
  q("LOG-1", "Monitoring", "Are security-relevant events logged, protected from tampering and monitored continuously?", 2, "UC-OPS-05"),
  q("INC-1", "Incident management", "Do you commit contractually to notify us of incidents affecting our services within 24 hours of detection?", 3, "UC-INC-01", { critical: true }),
  q("INC-2", "Incident management", "Do you test your incident response plan at least annually?", 1, "UC-INC-02"),
  q("RES-1", "Resilience", "Do you have a business continuity and disaster recovery plan covering our services, tested in the last 12 months?", 3, "UC-BCP-01", { evidence: "Date and result of the last test" }),
  q("RES-2", "Resilience", "Are recovery time and recovery point objectives for our services defined and contractually committed?", 2, "UC-BCP-01"),
  q("SUP-1", "Supply chain", "Do you flow security and audit obligations down to your own ICT subcontractors that support our services?", 2, "UC-TPM-01"),
  q("SUP-2", "Supply chain", "Will you inform us in advance of material changes to subcontractors supporting our services?", 1, "UC-TPM-01"),
  q("AUD-1", "Audit and oversight", "Do you grant us, our auditors and our supervisors access and audit rights over the services?", 3, "UC-TPM-02", { critical: true }),
  q("EXIT-1", "Exit and substitutability", "Do you provide an exit assistance plan, data return in a usable format and a reasonable transition period at termination?", 3, "UC-TPM-04", { critical: true }),
  q("EXIT-2", "Exit and substitutability", "Can our data and configuration be exported in open or documented formats without your proprietary tooling?", 2, "UC-TPM-04"),
  q("PEO-1", "People", "Are staff with access to our data background-checked and trained in security at least annually?", 1, "UC-HR-02"),
];

export const SECTIONS = [...new Set(QUESTIONS.map((question) => question.section))];
export const QUESTION_BY_ID = new Map(QUESTIONS.map((question) => [question.id, question]));
export const ANSWER_CREDIT: Record<Exclude<Answer, "na">, number> = { yes: 1, partial: 0.5, no: 0 };

/** Question mappings are checked against the real unified-control catalogue in tests. */
export const unknownMappings = () => QUESTIONS.filter((question) => !UC_BY_CODE.has(question.ucCode)).map((question) => question.id);

export type Scored = { score: number; level: "low" | "medium" | "high"; criticalFailures: string[]; unanswered: string[]; answered: number };

/** Weighted share of credit over the applicable questions, 0-100. `na` removes a question; a missing answer counts as a "no". */
export function scoreAnswers(answers: Record<string, Answer | undefined>): Scored {
  let earned = 0, possible = 0, answered = 0;
  const criticalFailures: string[] = [];
  const unanswered: string[] = [];
  for (const question of QUESTIONS) {
    const answer = answers[question.id];
    if (answer === undefined) { unanswered.push(question.id); possible += question.weight; if (question.critical) criticalFailures.push(question.id); continue; }
    answered += 1;
    if (answer === "na") continue;
    possible += question.weight;
    earned += question.weight * ANSWER_CREDIT[answer];
    if (question.critical && answer === "no") criticalFailures.push(question.id);
  }
  const score = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  // A blocking finding caps the level: a high score does not offset the absence of audit rights or an exit plan.
  const level = criticalFailures.length > 0 || score < 50 ? "high" : score < 80 ? "medium" : "low";
  return { score, level, criticalFailures, unanswered, answered };
}
