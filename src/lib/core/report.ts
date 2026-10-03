import "server-only";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Actor } from "@/lib/core/auth";
import { complianceSnapshot, frameworkDetail } from "@/lib/core/compliance-engine";
import { appendAudit, canonicalJson, sha256, signDecision, verifyAuditChain } from "@/lib/core/integrity";
import { getDb } from "@/lib/db";
import type { FrameworkId } from "@/lib/frameworks/types";

const PAGE = { width: 595, height: 842, margin: 48 };
const INK = rgb(0.09, 0.09, 0.075);
const MUTED = rgb(0.42, 0.41, 0.38);
const RULE = rgb(0.8, 0.78, 0.74);
const ACCENT = rgb(0.94, 0.35, 0.2);
const GOOD = rgb(0.18, 0.44, 0.31);
const WARN = rgb(0.66, 0.54, 0.27);
const BAD = rgb(0.72, 0.2, 0.16);

/** Standard PDF fonts only cover WinAnsi; anything else is replaced so a stray symbol can never break the document. */
export function pdfSafe(value: unknown) {
  return String(value ?? "")
    .replace(/→/g, "->")
    .replace(/≥/g, ">=")
    .replace(/≤/g, "<=")
    .replace(/[‑‐]/g, "-")
    .replace(/[^ -~ -ÿ–—‘’“”•…€]/g, "?");
}

const scoreColor = (score: number) => (score >= 85 ? GOOD : score >= 50 ? WARN : BAD);

class Layout {
  readonly pdf: PDFDocument;
  page!: PDFPage;
  y = 0;
  constructor(
    pdf: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly mono: PDFFont,
  ) {
    this.pdf = pdf;
    this.newPage();
  }
  newPage() {
    this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - PAGE.margin;
  }
  ensure(height: number) {
    if (this.y - height < PAGE.margin + 18) this.newPage();
  }
  get width() {
    return PAGE.width - PAGE.margin * 2;
  }

