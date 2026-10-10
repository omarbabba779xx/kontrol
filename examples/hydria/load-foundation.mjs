// Loads the foundation of the Hydria example dossier through the public API: people, context, scope,
// policy, objectives, competence and communication records, and the two adopted frameworks.
//
//   node examples/hydria/load-foundation.mjs            (server on http://localhost:3000, demo sign-in)
//
// Hydria is a fictional water utility. Nothing here describes a real organisation.
// The script stops if the organisation already has context records, so it never loads twice.

const BASE = process.env.KONTROL_URL ?? "http://localhost:3000";
const iso = (date) => new Date(`${date}T09:00:00Z`).toISOString();

async function call(path, body) {
  const response = await fetch(`${BASE}${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} ${body?.action ?? "GET"} -> ${response.status} ${JSON.stringify(data)}`);
  return data;
}
const isms = (body) => call("/api/isms", body);

const before = await isms();
if (before.context?.length) {
  console.log(`Already loaded: ${before.context.length} context records. Nothing done.`);
  process.exit(0);
}

// ---------------------------------------------------------------- people
// The built-in administrator stands for Hydria's managing director, who approves the scope, the method and the review.
const { me } = await call("/api/users");
await call("/api/admin", { action: "rename_user", userId: me, name: "Rachid Alaoui (Managing director)" });
await call("/api/admin", { action: "rename_organisation", name: "Hydria", region: "MA" });
const people = {};
for (const [key, name, role] of [
  ["ciso", "Salma Idrissi (CISO)", "risk_owner"],
  ["soc", "Karim Bennani (SOC manager)", "control_owner"],
  ["dpo", "Nadia El Fassi (Data protection officer)", "control_owner"],
  ["itops", "Hicham Tazi (IT operations manager)", "control_owner"],
  ["audit", "Youssef Amrani (Internal auditor)", "auditor"],
]) {
  const created = await call("/api/admin", { action: "invite_user", email: `${key}@hydria.example`, name, role });
  people[key] = created.id ?? created.user?.id ?? created.userId;
  if (!people[key]) throw new Error(`No id returned for ${name}: ${JSON.stringify(created)}`);
}

// ---------------------------------------------------------------- clause 4.1 and 4.2
const context = [
  ["internal_issue", "The SOC relies on AI-assisted triage", "A local language model proposes the incident type, the ATT&CK technique and a summary for each alert. Analysts may come to trust that output more than the evidence supports."],
  ["internal_issue", "IT and OT are run by separate teams", "The office network and the industrial control network have different owners and procedures, but share one identity directory."],
  ["internal_issue", "A small security team", "One CISO and six analysts. Several procedures are known by one person only."],
  ["internal_issue", "A legacy customer information system", "The billing application predates current logging practice: few security events, no native export to the SIEM."],
  ["external_issue", "Operator of an essential service", "Water supply and billing must stay available. The national cybersecurity law (Law 05-20) and the directives of the national authority apply; which obligations bind Hydria exactly is to be confirmed with Legal."],
  ["external_issue", "Personal data of about 410,000 customers", "Identity, address, consumption and payment data fall under the personal data protection law (Law 09-08)."],
  ["external_issue", "Ransomware and supplier compromise in the utility sector", "Utilities are a regular target, and attacks increasingly arrive through a supplier's access."],
  ["external_issue", "Dependence on a few suppliers", "The billing software vendor, the telecom operator and the hosted email provider each support a critical activity."],
];
const parties = [
  ["Customers", "Households and businesses supplied by Hydria.", "Their personal and billing data stay confidential and accurate; the service and the customer portal stay available."],
  ["National cybersecurity authority (DGSSI)", "Sets the national information security directive and receives incident reports.", "Security measures in line with the national directive; incidents reported as the applicable texts require."],
  ["Personal data protection authority (CNDP)", "Supervises the processing of personal data.", "Lawful, declared processing; personal-data incidents assessed and handled as Law 09-08 requires."],
  ["Delegating public authority", "Grants the service contract and audits its performance.", "Continuity of service, and reporting on major incidents affecting customers."],
  ["Executive committee", "Accountable for the risk the company accepts.", "Risk kept within the approved appetite; a quarterly report and a say on every risk above it."],
  ["SOC analysts and IT staff", "Operate the controls every day.", "Clear procedures, training for their role, and an explicit statement of what the AI may propose and what a person must decide."],
  ["Suppliers with access to systems or data", "Billing software vendor, telecom operator, hosted email provider.", "Security requirements stated in the contract, and a named contact for incidents."],
];
for (const [kind, title, detail] of context) await isms({ action: "save_context", kind, title, detail });
for (const [title, detail, requirement] of parties) await isms({ action: "save_context", kind: "interested_party", title, detail, requirement });

// ---------------------------------------------------------------- clause 4.3
await isms({
  action: "approve_scope",
  statement:
    "The information security management system of Hydria covers two services and the people, processes and technology that deliver them: (1) the Security Operations Centre: monitoring, detection, triage including the AI-assisted triage pipeline, and incident response; (2) the customer information system: customer records, billing and the payment interfaces. Both are operated from the head office and the primary datacentre.",
  boundaries:
    "Interfaces at the edge of the scope: the one-way collection of logs from the industrial control network; the identity directory shared with the rest of the company; the HR system that feeds joiners and leavers; the remote access of the billing software vendor; the hosted email service used for incident notification.",
  exclusions:
    "The industrial control systems themselves (SCADA, telemetry, field equipment) are managed under the industrial safety programme; only the log interface is in scope. The physical security of the customer agencies and the subsidiaries are excluded from this first version. Each exclusion is reviewed when the scope is next revised.",
});

