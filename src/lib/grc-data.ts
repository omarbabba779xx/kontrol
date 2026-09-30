export type RiskLevel = "Critical" | "High" | "Medium" | "Low";
export type Status = "Open" | "Mitigating" | "Accepted" | "Closed";

export const postureTrend = [
  { month: "Apr", score: 68, target: 85 },
  { month: "May", score: 71, target: 85 },
  { month: "Jun", score: 74, target: 85 },
  { month: "Jul", score: 78, target: 85 },
  { month: "Aug", score: 81, target: 85 },
  { month: "Sep", score: 84, target: 85 },
];

export const frameworkCoverage = [
  { name: "ISO 27001", value: 91, controls: 93, color: "#56d6a8" },
  { name: "NIST CSF 2.0", value: 87, controls: 106, color: "#69a9ff" },
  { name: "EU AI Act", value: 72, controls: 44, color: "#a78bfa" },
  { name: "ISO 42001", value: 78, controls: 38, color: "#f5b84b" },
  { name: "NIS2", value: 83, controls: 52, color: "#fb7185" },
];

export const riskDistribution = [
  { name: "Critical", value: 3, fill: "#ef6a74" },
  { name: "High", value: 8, fill: "#f5a54a" },
  { name: "Medium", value: 14, fill: "#e6ca5c" },
  { name: "Low", value: 7, fill: "#56d6a8" },
];

export const risks = [
  { id: "RSK-042", title: "Sensitive data exposure through GenAI prompts", domain: "AI & Privacy", level: "Critical" as RiskLevel, inherent: 25, residual: 16, owner: "Maya Chen", status: "Mitigating" as Status, due: "Oct 08", controls: 5, trend: "down" },
  { id: "RSK-038", title: "Concentration risk in primary cloud provider", domain: "Third party", level: "High" as RiskLevel, inherent: 20, residual: 12, owner: "Jon Bell", status: "Open" as Status, due: "Oct 14", controls: 4, trend: "flat" },
  { id: "RSK-035", title: "Model bias in credit decisioning workflow", domain: "Responsible AI", level: "High" as RiskLevel, inherent: 20, residual: 10, owner: "Leila Mansour", status: "Mitigating" as Status, due: "Oct 18", controls: 7, trend: "down" },
  { id: "RSK-031", title: "Privileged access reviews exceed SLA", domain: "Identity", level: "High" as RiskLevel, inherent: 16, residual: 12, owner: "Sam Ortega", status: "Open" as Status, due: "Oct 02", controls: 3, trend: "up" },
  { id: "RSK-027", title: "Incomplete supplier incident notification terms", domain: "Third party", level: "Medium" as RiskLevel, inherent: 12, residual: 8, owner: "Jon Bell", status: "Mitigating" as Status, due: "Oct 23", controls: 4, trend: "down" },
  { id: "RSK-019", title: "Backup restoration test coverage gap", domain: "Resilience", level: "Medium" as RiskLevel, inherent: 15, residual: 6, owner: "Nora Singh", status: "Accepted" as Status, due: "Nov 01", controls: 2, trend: "flat" },
];

export const controls = [
  { id: "CTL-001", name: "AI system inventory and ownership", family: "Governance", status: "Effective", automation: "Automated", evidence: 8, freshness: 100, frameworks: ["EU AI Act", "ISO 42001", "NIST AI RMF"], owner: "Leila Mansour", tested: "2h ago" },
  { id: "CTL-008", name: "Privileged access recertification", family: "Identity", status: "Needs attention", automation: "Automated", evidence: 12, freshness: 76, frameworks: ["ISO 27001", "NIST CSF", "NIS2"], owner: "Sam Ortega", tested: "18m ago" },
  { id: "CTL-014", name: "AI human oversight procedure", family: "Responsible AI", status: "Partial", automation: "Manual", evidence: 5, freshness: 62, frameworks: ["EU AI Act", "ISO 42001"], owner: "Maya Chen", tested: "4d ago" },
  { id: "CTL-021", name: "Critical supplier due diligence", family: "Third party", status: "Effective", automation: "Hybrid", evidence: 19, freshness: 94, frameworks: ["NIS2", "NIST CSF", "DORA"], owner: "Jon Bell", tested: "1d ago" },
  { id: "CTL-029", name: "Production data encryption", family: "Data security", status: "Effective", automation: "Automated", evidence: 24, freshness: 100, frameworks: ["ISO 27001", "NIS2", "DORA"], owner: "Nora Singh", tested: "7m ago" },
  { id: "CTL-033", name: "Model performance and drift monitoring", family: "Responsible AI", status: "Partial", automation: "Automated", evidence: 7, freshness: 83, frameworks: ["EU AI Act", "NIST AI RMF"], owner: "Leila Mansour", tested: "3h ago" },
  { id: "CTL-041", name: "Incident response tabletop exercise", family: "Resilience", status: "Effective", automation: "Manual", evidence: 9, freshness: 88, frameworks: ["ISO 27001", "NIST CSF", "NIS2", "DORA"], owner: "Nora Singh", tested: "12d ago" },
];

