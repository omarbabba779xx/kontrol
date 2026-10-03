/**
 * EU AI Act (Regulation (EU) 2024/1689) triage. This is a structured first-pass classification that records its reasoning, not a
 * legal opinion: borderline calls (Art.6(3) derogation, what counts as a safety component, GPAI systemic-risk designation) belong
 * to counsel and, where relevant, to the AI Office. Application dates are deliberately not hard-coded: they have been the subject
 * of amendment proposals, so check the current timeline at the Official Journal / AI Office before planning against a date.
 */
export const PROHIBITED_PRACTICES = [
  {
    id: "manipulation",
    label: "Subliminal or purposefully manipulative techniques that materially distort behaviour and cause significant harm",
    article: "Art.5(1)(a)",
  },
  {
    id: "vulnerabilities",
    label: "Exploiting vulnerabilities due to age, disability or social or economic situation",
    article: "Art.5(1)(b)",
  },
  { id: "social_scoring", label: "Social scoring leading to detrimental or unjustified treatment", article: "Art.5(1)(c)" },
  {
    id: "crime_profiling",
    label: "Predicting the risk of an individual committing a criminal offence based solely on profiling",
    article: "Art.5(1)(d)",
  },
  {
    id: "face_scraping",
    label: "Building facial recognition databases by untargeted scraping of the internet or CCTV",
    article: "Art.5(1)(e)",
  },
  {
    id: "emotion_work_school",
    label: "Inferring emotions of people in the workplace or education (except medical or safety reasons)",
    article: "Art.5(1)(f)",
  },
  {
    id: "biometric_categorisation",
    label: "Biometric categorisation inferring race, political opinions, religion, sexual orientation and similar sensitive attributes",
    article: "Art.5(1)(g)",
  },
  {
    id: "realtime_remote_biometric",
    label: "Real-time remote biometric identification in public spaces for law enforcement (outside the narrow exceptions)",
    article: "Art.5(1)(h)",
  },
] as const;

export const ANNEX_III_AREAS = [
  { id: "none", label: "None of the areas below" },
  { id: "biometrics", label: "Biometrics: remote identification, categorisation, emotion recognition" },
  { id: "critical_infrastructure", label: "Safety components of critical infrastructure (digital, road traffic, utilities)" },
  { id: "education", label: "Education and vocational training: access, assessment, proctoring" },
  { id: "employment", label: "Employment and workers management: recruitment, evaluation, promotion, termination" },
  {
    id: "essential_services",
    label: "Essential services: public benefits, creditworthiness, life and health insurance pricing, emergency dispatch",
  },
  { id: "law_enforcement", label: "Law enforcement" },
  { id: "migration", label: "Migration, asylum and border control" },
  { id: "justice_democracy", label: "Administration of justice and democratic processes" },
] as const;

export type Role = "provider" | "deployer" | "both";
export type Tier = "prohibited" | "high" | "limited" | "minimal";

export type Answers = {
  role: Role;
  prohibited: string[];
  annexIIIArea: (typeof ANNEX_III_AREAS)[number]["id"];
  /** Art.6(3): the system only performs a narrow procedural task, improves a prior human activity, detects patterns without replacing human assessment, or does a preparatory task. */
  derogationClaimed: boolean;
  /** Profiling of natural persons always keeps an Annex III system high-risk, whatever else is claimed. */
  profilesPeople: boolean;
  /** The system is a safety component of, or is itself, a product under the Annex I harmonisation legislation requiring third-party conformity assessment. */
  annexIProduct: boolean;
  interactsWithPeople: boolean;
  generatesSyntheticContent: boolean;
  emotionRecognitionOrBiometricCategorisation: boolean;
  /** The organisation places a general-purpose AI model on the market. */
  gpaiProvider: boolean;
  /** Presumed systemic risk: training compute above the Act's threshold, or designated by the Commission. */
  gpaiSystemic: boolean;
  /** Deployer is a public body or private entity providing public services. */
  publicService: boolean;
};

export type Obligation = { id: string; article: string; title: string; ucCode: string; applies: "provider" | "deployer" | "both" };

const O = (id: string, article: string, title: string, ucCode: string, applies: Obligation["applies"]): Obligation => ({
  id,
  article,
  title,
  ucCode,
  applies,
});

