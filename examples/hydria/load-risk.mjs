// Second step of the Hydria example dossier: the organisation's name, the approved risk method, the asset inventory and its
// valuation, the risk scenarios, the state of the controls, the treatment decisions and one acceptance by a second person.
//
//   node examples/hydria/load-risk.mjs        (after load-foundation.mjs)
//
// Hydria is fictional. Three people act here, as they would in an organisation: the administrator approves the method and
// accepts a risk, the CISO records the assets and the risks, and the owners are the people named on each record.

const BASE = process.env.KONTROL_URL ?? "http://localhost:3000";
const iso = (date) => new Date(`${date}T09:00:00Z`).toISOString();

async function call(path, body, token) {
  const headers = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(`${BASE}${path}`, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} ${body?.action ?? "GET"} -> ${response.status} ${JSON.stringify(data)}`);
  return data;
}

const { users } = await call("/api/users");
const person = (label) => {
  const found = users.find((user) => user.name.includes(label));
  if (!found) throw new Error(`Run load-foundation.mjs first: nobody matches "${label}"`);
  return found.id;
};
const people = { ciso: person("CISO"), soc: person("SOC manager"), dpo: person("Data protection"), itops: person("IT operations"), audit: person("Internal auditor") };
const cisoToken = (await call("/api/session/demo", { userId: people.ciso })).token;
const admin = (body) => call("/api/risk-register", body);
const ciso = (body) => call("/api/risk-register", body, cisoToken);

const register = await call("/api/risk-register");
if ((register.risks ?? register.items ?? []).length) {
  console.log("Risks are already recorded. Nothing done.");
  process.exit(0);
}

// ---------------------------------------------------------------- the organisation and its method (administrator)
await call("/api/admin", { action: "rename_organisation", name: "Hydria", region: "MA" });
await admin({
  action: "set_method",
  method: "iso27005",
  thresholds: { medium: 5, high: 10, critical: 17 },
  appetite: "medium",
  maxAcceptanceDays: 180,
  likelihoodLabels: ["Rare: not expected within five years", "Unlikely: once in two to five years", "Possible: once a year", "Likely: several times a year", "Almost certain: monthly or more"],
  impactLabels: ["Negligible", "Minor", "Moderate", "Major", "Severe"],
  impactCriteria: [
    "No effect on customers or on the service",
    "A few customers inconvenienced for less than a day",
    "A service or a customer group affected for up to two days, or a contained personal-data incident",
    "Billing or monitoring unavailable for several days, or personal data of many customers exposed",
    "Water supply threatened, or personal data of most customers exposed",
  ],
  impactCriteriaByDimension: {
    confidentiality: ["Public information", "Internal information seen by the wrong team", "Personal data of fewer than 1,000 customers exposed", "Personal or payment data of tens of thousands of customers exposed", "Personal data of most customers exposed, or credentials to industrial systems"],
    integrity: ["Error corrected the same day with no effect", "A few bills or records wrong and corrected", "A billing run wrong, or detection rules altered without notice", "Customer records or alerts unreliable for days", "Decisions on the supply taken on falsified data"],
    availability: ["Less than an hour", "Up to four hours in working time", "Up to one day for billing, or up to four hours without monitoring", "Several days for billing, or a day without monitoring", "More than a week, or any effect on the water supply"],
  },
});

// ---------------------------------------------------------------- the inventory (CISO)
for (const asset of (await call("/api/risk-register?view=identification")).assets ?? []) {
  // The demonstration tenant ships with two sample assets that are not Hydria's.
  if (asset.id.startsWith("asset_ai_") || asset.id.startsWith("asset_repo_")) await ciso({ action: "retire_asset", assetId: asset.id, reason: "Sample asset of the demonstration data, not part of Hydria" });
}
const assets = {};
for (const [key, name, type, criticality, owner, description, c, i, a, rationale] of [
  ["cis", "Customer information system", "application", "critical", "itops", "Customer records, billing runs and payment interfaces", 4, 5, 4, "Bills must be right and issued on time; the application reads all customer data"],
  ["db", "Customer database", "data", "critical", "dpo", "Identity, address, consumption and payment data of about 410,000 customers", 5, 4, 3, "Personal data at scale; the application tolerates a short outage"],
  ["siem", "Detection platform (SIEM)", "service", "critical", "soc", "Log collection, detection rules and alerting for the SOC", 3, 4, 5, "Without it incidents go unseen; its rules decide alert severity"],
  ["ai", "AI triage pipeline", "ai_model", "high", "soc", "Local language model that proposes an incident type, an ATT&CK technique and a summary for each alert", 3, 4, 3, "Advisory only: a wrong output misleads an analyst but triggers no action by itself"],
  ["idp", "Identity directory", "infrastructure", "critical", "itops", "Single directory for office and industrial accounts", 5, 5, 5, "Whoever controls it controls every system in and out of scope"],
  ["ot", "Industrial log interface", "infrastructure", "high", "soc", "One-way collection of logs from the industrial control network", 3, 4, 4, "The only link between the two networks; it must stay one-way"],
  ["vendor", "Billing software vendor", "vendor", "high", "itops", "Maintains the customer information system, with remote access", 4, 4, 4, "Remote access to the application and its data; sole source of fixes"],
  ["team", "SOC team", "people", "high", "ciso", "Six analysts and their manager", 2, 3, 4, "Small team: the loss of two people stops round-the-clock cover"],
]) {
  assets[key] = (await ciso({ action: "register_asset", name, type, criticality, ownerId: people[owner], description })).id;
  await ciso({ action: "value_asset", assetId: assets[key], confidentiality: c, integrity: i, availability: a, rationale });
}

// ---------------------------------------------------------------- the state of the controls (administrator, with their owners)
for (const [ucCode, status, maturity, owner, notes] of [
  ["UC-GOV-01", "implemented", 3, "ciso", "Information security policy 1.0 approved by the executive committee."],
  ["UC-GOV-02", "partial", 2, "ciso", "Roles are named. Segregation of duties in the billing application has not been reviewed."],
  ["UC-GOV-03", "implemented", 3, "ciso", "Context, interested parties and scope recorded and approved."],
  ["UC-GOV-04", "partial", 2, "ciso", "Method approved and first assessment done; treatment is under way."],
  ["UC-GOV-05", "planned", 1, "ciso", "Objectives are set; the first measurements and the first management review are planned."],
  ["UC-GOV-06", "planned", 1, "audit", "First internal audit planned once the auditor is trained."],
  ["UC-GOV-07", "planned", 1, "ciso", "Corrective-action process defined, not yet exercised."],
  ["UC-CMP-01", "partial", 2, "ciso", "Applicable laws listed; the exact obligations under the national cybersecurity law await Legal's confirmation."],
  ["UC-ASM-01", "partial", 2, "itops", "Inventory covers the systems in scope; owners named for the main assets only."],
  ["UC-IAM-01", "partial", 2, "itops", "Joiners handled through HR; leavers' accounts are sometimes disabled late."],
  ["UC-IAM-02", "partial", 2, "itops", "MFA on remote access and administrator accounts, not yet on every staff account."],
  ["UC-IAM-03", "planned", 1, "itops", "Privileged accounts are personal but not vaulted or recorded."],
  ["UC-IAM-04", "partial", 2, "itops", "Access by role in the billing application; no periodic review yet."],
  ["UC-OPS-01", "partial", 2, "itops", "Hardening baseline for servers, not for network equipment."],
  ["UC-OPS-02", "partial", 2, "itops", "Monthly patching; the billing application depends on the vendor's schedule."],
  ["UC-OPS-03", "implemented", 3, "itops", "Endpoint protection on all workstations and servers in scope."],
  ["UC-OPS-04", "partial", 3, "itops", "Office and industrial networks are separated; the log interface is one-way. Internal segmentation of the office network is coarse."],
  ["UC-OPS-05", "implemented", 3, "soc", "Central log collection and detection rules; alert severity is set by the rules, never by the model."],
  ["UC-OPS-06", "partial", 2, "itops", "Changes are requested and approved; vendor changes to the billing application are not always tested first."],
  ["UC-OPS-07", "partial", 2, "itops", "Redundant datacentre power and network; the detection platform runs on a single node."],
  ["UC-OPS-08", "partial", 2, "soc", "Main SOC procedures written; several remain known by one analyst."],
  ["UC-OPS-09", "planned", 1, "itops", "No restoration or penetration test in the last twelve months."],
  ["UC-DAT-01", "planned", 1, "dpo", "Classification scheme drafted, not applied."],
  ["UC-DAT-03", "partial", 2, "itops", "Encryption in transit everywhere; database encryption at rest not enabled."],
  ["UC-DAT-04", "planned", 1, "dpo", "No control on exports from the customer database."],
  ["UC-DAT-05", "partial", 2, "itops", "Daily backups kept off site; the last restoration test of the customer database is over a year old."],
  ["UC-INC-01", "implemented", 3, "soc", "Incident procedure with severity levels and an on-call rota."],
  ["UC-INC-02", "partial", 2, "dpo", "Notification steps written for personal-data incidents; contacts at the authorities to be confirmed."],
  ["UC-BCP-01", "partial", 2, "itops", "Continuity plan for the datacentre; not tested with the billing vendor."],
  ["UC-BCP-02", "planned", 1, "ciso", "Crisis communication plan in draft."],
  ["UC-HR-02", "partial", 2, "ciso", "Yearly awareness and quarterly phishing simulations; no role-specific training for administrators."],
  ["UC-TPM-01", "planned", 1, "itops", "No security assessment of the billing vendor yet."],
  ["UC-TPM-02", "partial", 2, "itops", "Security clauses in the vendor contract; remote access conditions are not stated."],
  ["UC-PRV-01", "partial", 2, "dpo", "Processing activities listed; declarations to the authority under review."],
  ["UC-PRV-03", "planned", 1, "dpo", "No impact assessment yet for the AI triage of logs that may contain personal data."],
  ["UC-AI-01", "planned", 1, "soc", "AI use is governed by the security policy only; no dedicated management system yet."],
  ["UC-AI-02", "partial", 2, "soc", "Risks of the triage pipeline assessed in this register."],
  ["UC-AI-04", "partial", 2, "soc", "Every model output is stored with the alert it concerns."],
  ["UC-AI-05", "implemented", 3, "soc", "The model proposes; an analyst decides. No automated action depends on its output."],
  ["UC-AI-06", "partial", 2, "soc", "Accuracy measured once on a held-out set of alerts; no continuous monitoring."],
  ["UC-PHY-01", "implemented", 3, "itops", "Datacentre access by badge with a visitor log; fire detection and suppression."],
  ["UC-SDL-01", "not_applicable", 0, "itops", "Hydria develops no software in scope: the customer information system is maintained by its vendor, under UC-TPM-01 and UC-TPM-02."],
]) await call("/api/compliance", { action: "set_implementation", ucCode, status, maturity, ownerId: people[owner], notes });

// ---------------------------------------------------------------- the scenarios (recorded by the CISO, owned by the people in charge)
const plans = [
  ["cis", "TH-INF-04", 3, "itops", "Segment the billing servers, enable database encryption, and test restoration of the customer database", "2027-03-31"],
  ["cis", "TH-INF-01", 3, "itops", "Agree a patch deadline with the vendor and scan the application monthly", "2027-02-28"],
  ["cis", "TH-INF-07", 3, "itops", "Assess the vendor's security and restrict its remote access to approved, recorded sessions", "2027-03-31"],
  ["cis", "TH-TEC-02", 3, "itops", "Require vendor changes to pass a test environment before production", "2027-01-31"],
  ["db", "TH-INF-08", 2, "dpo", "Review access to customer data every quarter and log exports", "2027-03-31"],
  ["db", "TH-ORG-03", 2, "dpo", "Complete the record of processing and the impact assessment for the AI triage of logs", "2027-02-28"],
  ["db", "TH-HUM-03", 2, "itops", "Test restoration of the customer database twice a year", "2027-01-31"],
  ["siem", "TH-ORG-04", 3, "soc", "Write the missing procedures and measure time to contain for every serious incident", "2027-03-31"],
  ["siem", "TH-TEC-03", 3, "soc", null, null],
  ["ai", "TH-FUN-03", 3, "soc", "Sample model outputs weekly against analyst conclusions and report disagreement", "2027-02-28"],
  ["idp", "TH-INF-02", 4, "itops", "Extend MFA to every account and block legacy authentication", "2026-12-31"],
  ["idp", "TH-INF-03", 2, "itops", "Put administrator accounts in a vault with session recording", "2027-04-30"],
  ["ot", "TH-FUN-02", 2, "soc", "Alert on any change to the log interface and review its configuration quarterly", "2027-01-31"],
  ["vendor", "TH-SVC-02", 2, "itops", "Agree recovery times with the vendor and test the continuity plan with them", "2027-04-30"],
  ["team", "TH-ORG-01", 3, "ciso", "Cross-train analysts and write the procedures known by one person", "2027-03-31"],
];
const recorded = [];
for (const [asset, threatId, likelihood, owner, plan, target] of plans) {
  const risk = await ciso({ action: "scenario", assetId: assets[asset], threatId, likelihood, ownerId: people[owner] });
  const id = risk.id ?? risk.risk?.id;
  if (!id) throw new Error(`No id returned for ${threatId}: ${JSON.stringify(risk)}`);
  recorded.push({ id, asset, threatId });
  if (plan) {
    await ciso({ action: "update", id, treatment: "mitigate", treatmentPlan: plan, targetDate: iso(target) });
    await ciso({ action: "treatment_task", id });
  }
}

// ---------------------------------------------------------------- one acceptance, by someone who neither owns nor recorded the risk
const capacity = recorded.find((risk) => risk.threatId === "TH-TEC-03");
await admin({
  action: "accept",
  id: capacity.id,
  days: 180,
  note: "Accepted for six months: the detection platform runs on one node and a second node is budgeted for 2027. Until then storage is watched weekly and the oldest logs are archived first.",
});

const after = await call("/api/risk-register");
const isms = await call("/api/isms");
console.log(`Loaded ${recorded.length} risks on ${Object.keys(assets).length} assets.`);
console.log(`Register summary: ${JSON.stringify(after.summary ?? {})}`);
for (const clause of isms.clauses) console.log(`  ${clause.status.padEnd(8)} ${clause.clause.padEnd(8)} ${clause.title}`);