export const aiSystems = [
  { id: "AI-014", name: "Lending Decision Copilot", model: "Atlas Finance 3.2", provider: "In-house", purpose: "Credit recommendation", risk: "High-risk", status: "Conditional", score: 68, owner: "Leila Mansour", data: ["Financial", "Identity"], oversight: "Required", lastAssessment: "Sep 26", openFindings: 3 },
  { id: "AI-011", name: "Customer Support Assistant", model: "Hosted LLM A", provider: "Northwind AI", purpose: "Customer assistance", risk: "Limited risk", status: "Approved", score: 89, owner: "Maya Chen", data: ["Customer", "Support"], oversight: "Sampled", lastAssessment: "Sep 22", openFindings: 1 },
  { id: "AI-008", name: "Fraud Signal Engine", model: "XGBoost 2.1", provider: "In-house", purpose: "Fraud detection", risk: "High-risk", status: "Approved", score: 92, owner: "Sam Ortega", data: ["Transaction", "Device"], oversight: "Required", lastAssessment: "Sep 18", openFindings: 0 },
  { id: "AI-006", name: "Meeting Notes Generator", model: "Hosted LLM B", provider: "Contoso Cloud", purpose: "Productivity", risk: "Minimal risk", status: "Approved", score: 96, owner: "Nora Singh", data: ["Internal"], oversight: "Optional", lastAssessment: "Sep 12", openFindings: 0 },
];

export const evidence = [
  { id: "EVD-2041", name: "AWS production encryption configuration", source: "AWS Config", control: "CTL-029", status: "Healthy", collected: "7 min ago", expires: "in 23h", hash: "9c4a...e12f", automated: true },
  { id: "EVD-2038", name: "GitHub branch protection snapshot", source: "GitHub", control: "CTL-018", status: "Healthy", collected: "14 min ago", expires: "in 23h", hash: "71bf...d908", automated: true },
  { id: "EVD-2034", name: "Privileged account review export", source: "Okta", control: "CTL-008", status: "Stale", collected: "31 days ago", expires: "Expired", hash: "f81d...b01a", automated: true },
  { id: "EVD-2029", name: "AI impact assessment — Lending Copilot", source: "Manual upload", control: "CTL-014", status: "Review", collected: "4 days ago", expires: "in 86d", hash: "aac1...81ce", automated: false },
  { id: "EVD-2022", name: "Vendor security attestation", source: "OneTrust", control: "CTL-021", status: "Healthy", collected: "8 days ago", expires: "in 357d", hash: "143d...bc91", automated: true },
];

export const vendors = [
  { name: "Amazon Web Services", service: "Cloud infrastructure", tier: "Critical", score: 86, exposure: "$4.2M", systems: 18, status: "Monitored", assessment: "Sep 21", concentration: 74 },
  { name: "Contoso Cloud AI", service: "Generative AI API", tier: "Critical", score: 78, exposure: "$1.8M", systems: 4, status: "Action needed", assessment: "Sep 25", concentration: 41 },
  { name: "Okta", service: "Identity provider", tier: "Critical", score: 91, exposure: "$3.1M", systems: 12, status: "Monitored", assessment: "Sep 12", concentration: 62 },
  { name: "Datadog", service: "Observability", tier: "High", score: 88, exposure: "$890K", systems: 9, status: "Monitored", assessment: "Aug 30", concentration: 35 },
  { name: "Workday", service: "HR information system", tier: "High", score: 82, exposure: "$720K", systems: 3, status: "Review due", assessment: "Jun 18", concentration: 28 },
];

export const activities = [
  { title: "Automated test passed", detail: "Production encryption • CTL-029", time: "7m", tone: "success" },
  { title: "Evidence expired", detail: "Privileged access review • CTL-008", time: "18m", tone: "danger" },
  { title: "Risk score improved", detail: "Model bias risk moved 16 → 10", time: "2h", tone: "success" },
  { title: "New regulatory update", detail: "EU AI Act transparency guidance", time: "5h", tone: "info" },
  { title: "Owner reassigned", detail: "RSK-027 assigned to Jon Bell", time: "1d", tone: "neutral" },
];

export const obligations = [
  { framework: "EU AI Act", change: "Transparency obligations enforceable for applicable AI systems", effective: "Aug 02, 2026", impact: "High", affected: "12 controls", state: "Action required" },
  { framework: "NIS2", change: "ENISA technical implementation guidance mapping updated", effective: "Jun 26, 2025", impact: "Medium", affected: "8 controls", state: "Mapped" },
  { framework: "NIST AI RMF", change: "Critical Infrastructure Profile concept note published", effective: "Apr 07, 2026", impact: "Medium", affected: "5 controls", state: "Reviewing" },
  { framework: "DORA", change: "Register of information validation package refreshed", effective: "Sep 11, 2026", impact: "Low", affected: "3 controls", state: "Mapped" },
];

export const audits = [
  { name: "ISO 27001 Surveillance", auditor: "BSI Group", window: "Nov 04–08", readiness: 92, evidence: "184 / 196", gaps: 4, status: "On track" },
  { name: "EU AI Act Readiness", auditor: "Internal assurance", window: "Oct 14–25", readiness: 76, evidence: "58 / 74", gaps: 9, status: "At risk" },
  { name: "NIS2 Control Review", auditor: "KPMG", window: "Dec 02–06", readiness: 84, evidence: "91 / 108", gaps: 6, status: "On track" },
];
