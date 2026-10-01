import type { FrameworkId, UnifiedControl, UnifiedDomain } from "@/lib/frameworks/types";

type MapInput = Partial<Record<FrameworkId, string>>;

/** Mappings are authored as space-separated requirement ids per framework. */
function uc(code: string, title: string, description: string, map: MapInput): UnifiedControl {
  const domain = code.split("-")[1] as UnifiedDomain;
  const parsed: UnifiedControl["map"] = {};
  for (const [framework, ids] of Object.entries(map)) parsed[framework as FrameworkId] = ids.split(/\s+/).filter(Boolean);
  return { code, title, domain, description, map: parsed };
}

export const DOMAIN_LABELS: Record<UnifiedDomain, string> = {
  GOV: "Governance & risk",
  CMP: "Compliance",
  ASM: "Asset management",
  DAT: "Data protection",
  IAM: "Identity & access",
  OPS: "Security operations",
  SDL: "Secure development",
  INC: "Incident response",
  BCP: "Resilience & continuity",
  HR: "People",
  PHY: "Physical security",
  TPM: "Third-party risk",
  PRV: "Privacy",
  AI: "AI governance",
};

/** Typical delivery effort (1 = days, 5 = multi-quarter programme), used to rank the remediation roadmap. */
export const DOMAIN_EFFORT: Record<UnifiedDomain, number> = { GOV: 2, CMP: 2, ASM: 3, DAT: 3, IAM: 2, OPS: 3, SDL: 4, INC: 3, BCP: 4, HR: 2, PHY: 3, TPM: 3, PRV: 3, AI: 4 };