  wrap(text: string, font: PDFFont, size: number, width: number) {
    const lines: string[] = [];
    for (const paragraph of pdfSafe(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
        else {
          if (line) lines.push(line);
          // A single token wider than the line (hashes, identifiers) is hard-split.
          let rest = word;
          while (font.widthOfTextAtSize(rest, size) > width) {
            let cut = rest.length - 1;
            while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut -= 1;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
          }
          line = rest;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(
    value: string,
    options: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {},
  ) {
    const size = options.size ?? 9.5;
    const font = options.font ?? this.regular;
    const lines = this.wrap(value, font, size, options.width ?? this.width);
    for (const line of lines) {
      this.ensure(size + 3);
      this.page.drawText(line, { x: options.x ?? PAGE.margin, y: this.y - size, size, font, color: options.color ?? INK });
      this.y -= size + 3;
    }
    this.y -= options.gap ?? 4;
  }

  heading(value: string, level: 1 | 2 = 1) {
    this.ensure(level === 1 ? 46 : 32);
    this.y -= level === 1 ? 10 : 4;
    this.page.drawText(pdfSafe(value), {
      x: PAGE.margin,
      y: this.y - (level === 1 ? 15 : 11),
      size: level === 1 ? 15 : 11,
      font: this.bold,
      color: INK,
    });
    this.y -= level === 1 ? 22 : 16;
    if (level === 1) {
      this.page.drawLine({
        start: { x: PAGE.margin, y: this.y + 2 },
        end: { x: PAGE.width - PAGE.margin, y: this.y + 2 },
        thickness: 0.6,
        color: RULE,
      });
      this.y -= 8;
    }
  }

  bar(label: string, value: number, detail = "") {
    this.ensure(15);
    const labelWidth = 200,
      barWidth = this.width - labelWidth - 70;
    this.page.drawText(pdfSafe(this.wrap(label, this.regular, 8.5, labelWidth - 8)[0]), {
      x: PAGE.margin,
      y: this.y - 8,
      size: 8.5,
      font: this.regular,
      color: INK,
    });
    this.page.drawRectangle({ x: PAGE.margin + labelWidth, y: this.y - 8, width: barWidth, height: 6, color: rgb(0.88, 0.86, 0.81) });
    this.page.drawRectangle({
      x: PAGE.margin + labelWidth,
      y: this.y - 8,
      width: Math.max(0, Math.min(1, value / 100)) * barWidth,
      height: 6,
      color: scoreColor(value),
    });
    this.page.drawText(pdfSafe(detail || `${value}%`), {
      x: PAGE.margin + labelWidth + barWidth + 8,
      y: this.y - 8,
      size: 8.5,
      font: this.mono,
      color: INK,
    });
    this.y -= 14;
  }

  /** Simple table: fixed column widths, wrapped cells, repeated header on page breaks. */
  table(headers: string[], widths: number[], rows: string[][], options: { size?: number } = {}) {
    const size = options.size ?? 8;
    const total = widths.reduce((sum, item) => sum + item, 0);
    const scale = this.width / total;
    const columns = widths.map((item) => item * scale);
    const header = () => {
      this.ensure(20);
      this.page.drawRectangle({ x: PAGE.margin, y: this.y - 14, width: this.width, height: 14, color: rgb(0.91, 0.9, 0.86) });
      let x = PAGE.margin + 4;
      headers.forEach((title, index) => {
        this.page.drawText(pdfSafe(title).toUpperCase(), { x, y: this.y - 10, size: 6.5, font: this.mono, color: MUTED });
        x += columns[index];
      });
      this.y -= 17;
    };
    header();
    for (const row of rows) {
      const cells = row.map((cell, index) => this.wrap(cell, this.regular, size, columns[index] - 8));
      const height = Math.max(...cells.map((lines) => lines.length)) * (size + 2.5) + 5;
      if (this.y - height < PAGE.margin + 18) {
        this.newPage();
        header();
      }
      let x = PAGE.margin + 4;
      cells.forEach((lines, index) => {
        lines.forEach((line, lineIndex) =>
          this.page.drawText(line, { x, y: this.y - size - lineIndex * (size + 2.5), size, font: this.regular, color: INK }),
        );
        x += columns[index];
      });
      this.y -= height;
      this.page.drawLine({
        start: { x: PAGE.margin, y: this.y + 1 },
        end: { x: PAGE.width - PAGE.margin, y: this.y + 1 },
        thickness: 0.3,
        color: RULE,
      });
    }
    this.y -= 8;
  }
}

export type ReportMeta = { fingerprint: string; signature: string; generatedAt: string; pages: number; frameworks: string[] };

/** Builds the audit-readiness report for a tenant and records its fingerprint in the audit chain. */
export async function buildReadinessReport(
  actor: Actor,
  options: { frameworkId?: FrameworkId } = {},
): Promise<{ bytes: Uint8Array; meta: ReportMeta }> {
  const snapshot = await complianceSnapshot(actor.tenantId);
  const tenant = await (
    await getDb()
  )
    .scope(actor.tenantId)
    .get<{ name: string; region: string }>("SELECT name, region FROM tenants WHERE id = ?", actor.tenantId);
  const chain = await verifyAuditChain(actor.tenantId);
  const adopted = snapshot.adoptions.map((item) => item.frameworkId).filter((id) => !options.frameworkId || id === options.frameworkId);
  const details = await Promise.all(adopted.map((id) => frameworkDetail(actor.tenantId, id)));
  const generatedAt = new Date().toISOString();
  const nameOf = (id: string) => snapshot.catalog.find((item) => item.id === id)?.name ?? id;

  const controlsByVerification = ["verified", "documented", "failing", "stale", "unverified"].map((key) => ({
    key,
    count: snapshot.controls.filter((control) => control.verification === key && (control.linkedControlCode || key === "documented"))
      .length,
  }));
  const attested = snapshot.controls.filter((control) => ["implemented", "partial", "planned"].includes(control.status));
  const body = {
    tenant: actor.tenantId,
    generatedAt,
    scores: snapshot.scores
      .filter((item) => adopted.includes(item.frameworkId))
      .map((item) => ({
        id: item.frameworkId,
        score: item.score,
        verified: item.verifiedShare,
        gaps: item.gaps,
        compliant: item.compliant,
      })),
    controls: snapshot.controls.map((control) => ({ code: control.code, status: control.status, verification: control.verification })),
    roadmap: snapshot.roadmap.slice(0, 15).map((item) => item.code),
    audit: chain.valid ? { entries: chain.checked, rootHash: chain.rootHash } : { broken: true },
  };
  const fingerprint = sha256(canonicalJson(body));
  const signature = signDecision({ fingerprint, tenant: actor.tenantId, generatedAt });

  const pdf = await PDFDocument.create();
  pdf.setTitle("Audit readiness report");
  pdf.setSubject(`Kontrol compliance posture for ${tenant?.name ?? actor.tenantId}`);
  pdf.setProducer("Kontrol");
  pdf.setCreator("Kontrol continuous decision assurance");
  pdf.setCreationDate(new Date(generatedAt));
  const layout = new Layout(
    pdf,
    await pdf.embedFont(StandardFonts.Helvetica),
    await pdf.embedFont(StandardFonts.HelveticaBold),
    await pdf.embedFont(StandardFonts.Courier),
  );

  // Cover -----------------------------------------------------------------------------------------------------------
  layout.y -= 60;
  layout.page.drawText("KONTROL", { x: PAGE.margin, y: layout.y, size: 10, font: layout.mono, color: ACCENT });
  layout.y -= 34;
  layout.text("Audit readiness report", { size: 28, font: layout.bold, gap: 6 });
  layout.text(tenant?.name ?? actor.tenantId, { size: 14, color: MUTED, gap: 2 });
  layout.text(`Generated ${generatedAt.slice(0, 10)} by ${actor.name}`, { size: 9, color: MUTED, gap: 24 });
  const overall = snapshot.overall;
  layout.page.drawRectangle({ x: PAGE.margin, y: layout.y - 70, width: layout.width, height: 70, color: rgb(0.93, 0.92, 0.88) });
  layout.page.drawText(`${overall.score}%`, {
    x: PAGE.margin + 16,
    y: layout.y - 48,
    size: 34,
    font: layout.bold,
    color: scoreColor(overall.score),
  });
  layout.page.drawText(pdfSafe(`${overall.readiness} across ${overall.frameworks} framework(s)`), {
    x: PAGE.margin + 130,
    y: layout.y - 32,
    size: 12,
    font: layout.bold,
    color: INK,
  });
  layout.page.drawText(
    pdfSafe(
      `${snapshot.alerts.contradictions.length} evidence contradiction(s) · ${snapshot.alerts.pendingExceptions} exception(s) pending · ${snapshot.alerts.overduePolicies} overdue policy review(s)`,
    ),
    { x: PAGE.margin + 130, y: layout.y - 50, size: 8.5, font: layout.regular, color: MUTED },
  );
  layout.y -= 92;
  if (snapshot.alerts.demoPosture)
    layout.text("SAMPLE DATA: this report was generated from the demonstration posture and must not be used as evidence.", {
      font: layout.bold,
      color: BAD,
      gap: 10,
    });
  layout.text(
    "Kontrol supports governance work. This report summarises self-attested and machine-verified control status against published frameworks. It is not legal advice and it is not a certification opinion. Control-to-requirement mappings are indicative and are reviewed per tenant (see Mapping review).",
    { size: 8.5, color: MUTED, gap: 14 },
  );

  layout.heading("1. Executive summary");
  layout.table(
    ["Framework", "Score", "Readiness", "Compliant", "Partial", "Gaps", "Evidence-verified"],
    [150, 45, 80, 55, 45, 40, 70],
    snapshot.scores
      .filter((item) => adopted.includes(item.frameworkId))
      .map((item) => [
        nameOf(item.frameworkId),
        `${item.score}%`,
        item.readiness,
        String(item.compliant),
        String(item.partial),
        String(item.gaps),
        `${item.verifiedShare}%`,
      ]),
  );
  layout.text(
    `Scores weight each unified control (implemented 1, partial 0.5, planned 0.15, not started 0) and average the controls behind each requirement. A control backed by failing machine evidence cannot count for more than a partial implementation.`,
    { size: 8.5, color: MUTED },
  );

  // Evidence integrity ----------------------------------------------------------------------------------------------
  layout.heading("2. Evidence and integrity");
  layout.table(
    ["Evidence-backed controls", "Count"],
    [200, 60],
    controlsByVerification.map((item) => [
      item.key === "verified" ? "verified (machine evidence)" : item.key === "documented" ? "documented (reviewed documents)" : item.key,
      String(item.count),
    ]),
  );
  layout.text(
    `Attestations: ${attested.length} attested control(s), ${attested.filter((control) => control.attestationExpired).length} past their review date, ${attested.filter((control) => control.countersignedBy).length} countersigned by a second person${snapshot.policy.requireCountersignature ? " (required by policy)" : ""}. ${snapshot.alerts.pendingEvidence} document(s) awaiting review.`,
    { size: 8.5, color: MUTED },
  );
  if (snapshot.alerts.contradictions.length) {
    layout.heading("Contradictions: attested but contradicted by live evidence", 2);
    layout.table(
      ["Control", "Attested", "Linked evidence"],
      [200, 70, 150],
      snapshot.alerts.contradictions.map((item) => [`${item.code} ${item.title}`, item.attested, item.linkedControlCode ?? ""]),
    );
  }
  layout.heading("Audit ledger", 2);
  layout.text(
    chain.valid
      ? `The tenant audit chain verified: ${chain.checked} entries, root hash ${chain.rootHash ?? "n/a"}.`
      : `AUDIT CHAIN VERIFICATION FAILED at entry ${chain.brokenAt}. Do not rely on this report.`,
    { font: chain.valid ? layout.regular : layout.bold, color: chain.valid ? INK : BAD },
  );

  // Per framework ---------------------------------------------------------------------------------------------------
  layout.heading("3. Framework detail");
  for (const detail of details) {
    layout.heading(`${detail.framework?.name} ${detail.framework?.version}`, 2);
    layout.text(
      `${detail.score}% · ${detail.readiness} · ${detail.applicable} applicable requirement(s), ${detail.notApplicable} excluded with justification. ${detail.framework?.granularity}.`,
      { size: 8.5, color: MUTED },
    );
    const dimensions = detail.assessment.dimensions;
    layout.text(
      `Audit readiness: ${detail.readiness}. Declared ${dimensions.declared}%, documents ${dimensions.documentary}%, machine-verified ${dimensions.technical}%, backed by either ${dimensions.backed}% of ${detail.assessment.scope.controls} controls in scope.`,
      { size: 8.5, font: layout.bold },
    );
    for (const text of detail.assessment.blockers) layout.text(`Blocking: ${text}`, { size: 8.5, color: BAD });
    for (const text of detail.assessment.reservations) layout.text(`Reservation: ${text}`, { size: 8.5, color: MUTED });
    for (const group of detail.groups) layout.bar(group.group, group.score);
    const open = detail.requirements.filter((item) => item.status === "gap" || item.status === "initial").slice(0, 20);
    if (open.length) {
      layout.y -= 4;
      layout.text(`Open requirements (${detail.gaps} gap(s); first ${open.length} shown)`, { size: 9, font: layout.bold });
      layout.table(
        ["Requirement", "Title", "Status", "Controls"],
        [60, 230, 50, 110],
        open.map((item) => [item.id, item.title, item.status, item.controls.join(" ")]),
      );
    }
  }

  // Roadmap ---------------------------------------------------------------------------------------------------------
  layout.heading("4. Remediation roadmap");
  layout.text("Incomplete controls ranked by leverage (requirements advanced across the adopted frameworks) divided by typical effort.", {
    size: 8.5,
    color: MUTED,
  });
  layout.table(
    ["#", "Control", "Status", "Effort", "Leverage", "Priority"],
    [20, 250, 60, 40, 50, 50],
    snapshot.roadmap
      .slice(0, 15)
      .map((item, index) => [
        String(index + 1),
        `${item.code} ${item.title}`,
        item.currentStatus.replace("_", " "),
        `${item.effort}/5`,
        String(item.leverage),
        String(item.priority),
      ]),
  );

  // Exceptions & policies -------------------------------------------------------------------------------------------
  layout.heading("5. Risk acceptances and policies");
  layout.table(
    ["Exception", "Control", "Risk", "Status", "Expires"],
    [200, 70, 45, 60, 70],
    snapshot.exceptions.length
      ? snapshot.exceptions.map((item) => [
          item.title,
          item.uc_code,
          item.risk_level,
          item.expired ? "expired" : item.status,
          item.expires_at.slice(0, 10),
        ])
      : [["No exceptions recorded", "", "", "", ""]],
  );
  layout.table(
    ["Policy", "Version", "Status", "Next review"],
    [210, 50, 70, 80],
    snapshot.policies.length
      ? snapshot.policies.map((item) => [
          item.title,
          item.version,
          item.status,
          `${item.next_review?.slice(0, 10) ?? "n/a"}${item.overdue ? " (overdue)" : ""}`,
        ])
      : [["No policies registered", "", "", ""]],
  );

  // Mapping review --------------------------------------------------------------------------------------------------
  layout.heading("6. Mapping review");
  layout.text(
    "Share of crosswalk links backed by a published source (for example NIST's informative references) or reviewed by this tenant. Rejected and added links change the scores above.",
    { size: 8.5, color: MUTED },
  );
  layout.table(
    ["Framework", "Links", "Published", "Validated", "Rejected", "Added", "Reviewed"],
    [140, 40, 55, 55, 50, 40, 55],
    snapshot.mapping
      .filter((item) => adopted.includes(item.frameworkId))
      .map((item) => [
        nameOf(item.frameworkId),
        String(item.links),
        String(item.published),
        String(item.validated),
        String(item.rejected),
        String(item.added),
        `${item.reviewedShare}%`,
      ]),
  );

  // Report integrity ------------------------------------------------------------------------------------------------
  layout.heading("7. Report integrity");
  layout.text(
    "The fingerprint is the SHA-256 of the canonical report data; the signature is an HMAC-SHA-256 over it with the platform signing key. The fingerprint is also appended to the tenant's tamper-evident audit log, so this document can be verified later.",
    { size: 8.5, color: MUTED },
  );
  layout.text(`Fingerprint  ${fingerprint}`, { font: layout.mono, size: 8 });
  layout.text(`Signature    ${signature}`, { font: layout.mono, size: 8 });
  layout.text(`Generated    ${generatedAt}`, { font: layout.mono, size: 8 });

  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    page.drawLine({
      start: { x: PAGE.margin, y: PAGE.margin - 6 },
      end: { x: PAGE.width - PAGE.margin, y: PAGE.margin - 6 },
      thickness: 0.4,
      color: RULE,
    });
    page.drawText(pdfSafe(`Kontrol · ${tenant?.name ?? actor.tenantId} · fingerprint ${fingerprint.slice(0, 16)}`), {
      x: PAGE.margin,
      y: PAGE.margin - 18,
      size: 7,
      font: layout.mono,
      color: MUTED,
    });
    page.drawText(`Page ${index + 1} of ${pages.length}`, {
      x: PAGE.width - PAGE.margin - 50,
      y: PAGE.margin - 18,
      size: 7,
      font: layout.mono,
      color: MUTED,
    });
  });

  await appendAudit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "compliance.report_generated",
    objectType: "report",
    objectId: fingerprint,
    payload: { fingerprint, signature, frameworks: adopted, pages: pages.length },
  });
  return { bytes: await pdf.save(), meta: { fingerprint, signature, generatedAt, pages: pages.length, frameworks: adopted } };
}
