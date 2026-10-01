export type FrameworkId = "iso27001" | "nist_csf" | "soc2" | "gdpr" | "nis2" | "dora" | "eu_ai_act" | "iso42001" | "pci_dss" | "cis_v8";

export type Requirement = { id: string; title: string; group: string; /** Id of the group (category, principal requirement…) this item belongs to; it inherits that group's unified-control mapping unless refined. */ parent?: string };
export type RequirementGroup = { id: string; title: string };

export type Framework = {
  id: FrameworkId;
  name: string;
  version: string;
  authority: string;
  kind: "standard" | "regulation" | "framework";
  /** Honest description of how deep the catalogue goes (clauses, controls, categories, articles). */
  granularity: string;
  sourceUrl: string;
  /** Parent groups that unified controls may reference; children inherit their mapping. */
  groups?: RequirementGroup[];
  requirements: Requirement[];
};

export type UnifiedDomain = "GOV" | "ASM" | "DAT" | "IAM" | "OPS" | "SDL" | "INC" | "BCP" | "HR" | "PHY" | "TPM" | "PRV" | "AI" | "CMP";

/** A framework-neutral control. Implementing it contributes to every requirement that references it. */
export type UnifiedControl = {
  code: string;
  title: string;
  domain: UnifiedDomain;
  description: string;
  map: Partial<Record<FrameworkId, string[]>>;
};

export type ImplementationStatus = "not_started" | "planned" | "partial" | "implemented" | "not_applicable";
