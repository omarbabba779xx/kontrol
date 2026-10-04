import { FRAMEWORKS, FRAMEWORK_BY_ID } from "@/lib/frameworks/catalog";
import { CSF_SUBCATEGORIES } from "@/lib/frameworks/data/csf-data";
import { COBIT_MAPPING } from "@/lib/frameworks/data/cobit";
import { ENISA_POINTS } from "@/lib/frameworks/data/enisa-data";
import { UNIFIED_CONTROLS } from "@/lib/frameworks/unified";
import type { FrameworkId } from "@/lib/frameworks/types";

/**
 * Where a requirement-to-control link comes from.
 *  - published: corroborated by an official crosswalk, with the source named: NIST's CSF 2.0 informative references
 *    (to ISO/IEC 27001:2022, PCI DSS and CIS Controls) and ENISA's NIS2 technical implementation mapping table.
 *    The control layer itself is Kontrol's; "published" says the requirement is officially related to a requirement
 *    that this control already serves.
 *  - editorial: authored by the Kontrol team and subject to review in the Compliance hub
 */
export type Basis = "published" | "editorial";

export const linkKey = (frameworkId: string, requirementId: string, ucCode: string) => `${frameworkId}|${requirementId}|${ucCode}`;

/** Hand-refined mappings below the group level ("id: controls"). They replace the inherited group mapping. */
const REFINEMENTS: Partial<Record<FrameworkId, string>> = {
  cobit2019: COBIT_MAPPING,
  pci_dss: `
Req.3.1: UC-DAT-02 UC-DAT-01
Req.3.2: UC-DAT-02
Req.3.3: UC-DAT-02
Req.3.4: UC-IAM-04 UC-DAT-04
Req.3.5: UC-DAT-03
Req.3.6: UC-DAT-03
Req.3.7: UC-DAT-03
Req.4.1: UC-DAT-03 UC-GOV-01
Req.5.4: UC-OPS-03 UC-HR-02
Req.6.1: UC-GOV-01 UC-SDL-01
Req.6.2: UC-SDL-01
Req.6.3: UC-OPS-02 UC-SDL-01
Req.6.4: UC-SDL-01 UC-OPS-04
Req.6.5: UC-OPS-06
Req.8.2: UC-IAM-01
Req.8.3: UC-IAM-02
Req.8.4: UC-IAM-02
Req.8.5: UC-IAM-02
Req.8.6: UC-IAM-03
Req.9.2: UC-PHY-01
Req.9.3: UC-PHY-01
Req.9.4: UC-PHY-02 UC-DAT-02
Req.9.5: UC-PHY-01
Req.10.6: UC-OPS-05
Req.10.7: UC-OPS-05 UC-INC-01
Req.11.2: UC-OPS-04 UC-OPS-05
Req.11.3: UC-OPS-02
Req.11.4: UC-OPS-09
Req.11.5: UC-OPS-05
Req.11.6: UC-OPS-05 UC-SDL-01
Req.12.1: UC-GOV-01
Req.12.2: UC-HR-03
Req.12.3: UC-GOV-04
Req.12.4: UC-GOV-05 UC-GOV-06
Req.12.5: UC-ASM-01 UC-GOV-03
Req.12.6: UC-HR-02
Req.12.7: UC-HR-01
Req.12.8: UC-TPM-01 UC-TPM-02
Req.12.9: UC-TPM-02
Req.12.10: UC-INC-01 UC-INC-02`,
  cis_v8: `
CIS.3.1: UC-DAT-01 UC-DAT-02
CIS.3.2: UC-ASM-01 UC-DAT-01
CIS.3.3: UC-IAM-04
CIS.3.4: UC-DAT-02
CIS.3.5: UC-DAT-02 UC-PHY-02
CIS.3.6: UC-DAT-03 UC-OPS-03
CIS.3.7: UC-DAT-01
CIS.3.8: UC-DAT-01 UC-PRV-01
CIS.3.9: UC-DAT-03 UC-PHY-02
CIS.3.10: UC-DAT-03
CIS.3.11: UC-DAT-03
CIS.3.12: UC-DAT-01 UC-OPS-04
CIS.3.13: UC-DAT-04
CIS.3.14: UC-OPS-05 UC-DAT-04
CIS.4.4: UC-OPS-04 UC-OPS-01
CIS.4.5: UC-OPS-04 UC-OPS-01
CIS.4.7: UC-IAM-03 UC-OPS-01
CIS.4.10: UC-OPS-01 UC-HR-03
CIS.4.11: UC-OPS-01 UC-HR-03
CIS.4.12: UC-OPS-01 UC-HR-03
CIS.5.1: UC-IAM-01 UC-ASM-01
CIS.5.2: UC-IAM-02
CIS.5.3: UC-IAM-01
CIS.5.4: UC-IAM-03
CIS.5.5: UC-IAM-01 UC-ASM-01
CIS.5.6: UC-IAM-01
CIS.6.1: UC-IAM-01
CIS.6.2: UC-IAM-01
CIS.6.3: UC-IAM-02
CIS.6.4: UC-IAM-02
CIS.6.5: UC-IAM-02 UC-IAM-03
CIS.6.6: UC-IAM-01 UC-ASM-01
CIS.6.7: UC-IAM-04
CIS.6.8: UC-IAM-01 UC-IAM-04
CIS.8.10: UC-OPS-05 UC-DAT-02
CIS.8.12: UC-OPS-05 UC-TPM-01
CIS.9.2: UC-OPS-04 UC-OPS-03
CIS.9.3: UC-OPS-04
CIS.11.1: UC-GOV-01 UC-DAT-05
CIS.11.5: UC-BCP-01 UC-DAT-05
CIS.12.4: UC-ASM-01 UC-OPS-04
CIS.12.5: UC-IAM-02 UC-OPS-04
CIS.12.7: UC-HR-03 UC-OPS-04
CIS.13.4: UC-OPS-04
CIS.13.5: UC-IAM-02 UC-OPS-04
CIS.13.9: UC-OPS-04
CIS.13.10: UC-OPS-04
CIS.14.1: UC-HR-02 UC-GOV-01
CIS.14.6: UC-HR-02 UC-INC-01
CIS.15.2: UC-GOV-01 UC-TPM-01
CIS.15.4: UC-TPM-02
CIS.16.2: UC-OPS-02 UC-SDL-01
CIS.16.4: UC-ASM-01 UC-SDL-01
CIS.16.5: UC-ASM-01 UC-SDL-01
CIS.16.9: UC-HR-02 UC-SDL-01
CIS.16.13: UC-OPS-09 UC-SDL-01
CIS.17.2: UC-INC-02
CIS.17.3: UC-INC-02
CIS.17.6: UC-BCP-02
CIS.17.7: UC-INC-01 UC-BCP-01`,
  iso42001: `
A.2.3: UC-AI-01 UC-GOV-01
A.2.4: UC-AI-01 UC-GOV-05
A.3.3: UC-AI-01 UC-INC-01
A.4.2: UC-AI-01 UC-ASM-01
A.4.3: UC-AI-03
A.4.4: UC-AI-01 UC-ASM-01
A.4.5: UC-AI-01 UC-OPS-07
A.4.6: UC-AI-01 UC-HR-02
A.6.2.6: UC-AI-06
A.6.2.8: UC-AI-04 UC-OPS-05
A.8.3: UC-AI-04 UC-INC-02
A.8.4: UC-AI-04 UC-INC-02
A.9.4: UC-AI-05
A.10.2: UC-AI-07 UC-GOV-02
A.10.3: UC-AI-07 UC-TPM-01
A.10.4: UC-AI-07`,
};