export const UNIFIED_CONTROLS: UnifiedControl[] = [
  // Governance & risk
  uc("UC-GOV-01", "Information security policy framework", "Approved, communicated and periodically reviewed security policies with documented operating procedures.", { iso27001: "A5.1 A5.37 C4.4 C5.2 C7.5", nist_csf: "GV.PO", soc2: "CC5.1 CC5.3", nis2: "Art.21(2)(a)", dora: "Art.6", pci_dss: "Req.12" }),
  uc("UC-GOV-02", "Leadership, roles and segregation of duties", "Management commitment, named accountabilities, resourcing and separation of conflicting duties.", { iso27001: "A5.2 A5.3 A5.4 C5.1 C5.3 C7.1", nist_csf: "GV.RR", soc2: "CC1.2 CC1.3 CC1.5", nis2: "Art.20(1) Art.20(2)", dora: "Art.5", iso42001: "A3" }),
  uc("UC-GOV-03", "Context, scope and stakeholder requirements", "Documented organisational context, ISMS scope and the needs of interested parties.", { iso27001: "C4.1 C4.2 C4.3", nist_csf: "GV.OC", soc2: "CC3.1" }),
  uc("UC-GOV-04", "Risk assessment and treatment", "Repeatable risk methodology, risk register, treatment plans and residual-risk acceptance.", { iso27001: "C6.1 C8.1 C8.2 C8.3", nist_csf: "GV.RM ID.RA", soc2: "CC3.2 CC3.3 CC3.4", nis2: "Art.21(2)(a)", dora: "Art.8" }),
  uc("UC-GOV-05", "Objectives, metrics and management review", "Measurable security objectives, KPIs and periodic management review of performance.", { iso27001: "C6.2 C9.1 C9.3", nist_csf: "GV.OV", soc2: "CC2.1 CC4.1", nis2: "Art.21(2)(f)" }),
  uc("UC-GOV-06", "Internal audit and independent review", "Independent assessment of control design and operating effectiveness.", { iso27001: "C9.2 A5.35 A5.36", nist_csf: "ID.IM", soc2: "CC4.1 CC4.2", nis2: "Art.21(2)(f)" }),
  uc("UC-GOV-07", "Continual improvement and corrective action", "Nonconformity handling, root-cause analysis and tracked improvement actions.", { iso27001: "C6.3 C10.1 C10.2", nist_csf: "ID.IM", soc2: "CC4.2", dora: "Art.13" }),
  uc("UC-GOV-08", "Communication and external contacts", "Internal and external communication of security matters, contact with authorities and special interest groups.", { iso27001: "C7.4 A5.5 A5.6", soc2: "CC2.2 CC2.3" }),
  uc("UC-CMP-01", "Legal, regulatory and contractual compliance", "Register of applicable obligations, intellectual-property compliance and compliance monitoring.", { iso27001: "A5.31 A5.32 A5.36", nist_csf: "GV.OC", soc2: "CC2.3" }),

  // Assets and data
  uc("UC-ASM-01", "Asset inventory and ownership", "Complete inventory of information, hardware, software and services with owners, acceptable use and return.", { iso27001: "A5.9 A5.10 A5.11", nist_csf: "ID.AM", nis2: "Art.21(2)(i)", dora: "Art.8", cis_v8: "CIS.1 CIS.2" }),
  uc("UC-DAT-01", "Data classification, labelling and transfer", "Classification scheme with labelling and rules for information transfer.", { iso27001: "A5.12 A5.13 A5.14", soc2: "C1.1", cis_v8: "CIS.3" }),
  uc("UC-DAT-02", "Retention, deletion and secure disposal", "Retention schedules, secure deletion and records protection.", { iso27001: "A5.33 A8.10 A7.14", soc2: "C1.2 CC6.5 P4", pci_dss: "Req.3" }),
  uc("UC-DAT-03", "Cryptography and key management", "Approved algorithms, encryption in transit and at rest, key lifecycle management.", { iso27001: "A8.24", nist_csf: "PR.DS", soc2: "CC6.7", gdpr: "Art.32", nis2: "Art.21(2)(h)", dora: "Art.9", pci_dss: "Req.3 Req.4", cis_v8: "CIS.3" }),
  uc("UC-DAT-04", "Data leakage prevention and masking", "Controls preventing unauthorised data exfiltration and exposure of sensitive data.", { iso27001: "A8.11 A8.12", nist_csf: "PR.DS", soc2: "CC6.7" }),
  uc("UC-DAT-05", "Backup and restoration", "Tested backups protected from tampering, with defined recovery objectives.", { iso27001: "A8.13", soc2: "A1.2 A1.3", nis2: "Art.21(2)(c)", dora: "Art.12", cis_v8: "CIS.11" }),

  // Identity and access
  uc("UC-IAM-01", "Identity lifecycle and access provisioning", "Joiner-mover-leaver processes, periodic access review and role-based access.", { iso27001: "A5.16 A5.18 A6.5", nist_csf: "PR.AA", soc2: "CC6.2 CC6.3", nis2: "Art.21(2)(i)", pci_dss: "Req.7", cis_v8: "CIS.5 CIS.6" }),
  uc("UC-IAM-02", "Strong authentication and MFA", "Multi-factor authentication, credential policy and secure authentication mechanisms.", { iso27001: "A5.17 A8.5", nist_csf: "PR.AA", soc2: "CC6.1", nis2: "Art.21(2)(j)", pci_dss: "Req.8" }),
  uc("UC-IAM-03", "Privileged access management", "Restricted, approved and logged privileged access and utility programs.", { iso27001: "A8.2 A8.18", nist_csf: "PR.AA", soc2: "CC6.3" }),
  uc("UC-IAM-04", "Access control policy and least privilege", "Access control policy, information access restriction and source-code access control.", { iso27001: "A5.15 A8.3 A8.4", nist_csf: "PR.AA", soc2: "CC6.1", pci_dss: "Req.7", cis_v8: "CIS.6" }),

  // Operations
  uc("UC-OPS-01", "Secure configuration and hardening", "Baseline configurations, drift detection and hardening standards.", { iso27001: "A8.9", nist_csf: "PR.PS", soc2: "CC7.1", dora: "Art.9", pci_dss: "Req.2", cis_v8: "CIS.4" }),
  uc("UC-OPS-02", "Vulnerability and patch management", "Continuous vulnerability identification, risk-based prioritisation and timely patching.", { iso27001: "A8.8", nist_csf: "ID.RA", soc2: "CC7.1", nis2: "Art.21(2)(e)", dora: "Art.9", pci_dss: "Req.6", cis_v8: "CIS.7" }),
  uc("UC-OPS-03", "Malware and endpoint protection", "Endpoint hardening and detection, malware defences and email/web protection.", { iso27001: "A8.7 A8.1", nist_csf: "PR.PS", soc2: "CC6.8", pci_dss: "Req.5", cis_v8: "CIS.9 CIS.10" }),
  uc("UC-OPS-04", "Network security and segmentation", "Perimeter and internal network controls, segregation, secure network services and web filtering.", { iso27001: "A8.20 A8.21 A8.22 A8.23", nist_csf: "PR.IR", soc2: "CC6.6", pci_dss: "Req.1", cis_v8: "CIS.12" }),
  uc("UC-OPS-05", "Logging, monitoring and detection", "Centralised, protected logs with clock sync, continuous monitoring and alerting.", { iso27001: "A8.15 A8.16 A8.17", nist_csf: "DE.CM DE.AE", soc2: "CC7.2 CC7.3", dora: "Art.10", pci_dss: "Req.10", cis_v8: "CIS.8 CIS.13" }),
  uc("UC-OPS-06", "Change management", "Authorised, tested and reversible changes to production systems.", { iso27001: "A8.32", soc2: "CC8.1 CC5.2" }),
  uc("UC-OPS-07", "Capacity and redundancy", "Capacity planning and redundant processing facilities to meet availability targets.", { iso27001: "A8.6 A8.14", nist_csf: "PR.IR", soc2: "A1.1", dora: "Art.7" }),
  uc("UC-OPS-08", "Software installation and operational procedures", "Controlled installation of software on production systems and ICT system standards.", { iso27001: "A8.19", dora: "Art.7", soc2: "CC5.2" }),
  uc("UC-OPS-09", "Security and resilience testing", "Penetration testing, scenario-based and threat-led testing, protected audit testing.", { iso27001: "A8.29 A8.34", dora: "Art.24 Art.25 Art.26", soc2: "CC4.1", pci_dss: "Req.11", cis_v8: "CIS.18" }),
  uc("UC-OPS-10", "Threat intelligence and information sharing", "Collection, analysis and sharing of threat information.", { iso27001: "A5.7", nist_csf: "ID.RA", dora: "Art.45" }),
  uc("UC-OPS-11", "Processing integrity and data quality", "Input, processing and output controls that keep data complete, accurate and timely.", { soc2: "PI1.1 PI1.2 PI1.3 PI1.4 PI1.5 P7" }),

  // Secure development
  uc("UC-SDL-01", "Secure development lifecycle", "Security requirements, secure design and coding, testing, environment separation and outsourced development control.", { iso27001: "A5.8 A8.25 A8.26 A8.27 A8.28 A8.29 A8.30 A8.31 A8.33", nist_csf: "PR.PS", soc2: "CC8.1", nis2: "Art.21(2)(e)", pci_dss: "Req.6", cis_v8: "CIS.16" }),

  // Incident response and resilience
  uc("UC-INC-01", "Incident management and response", "Detection, triage, response, evidence collection and lessons learned.", { iso27001: "A5.24 A5.25 A5.26 A5.27 A5.28 A6.8", nist_csf: "RS.MA RS.AN RS.MI", soc2: "CC7.3 CC7.4 CC7.5", nis2: "Art.21(2)(b)", dora: "Art.13 Art.17 Art.18", cis_v8: "CIS.17" }),
  uc("UC-INC-02", "Incident reporting and notification", "Regulatory, customer and data-subject notification within statutory deadlines.", { nist_csf: "RS.CO", nis2: "Art.23(1) Art.23(2) Art.23(4)", dora: "Art.19", gdpr: "Art.33 Art.34", eu_ai_act: "Art.73", soc2: "P6" }),
  uc("UC-BCP-01", "Business continuity and disaster recovery", "Impact analysis, continuity and recovery plans, tested ICT readiness.", { iso27001: "A5.29 A5.30", nist_csf: "RC.RP", soc2: "CC9.1 A1.3 CC7.5", nis2: "Art.21(2)(c)", dora: "Art.11" }),
  uc("UC-BCP-02", "Crisis and recovery communication", "Crisis management and communication with stakeholders during and after disruption.", { nist_csf: "RC.CO", dora: "Art.14" }),

  // People and physical
  uc("UC-HR-01", "Screening and employment terms", "Background checks, security terms in employment, confidentiality agreements and disciplinary process.", { iso27001: "A6.1 A6.2 A6.4 A6.5 A6.6", soc2: "CC1.1 CC1.4", nis2: "Art.21(2)(i)" }),
  uc("UC-HR-02", "Awareness, training and competence", "Role-based security awareness, competence management and AI literacy.", { iso27001: "A6.3 C7.2 C7.3", nist_csf: "PR.AT", soc2: "CC1.4", nis2: "Art.21(2)(g)", cis_v8: "CIS.14", eu_ai_act: "Art.4" }),
  uc("UC-HR-03", "Remote working and acceptable use", "Controls for remote and mobile work and acceptable use of assets.", { iso27001: "A6.7 A5.10" }),
  uc("UC-PHY-01", "Physical and environmental security", "Perimeters, entry control, monitoring, utilities, cabling and equipment protection.", { iso27001: "A7.1 A7.2 A7.3 A7.4 A7.5 A7.6 A7.7 A7.8 A7.11 A7.12 A7.13", nist_csf: "PR.IR", soc2: "CC6.4 A1.2", pci_dss: "Req.9" }),
  uc("UC-PHY-02", "Media, off-premises assets and disposal", "Protection of storage media and assets outside premises, and secure re-use or disposal.", { iso27001: "A7.9 A7.10 A7.14", soc2: "CC6.5" }),

  // Third parties
  uc("UC-TPM-01", "Supplier due diligence and monitoring", "Risk-tiered onboarding, ongoing monitoring and supply-chain risk management.", { iso27001: "A5.19 A5.21 A5.22", nist_csf: "GV.SC", soc2: "CC9.2", nis2: "Art.21(2)(d)", dora: "Art.28", cis_v8: "CIS.15" }),
  uc("UC-TPM-02", "Supplier agreements", "Security, audit, exit and data-protection clauses in supplier contracts.", { iso27001: "A5.20", dora: "Art.28 Art.30", gdpr: "Art.28" }),
  uc("UC-TPM-03", "Cloud service security", "Cloud adoption, shared-responsibility and exit management.", { iso27001: "A5.23" }),
  uc("UC-TPM-04", "ICT concentration risk and register of information", "Register of ICT third parties and assessment of concentration and substitutability.", { dora: "Art.28(3) Art.29" }),

  // Privacy
  uc("UC-PRV-01", "Privacy governance and records of processing", "Lawful basis, consent, records of processing, controller accountability and joint-controller arrangements.", { iso27001: "A5.34", gdpr: "Art.5 Art.6 Art.7 Art.9 Art.24 Art.26 Art.30", soc2: "P1 P2 P3 P4" }),
  uc("UC-PRV-02", "Data subject rights and transparency", "Privacy notices and fulfilment of access, rectification, erasure, portability and objection requests.", { gdpr: "Art.12 Art.13 Art.14 Art.15 Art.16 Art.17 Art.18 Art.20 Art.21 Art.22", soc2: "P1 P5" }),
  uc("UC-PRV-03", "DPIA and privacy by design", "Impact assessments, prior consultation and privacy by design and by default.", { gdpr: "Art.25 Art.32 Art.35 Art.36" }),
  uc("UC-PRV-04", "DPO and processor oversight", "Data protection officer function and processor management.", { gdpr: "Art.28 Art.37 Art.38 Art.39", soc2: "P6 P8" }),
  uc("UC-PRV-05", "International data transfers", "Transfer mechanisms and assessments for personal data leaving the EEA.", { gdpr: "Art.44" }),

  // AI governance
  uc("UC-AI-01", "AI governance and management system", "AI policy, roles and a quality management system for AI.", { iso42001: "A2 A3 A4", eu_ai_act: "Art.17" }),
  uc("UC-AI-02", "AI risk and impact assessment", "AI risk management and assessment of impacts on individuals and fundamental rights.", { iso42001: "A5", eu_ai_act: "Art.9 Art.27" }),
  uc("UC-AI-03", "AI data governance", "Provenance, quality and bias management for training, validation and test data.", { iso42001: "A7", eu_ai_act: "Art.10" }),
  uc("UC-AI-04", "AI documentation, logging and transparency", "Technical documentation, record-keeping, user information, conformity assessment and registration.", { iso42001: "A6 A8", eu_ai_act: "Art.11 Art.12 Art.13 Art.43 Art.49 Art.50" }),
  uc("UC-AI-05", "Human oversight and responsible use", "Effective human oversight, deployer duties and defined use of AI systems.", { iso42001: "A9", eu_ai_act: "Art.14 Art.26", gdpr: "Art.22" }),
  uc("UC-AI-06", "AI accuracy, robustness and post-market monitoring", "Performance, robustness and cybersecurity evaluation with ongoing monitoring in production.", { eu_ai_act: "Art.15 Art.72" }),
  uc("UC-AI-07", "AI supply chain and customer relationships", "Governance of third-party models and obligations towards customers.", { iso42001: "A10" }),
];

