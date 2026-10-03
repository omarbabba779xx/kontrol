/**
 * Pure checks over the register of information: completeness for export (errors) and supervisory-quality findings
 * (warnings), plus concentration. Kept free of I/O so it can be tested exhaustively.
 */
const DAY = 86_400_000;

export type ProviderRecord = { id: string; name: string; lei: string | null; country: string; provider_type: string; status: string };
export type Subcontractor = { name: string; country?: string; service?: string; rank?: number };
export type ArrangementRecord = {
  id: string;
  provider_id: string;
  ref: string;
  service_type: string;
  function_supported: string;
  criticality: "critical_or_important" | "not_critical";
  start_date: string;
  end_date: string | null;
  governing_law: string | null;
  service_country: string | null;
  data_country: string | null;
  data_sensitivity: string;
  subcontractors: Subcontractor[];
  substitutability: string;
  exit_plan: boolean;
  exit_tested_at: string | null;
  audit_rights: boolean;
  incident_notification_hours: number | null;
  status: string;
};
export type Issue = { severity: "error" | "warning"; code: string; ref: string; provider: string; message: string };

/** ISO 17442 legal entity identifier: 18 alphanumerics and two check digits, valid when the numeric expansion is 1 mod 97. */
export function validLei(value: string) {
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(value)) return false;
  const digits = [...value].map((char) => (/[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char)).join("");
  let remainder = 0;
  for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder === 1;
}

export function registerIssues(providers: ProviderRecord[], arrangements: ArrangementRecord[], now = Date.now()): Issue[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const issues: Issue[] = [];
  for (const arrangement of arrangements.filter((item) => item.status === "active")) {
    const provider = byId.get(arrangement.provider_id);
    const name = provider?.name ?? "unknown";
    const critical = arrangement.criticality === "critical_or_important";
    const add = (severity: Issue["severity"], code: string, message: string) =>
      issues.push({ severity, code, ref: arrangement.ref, provider: name, message });
    if (!provider?.lei)
      add(
        critical ? "error" : "warning",
        "provider.lei_missing",
        "The provider has no legal entity identifier (LEI); the register identifies providers by LEI.",
      );
    else if (!validLei(provider.lei)) add("error", "provider.lei_invalid", "The provider's LEI fails the ISO 17442 check.");
    if (!arrangement.governing_law)
      add(critical ? "error" : "warning", "arrangement.governing_law_missing", "Governing law of the contract is not recorded.");
    if (!arrangement.service_country)
      add(
        critical ? "error" : "warning",
        "arrangement.service_country_missing",
        "The country where the service is performed is not recorded.",
      );
    if (!arrangement.data_country && arrangement.data_sensitivity !== "none")
      add(
        critical ? "error" : "warning",
        "arrangement.data_country_missing",
        "Data is processed but the country of storage is not recorded.",
      );
    if (arrangement.end_date && Date.parse(arrangement.end_date) < Date.parse(arrangement.start_date))
      add("error", "arrangement.dates_inverted", "The end date is before the start date.");
    if (arrangement.end_date) {
      const left = (Date.parse(arrangement.end_date) - now) / DAY;
      if (left < 0) add("warning", "arrangement.expired", "The arrangement ended but is still recorded as active.");
      else if (left <= 90 && critical)
        add(
          "warning",
          "arrangement.ending_soon",
          `The arrangement ends in ${Math.ceil(left)} days: confirm renewal or execute the exit plan.`,
        );
    }
    for (const sub of arrangement.subcontractors)
      if (!sub.country) add("warning", "supply_chain.country_missing", `Subcontractor ${sub.name} has no country recorded.`);
    if (critical) {
      if (!arrangement.audit_rights)
        add(
          "warning",
          "arrangement.no_audit_rights",
          "No audit and access rights are recorded for a critical or important function (DORA Art.30(3)).",
        );
      if (!arrangement.exit_plan)
        add("warning", "arrangement.no_exit_plan", "No exit plan is recorded for a critical or important function (DORA Art.28(8)).");
      else if (!arrangement.exit_tested_at || now - Date.parse(arrangement.exit_tested_at) > 365 * DAY)
        add("warning", "arrangement.exit_untested", "The exit plan has not been tested in the last 12 months.");
      if (arrangement.substitutability === "not_assessed")
        add("warning", "arrangement.substitutability_unassessed", "Substitutability has not been assessed.");
      if (arrangement.substitutability === "impossible" && !arrangement.exit_plan)
        add(
          "warning",
          "arrangement.locked_in",
          "The provider cannot be substituted and there is no exit plan: a stressed exit is not executable.",
        );
      if (arrangement.incident_notification_hours === null)
        add("warning", "arrangement.incident_sla_missing", "No contractual incident notification time is recorded.");
      else if (arrangement.incident_notification_hours > 72)
        add(
          "warning",
          "arrangement.incident_sla_slow",
          `Incident notification takes ${arrangement.incident_notification_hours}h, longer than the 72h to remain compatible with major-incident reporting.`,
        );
    }
  }
  return issues.sort((a, b) => (a.severity === b.severity ? a.ref.localeCompare(b.ref) : a.severity === "error" ? -1 : 1));
}

export type Concentration = {
  criticalArrangements: number;
  hhi: number;
  level: "low" | "moderate" | "high";
  providers: Array<{ providerId: string; name: string; critical: number; share: number; countries: string[] }>;
};

/** Herfindahl-Hirschman index (0-10000) over critical arrangements by provider. Moderate from 1500, high from 2500, as in competition analysis. */
export function concentration(providers: ProviderRecord[], arrangements: ArrangementRecord[]): Concentration {
  const critical = arrangements.filter((item) => item.status === "active" && item.criticality === "critical_or_important");
  const names = new Map(providers.map((provider) => [provider.id, provider.name]));
  const groups = new Map<string, ArrangementRecord[]>();
  for (const item of critical) groups.set(item.provider_id, [...(groups.get(item.provider_id) ?? []), item]);
  const rows = [...groups]
    .map(([providerId, items]) => ({
      providerId,
      name: names.get(providerId) ?? "unknown",
      critical: items.length,
      share: critical.length ? items.length / critical.length : 0,
      countries: [...new Set(items.map((item) => item.service_country).filter((country): country is string => !!country))].sort(),
    }))
    .sort((a, b) => b.critical - a.critical || a.name.localeCompare(b.name));
  const hhi = Math.round(rows.reduce((sum, row) => sum + (row.share * 100) ** 2, 0));
  const enough = critical.length >= 3;
  return {
    criticalArrangements: critical.length,
    hhi,
    level: !enough ? "low" : hhi >= 2500 ? "high" : hhi >= 1500 ? "moderate" : "low",
    providers: rows,
  };
}