type Resolved = { ucs: string[]; basis: Map<string, Basis>; source: Map<string, string> };

function parseRefinements(text: string | undefined) {
  const out = new Map<string, string[]>();
  for (const line of (text ?? "").trim().split("\n").filter(Boolean)) {
    const [id, codes] = line.split(":");
    out.set(id.trim(), codes.trim().split(/\s+/));
  }
  return out;
}

/** framework -> id (requirement or group) -> unified controls that list it. */
const listing = new Map<FrameworkId, Map<string, string[]>>();
for (const framework of FRAMEWORKS) listing.set(framework.id, new Map());
for (const control of UNIFIED_CONTROLS) {
  for (const [frameworkId, ids] of Object.entries(control.map)) {
    const byId = listing.get(frameworkId as FrameworkId)!;
    for (const id of ids ?? []) byId.set(id, [...(byId.get(id) ?? []), control.code]);
  }
}

/** NIST CSF 2.0 subcategory -> controls, derived from NIST's own informative references to ISO/IEC 27001:2022. */
function deriveCsf(): Map<string, string[]> {
  const iso = listing.get("iso27001")!;
  const csf = listing.get("nist_csf")!;
  const out = new Map<string, string[]>();
  for (const [id, , refs] of CSF_SUBCATEGORIES) {
    const codes = new Set<string>();
    for (const ref of refs) for (const code of iso.get(ref) ?? []) codes.add(code);
    if (!codes.size) continue;
    // NIST cites many ISO controls per subcategory, including broad governance ones. Keeping only the controls
    // that also belong to the subcategory's own category removes that noise; if nothing is left the raw set is used.
    const inCategory = new Set(csf.get(id.split("-")[0]) ?? []);
    const focused = [...codes].filter((code) => inCategory.has(code));
    out.set(id, focused.length ? focused : [...codes]);
  }
  return out;
}