/** Additional requirement references added as catalogues grew; merged into the controls above. */
const EXTRA: Array<[string, MapInput]> = [
  ["UC-PRV-01", { gdpr: "Art.8 Art.10 Art.11 Art.40 Art.42" }],
  ["UC-PRV-02", { gdpr: "Art.19" }],
  ["UC-PRV-04", { gdpr: "Art.27 Art.29 Art.31" }],
  ["UC-PRV-05", { gdpr: "Art.45 Art.46 Art.47 Art.48 Art.49" }],
  ["UC-GOV-01", { nis2: "Art.25", dora: "Art.15 Art.16", iso42001: "C4.4 C5.2 C7.5 C8.1" }],
  ["UC-GOV-02", { iso42001: "C5.1 C5.3 C7.1" }],
  ["UC-GOV-03", { iso42001: "C4.1 C4.2 C4.3" }],
  ["UC-GOV-04", { nis2: "Art.21(1)", iso42001: "C6.1 C8.2 C8.3" }],
  ["UC-GOV-05", { iso42001: "C6.2 C9.1 C9.3" }],
  ["UC-GOV-06", { iso42001: "C9.2" }],
  ["UC-GOV-07", { nis2: "Art.21(4)", iso42001: "C6.3 C10.1 C10.2" }],
  ["UC-GOV-08", { iso42001: "C7.4" }],
  ["UC-HR-02", { nis2: "Art.20(2)", iso42001: "C7.2 C7.3" }],
  ["UC-CMP-01", { nis2: "Art.24 Art.27", eu_ai_act: "Art.21" }],
  ["UC-TPM-01", { nis2: "Art.21(3) Art.22" }],
  ["UC-OPS-10", { nis2: "Art.29 Art.30" }],
  ["UC-INC-02", { dora: "Art.20 Art.21 Art.22 Art.23" }],
  ["UC-OPS-09", { dora: "Art.27" }],
  ["UC-AI-01", { eu_ai_act: "Art.8 Art.16" }],
  ["UC-AI-02", { eu_ai_act: "Art.5 Art.6 Art.51", iso42001: "C8.4" }],
  ["UC-AI-04", { eu_ai_act: "Art.18 Art.19 Art.47 Art.48 Art.53" }],
  ["UC-AI-05", { eu_ai_act: "Art.86" }],
  ["UC-AI-06", { eu_ai_act: "Art.20 Art.55" }],
  ["UC-AI-07", { eu_ai_act: "Art.22 Art.23 Art.24 Art.25" }],
];
for (const [code, extra] of EXTRA) {
  const control = UNIFIED_CONTROLS.find((item) => item.code === code);
  if (!control) throw new Error(`EXTRA references unknown control ${code}`);
  for (const [framework, ids] of Object.entries(extra)) control.map[framework as FrameworkId] = [...(control.map[framework as FrameworkId] ?? []), ...ids.split(/\s+/).filter(Boolean)];
}

export const UC_BY_CODE = new Map(UNIFIED_CONTROLS.map((control) => [control.code, control]));

export function effortOf(code: string) {
  return DOMAIN_EFFORT[(UC_BY_CODE.get(code)?.domain ?? "GOV") as UnifiedDomain];
}
