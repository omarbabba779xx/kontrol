"""Measures Kontrol's crosswalk against the Secure Controls Framework (SCF), an independent published crosswalk.

The SCF is licensed CC BY-ND 4.0: its data must not be redistributed or adapted, so this script only READS a copy
you download yourself and reports aggregate agreement plus candidate links for HUMAN review. Nothing from the SCF is
written into the repository.

  curl -L -o scf.xlsx <release asset from github.com/securecontrolsframework/securecontrolsframework>
  node --conditions=react-server --import tsx scripts/export-crosswalk.ts > crosswalk.json
  python scripts/compare-scf.py scf.xlsx crosswalk.json [--details]

Two requirements are "SCF-related" when they appear in the same SCF control row. Kontrol relates two requirements when
a unified control is linked to both. A Kontrol link (requirement, control) is *corroborated* when at least one
requirement of another framework that shares the control is SCF-related to the requirement.
"""
import json, re, sys, warnings, collections
warnings.filterwarnings("ignore")
import openpyxl

COLUMNS = {"soc2": 48, "cis_v8": 51, "iso27001_clause": 74, "iso27001_annex": 75, "iso42001": 82, "nist_csf": 116, "pci_dss": 121, "eu_ai_act": 226, "dora": 229, "gdpr": 232, "nis2": 233}


def tokens(cell):
    return [t.strip() for t in re.split(r"[\n,;|]+", str(cell or "")) if t.strip()]


def norm(framework, token):
    if framework == "soc2":
        m = re.match(r"^(CC\d\.\d|A1\.\d|C1\.\d|PI1\.\d)", token)
        if m: return m.group(1)
        m = re.match(r"^P(\d)\.\d", token)
        return f"P{m.group(1)}" if m else None
    if framework == "cis_v8":
        m = re.match(r"^(\d{1,2})\.(\d{1,2})$", token)
        return f"CIS.{m.group(1)}.{m.group(2)}" if m and m.group(2) != "0" else None
    if framework == "iso27001_clause":
        m = re.match(r"^(\d{1,2})\.(\d{1,2})", token)
        return f"C{m.group(1)}.{m.group(2)}" if m and int(m.group(1)) >= 4 else None
    if framework == "iso27001_annex":
        m = re.match(r"^(5|6|7|8)\.(\d{1,2})$", token)
        return f"A{m.group(1)}.{m.group(2)}" if m else None
    if framework == "iso42001":
        m = re.match(r"^A\.?(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?$", token)
        if m: return "A." + ".".join(p for p in m.groups() if p)
        m = re.match(r"^(\d{1,2})\.(\d{1,2})", token)
        return f"C{m.group(1)}.{m.group(2)}" if m and int(m.group(1)) >= 4 else None
    if framework == "nist_csf":
        return token if re.match(r"^[A-Z]{2}\.[A-Z]{2}-\d\d$", token) else None
    if framework == "pci_dss":
        m = re.match(r"^(\d{1,2})\.(\d{1,2})", token)
        return f"Req.{m.group(1)}.{m.group(2)}" if m else None
    if framework in ("eu_ai_act", "dora", "gdpr"):
        m = re.match(r"^Article (\d+)", token)
        return f"Art.{m.group(1)}" if m else None
    if framework == "nis2":
        m = re.match(r"^Article (\d+)\.(\d+)(?:\(([a-j])\))?", token)
        if not m: return None
        if m.group(1) == "21" and m.group(2) == "2" and m.group(3): return f"Art.21(2)({m.group(3)})"
        return f"Art.{m.group(1)}({m.group(2)})"
    return None


def main():
    scf_path, crosswalk_path = sys.argv[1], sys.argv[2]
    details = "--details" in sys.argv
    mine = json.load(open(crosswalk_path, encoding="utf8"))
    known = {fw: set(reqs) for fw, reqs in mine.items()}
    # nist_csf requirement ids are subcategories; iso and others use the same ids as the catalogue.
    fw_of = {"iso27001_clause": "iso27001", "iso27001_annex": "iso27001"}

    workbook = openpyxl.load_workbook(scf_path, read_only=True)
    ws = workbook[next(name for name in workbook.sheetnames if name.startswith("SCF 20"))]
    rows = list(ws.iter_rows(min_row=2, values_only=True))

    scf_rows = []  # per SCF control: set of (framework, requirement)
    for row in rows:
        members = set()
        for column, index in COLUMNS.items():
            fw = fw_of.get(column, column)
            for token in tokens(row[index]):
                requirement = norm(column, token)
                if requirement and requirement in known.get(fw, ()): members.add((fw, requirement))
        if len(members) > 1: scf_rows.append(members)

    related = collections.defaultdict(set)
    for members in scf_rows:
        for a in members:
            for b in members:
                if a[0] != b[0]: related[a].add(b)

    # Kontrol relations through unified controls
    by_uc = collections.defaultdict(set)
    for fw, reqs in mine.items():
        for requirement, ucs in reqs.items():
            for uc in ucs: by_uc[uc].add((fw, requirement))

    total_links = corroborated = testable = 0
    per_fw = collections.defaultdict(lambda: [0, 0, 0])  # links, testable, corroborated
    uncorroborated = []
    for fw, reqs in mine.items():
        for requirement, ucs in reqs.items():
            node = (fw, requirement)
            for uc in ucs:
                total_links += 1
                per_fw[fw][0] += 1
                if not related.get(node): continue  # SCF knows nothing about this requirement: cannot judge
                testable += 1; per_fw[fw][1] += 1
                peers = {p for p in by_uc[uc] if p[0] != fw}
                if peers & related[node]: corroborated += 1; per_fw[fw][2] += 1
                else: uncorroborated.append((fw, requirement, uc, len(peers)))

    # Candidate additions: controls whose peers are SCF-related to the requirement but that are not linked.
    candidates = []
    for fw, reqs in mine.items():
        for requirement, ucs in reqs.items():
            node = (fw, requirement)
            support = collections.Counter()
            for peer in related.get(node, ()):
                for uc in mine[peer[0]].get(peer[1], ()):
                    if uc not in ucs: support[uc] += 1
            for uc, count in support.most_common(3):
                if count >= 3: candidates.append((count, fw, requirement, uc))

    print(f"SCF controls with 2+ mapped requirements in Kontrol's catalogues: {len(scf_rows)}")
    print(f"Kontrol links: {total_links}; testable against SCF: {testable}; corroborated: {corroborated} ({100 * corroborated / max(1, testable):.1f}% of testable)")
    print("\nPer framework (links, testable, corroborated %):")
    for fw, (links, tested, ok) in sorted(per_fw.items()):
        print(f"  {fw:10s} {links:5d} {tested:5d} {100 * ok / max(1, tested):5.1f}%")
    print(f"\nUncorroborated testable links: {len(uncorroborated)}; candidate additions with support >= 3: {len(candidates)}")
    if details:
        print("\nLinks no SCF relation supports (framework, requirement, control, peers):")
        for item in sorted(uncorroborated)[:400]: print("  ", *item)
        print("\nCandidate additions (support, framework, requirement, control):")
        for item in sorted(candidates, reverse=True)[:400]: print("  ", *item)


if __name__ == "__main__":
    main()