const CSF_SOURCE = "NIST CSF 2.0 informative references to ISO/IEC 27001:2022";
const NIST_SOURCE = "NIST CSF 2.0 informative references";
const ENISA_SOURCE = "ENISA NIS2 technical implementation mapping table v1.2";

const resolved = new Map<FrameworkId, Map<string, Resolved>>();

for (const framework of FRAMEWORKS) {
  const byId = listing.get(framework.id)!;
  const refined = parseRefinements(REFINEMENTS[framework.id]);
  const derived = framework.id === "nist_csf" ? deriveCsf() : new Map<string, string[]>();
  const map = new Map<string, Resolved>();
  for (const requirement of framework.requirements) {
    let codes: string[] | undefined;
    let basis: Basis = "editorial";
    let source = "";
    if (refined.has(requirement.id)) codes = refined.get(requirement.id);
    else if (derived.has(requirement.id)) { codes = derived.get(requirement.id); basis = "published"; source = CSF_SOURCE; }
    else if (byId.has(requirement.id)) codes = byId.get(requirement.id);
    else if (requirement.parent && byId.has(requirement.parent)) codes = byId.get(requirement.parent);
    const unique = [...new Set(codes ?? [])];
    map.set(requirement.id, { ucs: unique, basis: new Map(unique.map((code) => [code, basis])), source: new Map(unique.filter(() => basis === "published").map((code) => [code, source])) });
  }
  // A control that lists a whole group must not vanish because every child was refined elsewhere.
  for (const [groupId, codes] of byId) {
    const children = framework.requirements.filter((requirement) => requirement.parent === groupId);
    if (!children.length) continue;
    for (const code of codes) {
      if (children.some((child) => map.get(child.id)!.ucs.includes(code))) continue;
      for (const child of children) {
        const entry = map.get(child.id)!;
        entry.ucs.push(code);
        entry.basis.set(code, "editorial");
      }
    }
  }
  resolved.set(framework.id, map);
}

type Edge = { source: string; support: number };
type Edges = Map<string, Map<string, Edge>>; // requirement -> control -> source and how many independent references back it
const published = new Map<FrameworkId, Edges>();
function addEdge(frameworkId: FrameworkId, requirementId: string, ucCode: string, source: string) {
  const edges = published.get(frameworkId) ?? new Map<string, Map<string, Edge>>();
  const forRequirement = edges.get(requirementId) ?? new Map<string, Edge>();
  const existing = forRequirement.get(ucCode);
  if (existing) existing.support += 1;
  else forRequirement.set(ucCode, { source, support: 1 });
  edges.set(requirementId, forRequirement);
  published.set(frameworkId, edges);
}

// NIST publishes PCI DSS and CIS Controls references per CSF subcategory; the subcategory's controls carry over.
for (const [id, , , pciRefs, cisRefs] of CSF_SUBCATEGORIES) {
  const codes = resolved.get("nist_csf")!.get(id)?.ucs ?? [];
  for (const ref of pciRefs) if (resolved.get("pci_dss")!.has(ref)) for (const code of codes) addEdge("pci_dss", ref, code, `${NIST_SOURCE} via ${id}`);
  for (const ref of cisRefs) if (resolved.get("cis_v8")!.has(ref)) for (const code of codes) addEdge("cis_v8", ref, code, `${NIST_SOURCE} via ${id}`);
}

/** CIR 2024/2690 Annex points elaborate NIS2 Article 21; this is the article each point belongs to. */
function nis2Articles(point: string): string[] {
  const [section, item] = point.split(".");
  switch (section) {
    case "1": return ["Art.21(2)(a)"];
    case "2": return item === "1" ? ["Art.21(2)(a)"] : ["Art.21(2)(f)"];
    case "3": return ["Art.21(2)(b)"];
    case "4": return ["Art.21(2)(c)"];
    case "5": return ["Art.21(2)(d)"];
    case "6": return ["Art.21(2)(e)"];
    case "7": return ["Art.21(2)(f)"];
    case "8": return ["Art.21(2)(g)"];
    case "9": return ["Art.21(2)(h)"];
    case "10": return ["Art.21(2)(i)"];
    case "11": return Number(item) >= 6 ? ["Art.21(2)(i)", "Art.21(2)(j)"] : ["Art.21(2)(i)"];
    case "12": return ["Art.21(2)(i)"];
    case "13": return ["Art.21(1)"];
    default: return [];
  }
}