export const HIGH_RISK_OBLIGATIONS: Obligation[] = [
  O("risk_management", "Art.9", "Risk management system across the lifecycle", "UC-AI-02", "provider"),
  O("data_governance", "Art.10", "Data and data governance: relevance, representativeness, bias examination", "UC-AI-03", "provider"),
  O("technical_documentation", "Art.11", "Technical documentation (Annex IV)", "UC-AI-04", "provider"),
  O("record_keeping", "Art.12", "Automatic logging of events", "UC-AI-04", "provider"),
  O("transparency_deployers", "Art.13", "Transparency and instructions for use for deployers", "UC-AI-04", "provider"),
  O("human_oversight_design", "Art.14", "Human oversight designed into the system", "UC-AI-05", "provider"),
  O("accuracy_robustness", "Art.15", "Accuracy, robustness and cybersecurity", "UC-AI-06", "provider"),
  O("qms", "Art.17", "Quality management system", "UC-AI-01", "provider"),
  O("conformity", "Art.43", "Conformity assessment and CE marking; EU declaration of conformity", "UC-AI-04", "provider"),
  O("registration", "Art.49", "Registration in the EU database", "UC-AI-04", "both"),
  O("post_market", "Art.72", "Post-market monitoring plan", "UC-AI-06", "provider"),
  O("serious_incidents", "Art.73", "Reporting of serious incidents", "UC-AI-06", "provider"),
  O("use_per_instructions", "Art.26(1)", "Use the system according to its instructions", "UC-AI-05", "deployer"),
  O("assign_oversight", "Art.26(2)", "Assign human oversight to competent, trained persons", "UC-AI-05", "deployer"),
  O("input_data", "Art.26(4)", "Ensure input data is relevant and sufficiently representative", "UC-AI-03", "deployer"),
  O("monitor_logs", "Art.26(5)-(6)", "Monitor operation and keep logs for at least six months", "UC-AI-04", "deployer"),
  O("inform_workers", "Art.26(7)", "Inform workers' representatives before using a high-risk system at work", "UC-AI-05", "deployer"),
  O("inform_persons", "Art.26(11)", "Inform natural persons subject to decisions made or assisted by the system", "UC-AI-04", "deployer"),
  O("ai_literacy", "Art.4", "AI literacy of staff operating the system", "UC-AI-01", "both"),
];
export const FRIA_OBLIGATION = O("fria", "Art.27", "Fundamental rights impact assessment before first use", "UC-AI-02", "deployer");
export const TRANSPARENCY_OBLIGATIONS: Obligation[] = [
  O("disclose_ai_interaction", "Art.50(1)", "Tell people they are interacting with an AI system", "UC-AI-04", "provider"),
  O("mark_synthetic", "Art.50(2)", "Mark synthetic audio, image, video or text in a machine-readable way", "UC-AI-04", "provider"),
  O(
    "inform_emotion_biometric",
    "Art.50(3)",
    "Inform people exposed to emotion recognition or biometric categorisation",
    "UC-AI-04",
    "deployer",
  ),
  O("disclose_deepfake", "Art.50(4)", "Disclose deep fakes and AI-generated text published to inform the public", "UC-AI-04", "deployer"),
  O("ai_literacy_limited", "Art.4", "AI literacy of staff operating the system", "UC-AI-01", "both"),
];
export const GPAI_OBLIGATIONS: Obligation[] = [
  O("gpai_documentation", "Art.53(1)(a)-(b)", "Technical documentation and information for downstream providers", "UC-AI-04", "provider"),
  O("gpai_copyright", "Art.53(1)(c)", "Copyright compliance policy", "UC-AI-07", "provider"),
  O("gpai_training_summary", "Art.53(1)(d)", "Public summary of training content", "UC-AI-03", "provider"),
];
export const GPAI_SYSTEMIC_OBLIGATIONS: Obligation[] = [
  O("gpai_evaluation", "Art.55(1)(a)", "Model evaluation including adversarial testing", "UC-AI-06", "provider"),
  O("gpai_systemic_risk", "Art.55(1)(b)", "Assess and mitigate systemic risks", "UC-AI-02", "provider"),
  O("gpai_incidents", "Art.55(1)(c)", "Track and report serious incidents to the AI Office", "UC-AI-06", "provider"),
  O("gpai_cybersecurity", "Art.55(1)(d)", "Adequate cybersecurity for the model and infrastructure", "UC-AI-06", "provider"),
];

export type Classification = {
  tier: Tier;
  reasons: string[];
  gpai: { provider: boolean; systemic: boolean };
  friaRequired: boolean;
  /** Where the outcome rests on a judgement the organisation should confirm with counsel. */
  needsLegalReview: string[];
  obligations: Obligation[];
};