// ---------------------------------------------------------------- clause 5.2
const policy = `# Information security policy

Hydria supplies drinking water to about 410,000 customers. Protecting the information and the systems that service depends on is part of delivering it.

## What we commit to

1. **Protect what customers entrust to us.** Personal and billing data are accessed only by people who need them for their work.
2. **Keep the service running.** Security decisions weigh availability of supply and billing alongside confidentiality.
3. **Manage risk deliberately.** Risks are assessed with one approved method. A risk above the approved appetite is decided by management, never left implicit.
4. **Meet our obligations.** We identify the legal, regulatory and contractual requirements that apply to us and show how each is met.
5. **Keep people in charge of automated decisions.** Automated analysis, including AI, may propose; a named person decides on any action that affects a customer, a system or an investigation.
6. **Learn from incidents.** Every incident is recorded, its cause is sought, and the correction is checked by someone other than the person who made it.
7. **Improve.** Objectives are measured, audits are planned, and management reviews the system at least once a year.

## Who is responsible

The executive committee approves this policy and the risk appetite. The CISO runs the management system and reports on it. Each control has a named owner. Every employee and supplier with access follows the rules that apply to their role.

## Review

This policy is reviewed every twelve months, and earlier after a major incident or a change of scope.
`;
await call("/api/compliance", { action: "save_policy", title: "Information security policy", version: "1.0", status: "approved", ownerId: people.ciso, nextReview: iso("2027-10-10"), ucCodes: ["UC-GOV-01"], content: policy });

// ---------------------------------------------------------------- clause 6.2
for (const [title, measure, target, owner, due] of [
  ["Contain serious incidents quickly", "Median time from detection to containment for high and critical incidents, per quarter", "4 hours or less", "soc", "2027-06-30"],
  ["Keep a person in charge of AI-assisted triage", "Share of high-severity alerts triaged by the model that an analyst reviewed before closure", "100%", "soc", "2027-03-31"],
  ["Reduce exposure to phishing", "Click rate in the quarterly phishing simulation", "5% or less", "ciso", "2027-06-30"],
  ["Know the security of critical suppliers", "Share of critical suppliers with a security assessment less than twelve months old", "100%", "itops", "2027-09-30"],
  ["Assess personal-data incidents in time", "Share of personal-data incidents assessed within 72 hours of awareness", "100%", "dpo", "2027-06-30"],
]) await isms({ action: "save_objective", title, measure, target, ownerId: people[owner], dueAt: iso(due), status: "planned" });

// ---------------------------------------------------------------- clauses 7.2 and 7.4
for (const [title, status, owner, competence, evidence, action, due] of [
  ["SOC analyst", "met", "soc", "Alert triage, incident handling, and the limits of the AI triage output", "Induction record and two supervised incidents per analyst", "", null],
  ["Internal auditor", "gap", "audit", "ISO/IEC 27001 internal audit method, independent of the areas audited", "No formal auditor training yet", "ISO/IEC 27001 internal auditor course before the first audit", "2027-01-31"],
  ["Data protection officer", "met", "dpo", "Law 09-08, personal-data incident assessment and notification", "Appointment letter and training certificate", "", null],
]) await isms({ action: "save_record", kind: "competence", title, status, ownerId: people[owner], dueAt: due ? iso(due) : null, detail: { competence, evidence, action } });

for (const [title, owner, scope, audience, timing, channel] of [
  ["Security status report", "ciso", "internal", "Executive committee", "Every quarter, and after any major incident", "Written report presented in committee"],
  ["Security rules and incident reporting", "ciso", "internal", "All employees and contractors", "At induction, then yearly", "Awareness platform and intranet"],
  ["Incident notification to the authorities", "dpo", "external", "National cybersecurity authority and personal data authority, as applicable", "Within the deadline the applicable text sets, once the incident is confirmed", "The authority's official channel, prepared with Legal"],
  ["Information to customers after a data incident", "dpo", "external", "Affected customers", "Without undue delay when their data is at risk", "Letter or email, with the helpline number"],
]) await isms({ action: "save_record", kind: "communication", title, status: "active", ownerId: people[owner], detail: { scope, audience, timing, channel } });

// ---------------------------------------------------------------- frameworks
await call("/api/compliance", { action: "adopt_framework", frameworkId: "iso27001", scope: "SOC service and customer information system, as in the approved ISMS scope", targetDate: "2027-12-31" });
await call("/api/compliance", { action: "adopt_framework", frameworkId: "iso42001", scope: "The AI-assisted triage pipeline of the SOC", targetDate: "2027-12-31" });

const after = await isms();
const tally = after.clauses.reduce((count, check) => ({ ...count, [check.status]: (count[check.status] ?? 0) + 1 }), {});
console.log(`Loaded. Clause checklist: ${JSON.stringify(tally)}`);
for (const check of after.clauses) console.log(`  ${check.status.padEnd(8)} ${check.clause.padEnd(8)} ${check.title}`);