const isoListing = listing.get("iso27001")!;
for (const [point, , isoRefs] of ENISA_POINTS) {
  for (const article of nis2Articles(point)) {
    if (!resolved.get("nis2")!.has(article)) continue;
    for (const ref of isoRefs) for (const code of isoListing.get(ref) ?? []) addEdge("nis2", article, code, `${ENISA_SOURCE} (point ${point})`);
  }
}

// Corroborate existing links, and keep what the sources add as suggestions for a reviewer.
const suggestions = new Map<FrameworkId, Map<string, Array<{ ucCode: string; source: string }>>>();
for (const [frameworkId, edges] of published) {
  const entries = resolved.get(frameworkId)!;
  const bySuggestion = new Map<string, Array<{ ucCode: string; source: string }>>();
  for (const [requirementId, controls] of edges) {
    const entry = entries.get(requirementId);
    if (!entry) continue;
    for (const [ucCode, edge] of controls) {
      if (entry.ucs.includes(ucCode)) {
        if (entry.basis.get(ucCode) !== "published") { entry.basis.set(ucCode, "published"); entry.source.set(ucCode, edge.source); }
      } else if (frameworkId === "nis2" || edge.support >= 2) {
        // ENISA relates NIS2 to ISO directly. For PCI DSS and CIS the relation runs through CSF subcategories,
        // so a control is only suggested when at least two of them agree.
        bySuggestion.set(requirementId, [...(bySuggestion.get(requirementId) ?? []), { ucCode, source: edge.source }]);
      }
    }
  }
  suggestions.set(frameworkId, bySuggestion);
}

/** Controls a new sub-requirement inherits from its parent: a requirement of the catalogue, or a group. */
export function controlsForParent(frameworkId: FrameworkId, parentId: string): string[] {
  const requirement = resolved.get(frameworkId)?.get(parentId);
  return requirement ? [...requirement.ucs] : [...(listing.get(frameworkId)?.get(parentId) ?? [])];
}

/** Unified controls linked to a requirement in the built-in crosswalk. */
export function baseControls(frameworkId: FrameworkId, requirementId: string): string[] {
  return resolved.get(frameworkId)?.get(requirementId)?.ucs ?? [];
}

export function linkBasis(frameworkId: FrameworkId, requirementId: string, ucCode: string): Basis {
  return resolved.get(frameworkId)?.get(requirementId)?.basis.get(ucCode) ?? "editorial";
}

/** The official source that corroborates a link, when it has one. */
export function linkSource(frameworkId: FrameworkId, requirementId: string, ucCode: string): string | null {
  return resolved.get(frameworkId)?.get(requirementId)?.source.get(ucCode) ?? null;
}

/** Links an official crosswalk implies but that are not in the built-in mapping. Offered to reviewers, never applied silently. */
export function suggestedControls(frameworkId: FrameworkId, requirementId: string): Array<{ ucCode: string; source: string }> {
  return suggestions.get(frameworkId)?.get(requirementId) ?? [];
}

export function allSuggestions() {
  const out: Array<{ frameworkId: FrameworkId; requirementId: string; ucCode: string; source: string }> = [];
  for (const [frameworkId, byRequirement] of suggestions) for (const [requirementId, items] of byRequirement) for (const item of items) out.push({ frameworkId, requirementId, ...item });
  return out;
}

/** Requirements a unified control is linked to in the built-in crosswalk. */
export function baseRequirements(ucCode: string, frameworkId: FrameworkId): string[] {
  const out: string[] = [];
  for (const [requirementId, entry] of resolved.get(frameworkId) ?? []) if (entry.ucs.includes(ucCode)) out.push(requirementId);
  return out;
}

export type MappingLink = { frameworkId: FrameworkId; requirementId: string; ucCode: string; basis: Basis; source: string | null };

export function allLinks(): MappingLink[] {
  const links: MappingLink[] = [];
  for (const [frameworkId, entries] of resolved) for (const [requirementId, entry] of entries) for (const ucCode of entry.ucs) links.push({ frameworkId, requirementId, ucCode, basis: entry.basis.get(ucCode) ?? "editorial", source: entry.source.get(ucCode) ?? null });
  return links;
}

/** Group ids that unified controls may reference in addition to requirement ids. */
export function isKnownReference(frameworkId: FrameworkId, id: string) {
  const framework = FRAMEWORK_BY_ID.get(frameworkId);
  return !!framework && (framework.requirements.some((requirement) => requirement.id === id) || !!framework.groups?.some((item) => item.id === id));
}