export function classify(answers: Answers): Classification {
  const reasons: string[] = [];
  const review: string[] = [];
  const gpai = { provider: answers.gpaiProvider, systemic: answers.gpaiProvider && answers.gpaiSystemic };
  const provider = answers.role !== "deployer";
  const deployer = answers.role !== "provider";

  const forbidden = PROHIBITED_PRACTICES.filter((practice) => answers.prohibited.includes(practice.id));
  if (forbidden.length) {
    for (const practice of forbidden) reasons.push(`Prohibited practice: ${practice.label} (${practice.article}).`);
    return { tier: "prohibited", reasons, gpai, friaRequired: false, needsLegalReview: [], obligations: [] };
  }

  let tier: Tier = "minimal";
  if (answers.annexIProduct) {
    tier = "high";
    reasons.push(
      "The system is, or is a safety component of, a product covered by Annex I harmonisation legislation that requires third-party conformity assessment (Art.6(1)).",
    );
    review.push(
      "Whether the product legislation requires third-party conformity assessment, and which application date governs, depends on the sector regulation.",
    );
  }
  if (answers.annexIIIArea !== "none") {
    const area = ANNEX_III_AREAS.find((item) => item.id === answers.annexIIIArea)!;
    if (answers.derogationClaimed && !answers.profilesPeople) {
      reasons.push(
        `Falls in an Annex III area (${area.label}) but the Art.6(3) derogation is claimed: not high-risk if it performs only a narrow procedural task, improves a prior human activity, detects patterns without replacing human assessment, or does a preparatory task.`,
      );
      review.push(
        "An Art.6(3) derogation must be documented and the system registered; the assessment can be challenged by the authorities.",
      );
    } else {
      tier = "high";
      reasons.push(`Annex III area: ${area.label} (Art.6(2)).`);
      if (answers.derogationClaimed && answers.profilesPeople)
        reasons.push("The derogation does not apply: a system that profiles natural persons is always high-risk (Art.6(3)).");
    }
  }
  if (tier !== "high") {
    const transparency =
      answers.interactsWithPeople || answers.generatesSyntheticContent || answers.emotionRecognitionOrBiometricCategorisation;
    if (transparency) {
      tier = "limited";
      if (answers.interactsWithPeople)
        reasons.push("The system interacts directly with people: they must be told it is an AI system (Art.50(1)).");
      if (answers.generatesSyntheticContent)
        reasons.push("The system generates synthetic audio, image, video or text: outputs must be machine-readably marked (Art.50(2)).");
      if (answers.emotionRecognitionOrBiometricCategorisation)
        reasons.push("Emotion recognition or biometric categorisation: people exposed must be informed (Art.50(3)).");
    }
  }
  if (tier === "minimal")
    reasons.push(
      "No prohibited practice, no Annex III or Annex I trigger and no transparency trigger: minimal risk. Voluntary codes of conduct and AI literacy (Art.4) still apply.",
    );
  if (gpai.provider) {
    reasons.push(
      `The organisation provides a general-purpose AI model (Art.53)${gpai.systemic ? ", presumed to pose systemic risk (Art.51, Art.55)" : ""}. This is assessed separately from the risk tier of any system built on it.`,
    );
    if (gpai.systemic)
      review.push(
        "A systemic-risk designation rests on a compute threshold or a Commission decision and carries notification duties to the AI Office.",
      );
  }

  const friaRequired = tier === "high" && deployer && (answers.publicService || answers.annexIIIArea === "essential_services");
  if (friaRequired)
    reasons.push(
      "A fundamental rights impact assessment is required before first use (Art.27): the deployer provides public services or the use is creditworthiness or life and health insurance pricing.",
    );

  const wants = (item: Obligation) => (item.applies === "both" ? true : item.applies === "provider" ? provider : deployer);
  let obligations: Obligation[] = [];
  if (tier === "high") obligations = HIGH_RISK_OBLIGATIONS.filter(wants);
  if (tier === "limited") obligations = TRANSPARENCY_OBLIGATIONS.filter(wants);
  if (friaRequired) obligations.push(FRIA_OBLIGATION);
  if (gpai.provider) obligations.push(...GPAI_OBLIGATIONS, ...(gpai.systemic ? GPAI_SYSTEMIC_OBLIGATIONS : []));
  return { tier, reasons, gpai, friaRequired, needsLegalReview: review, obligations };
}

/** Sections of a model card. Intentionally close to the documentation duties (Art.11 / Annex IV, Art.13, Art.53) so it can seed them. */
export const MODEL_CARD_FIELDS = [
  { id: "intended_purpose", label: "Intended purpose and users", required: true },
  { id: "out_of_scope", label: "Out-of-scope and foreseeable misuse", required: true },
  { id: "model_description", label: "Model type, version, provider and architecture", required: true },
  { id: "training_data", label: "Training, validation and test data: sources, selection, known gaps", required: true },
  { id: "evaluation", label: "Evaluation: metrics, test populations, results, subgroup performance", required: true },
  { id: "limitations", label: "Known limitations and failure modes", required: true },
  { id: "human_oversight", label: "Human oversight measures and how the output is reviewed", required: true },
  { id: "monitoring", label: "Monitoring in production, logging and drift thresholds", required: false },
  { id: "energy_compute", label: "Compute and energy information", required: false },
  { id: "change_log", label: "Changes since the previous version", required: false },
] as const;

export const FRIA_RIGHTS = [
  "Human dignity",
  "Non-discrimination",
  "Privacy and data protection",
  "Freedom of expression",
  "Access to essential services",
  "Workers' rights",
  "Right to an effective remedy and fair trial",
  "Rights of the child",
  "Rights of persons with disabilities",
  "Consumer protection",
] as const;
