import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

test("an empty tenant offers the sample posture, and loading it scores six frameworks", async ({ page }) => {
  await page.goto("/compliance");
  await expect(page.getByText("No posture recorded for this organisation.")).toBeVisible();
  await page.getByRole("button", { name: /Load the sample posture/ }).click();
  await expect(page.getByText("Sample posture").first()).toBeVisible();
  await expect(page.getByText("Overall posture")).toBeVisible();
  for (const name of ["ISO/IEC 27001", "NIST Cybersecurity Framework", "GDPR", "DORA", "EU AI Act", "SOC 2 Trust Services Criteria"]) await expect(page.getByRole("button", { name: new RegExp(name) }).first()).toBeVisible();
});

test("the compliance hub has no serious accessibility violations on any tab", async ({ page }) => {
  await page.goto("/compliance");
  for (const name of ["Overview", "Frameworks", "Control library", "Roadmap", "Exceptions", "Policies"]) {
    await tab(page, name).click();
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    expect(serious.map((violation) => `${name}: ${violation.id} (${violation.nodes.length})`), `axe on ${name}`).toEqual([]);
  }
});

test("a reviewer can validate, reject and reset a crosswalk link with a note", async ({ page }) => {
  await page.goto("/compliance");
  await tab(page, "Frameworks").click();
  await page.getByRole("button", { name: "ISO 27001", exact: true }).click();
  await page.getByLabel("Search requirements").fill("A8.15");
  const row = page.getByRole("row", { name: /A8\.15/ });
  await row.getByRole("button", { name: /UC-OPS-05/ }).click();

  await page.getByLabel("Review note").fill("Reviewed against ISO 27002 guidance.");
  await page.getByRole("button", { name: "Validate" }).first().click();
  await expect(page.getByText(/validated by/)).toBeVisible();

  await page.getByLabel("Review note").fill("Logging is handled by a different control here.");
  await page.getByRole("button", { name: "Reject" }).first().click();
  await expect(page.getByText(/rejected by/)).toBeVisible();
  await page.getByRole("button", { name: "Reset" }).first().click();
  await expect(page.getByText(/rejected by/)).toHaveCount(0);
});

test("exports are real files: Statement of Applicability and a signed PDF report", async ({ page }) => {
  const csv = await page.request.get("/api/compliance/frameworks/iso27001?format=csv");
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect((await csv.text()).split("\n")).toHaveLength(117);

  const pdf = await page.request.get("/api/compliance/report");
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["x-report-fingerprint"]).toMatch(/^[0-9a-f]{64}$/);
  expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");

  expect((await page.request.get("/api/compliance/frameworks/nope?format=csv")).status()).toBe(404);
  expect((await page.request.get("/api/compliance/report?framework=nope")).status()).toBe(404);
});

test("the requester of a risk acceptance cannot decide it themselves", async ({ page }) => {
  await page.goto("/compliance");
  await tab(page, "Exceptions").click();
  await page.getByLabel("Title").fill("Defer patching of the legacy billing host");
  await page.getByLabel("Justification").fill("The vendor has not certified the patch for this appliance yet.");
  await page.getByLabel("Compensating controls").fill("Host isolated on a dedicated VLAN with IDS monitoring.");
  await page.getByRole("button", { name: "Submit for decision" }).click();
  await expect(page.getByText("Defer patching of the legacy billing host")).toBeVisible();

  const card = page.locator("article", { hasText: "Defer patching of the legacy billing host" });
  await card.getByLabel("Decision note").fill("Approving my own request should fail.");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Separation of duties/)).toBeVisible();
});

test("an attester cannot countersign their own claim, and evidence goes through a second pair of eyes", async ({ page }) => {
  await page.goto("/compliance");
  await tab(page, "Control library").click();
  const row = page.getByRole("row", { name: /UC-GOV-01/ });
  await row.getByRole("button", { name: /Attestation and evidence/ }).click();

  await page.getByLabel("Attestation note for UC-GOV-01").fill("Confirming the policy framework myself.");
  await page.getByRole("button", { name: "Countersign" }).click();
  await expect(page.getByText(/Separation of duties/)).toBeVisible();

  await page.getByLabel("Evidence title for UC-GOV-01").fill("Information security policy v3.1, signed");
  await page.getByLabel("Evidence valid until for UC-GOV-01").fill(new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10));
  await page.getByLabel("Evidence file for UC-GOV-01").setInputFiles({ name: "policy.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 signed policy v3.1") });
  await page.getByRole("button", { name: "File document" }).click();
  await expect(page.getByText(/awaiting review by another person/)).toBeVisible();
  await expect(page.getByText("Information security policy v3.1, signed")).toBeVisible();

  await page.getByLabel(/Review note for Information security policy/).fill("Approving my own upload should fail.");
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByText(/the person who uploaded the evidence cannot review it/)).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id)).toEqual([]);
});

test("published suggestions from ENISA can be accepted from the framework view", async ({ page }) => {
  await page.goto("/compliance");
  await page.getByRole("row", { name: /NIS2 Directive/ }).getByRole("button", { name: "Adopt" }).click();
  await expect(page.getByText("NIS2 adopted")).toBeVisible();

  await tab(page, "Frameworks").click();
  await page.getByRole("button", { name: "NIS2", exact: true }).click();
  await page.getByLabel("Search requirements").fill("21(2)(a)");
  await page.getByRole("row", { name: /Art\.21\(2\)\(a\)/ }).getByRole("button", { name: /UC-/ }).first().click();
  await expect(page.getByText("Suggested by a published source")).toBeVisible();
  await expect(page.getByText(/ENISA NIS2 technical implementation mapping table/).first()).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).first().click();
  await expect(page.getByText("Mapping link updated")).toBeVisible();
});

test("an organisation can import its licensed PCI DSS sub-requirements and remove them again", async ({ page }) => {
  await page.goto("/compliance");
  await page.getByRole("row", { name: /PCI DSS/ }).getByRole("button", { name: "Adopt" }).click();
  await expect(page.getByText("PCI DSS adopted")).toBeVisible();

  await tab(page, "Frameworks").click();
  await page.getByRole("button", { name: "PCI DSS", exact: true }).click();
  await page.getByText(/Licensed content/).click();
  const payload = [
    { id: "Req.8.3.1", title: "User access is authenticated with at least one factor", parent: "Req.8.3", procedure: "Examine system configuration settings." },
    { id: "Req.8.3.2", title: "Strong cryptography protects authentication factors", parent: "Req.8.3", procedure: "Examine vendor documentation." },
  ];
  await page.getByLabel("Licensed content file").setInputFiles({ name: "pci.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)) });
  await page.getByLabel("Source label").fill("PCI DSS v4.0.1 (our licensed copy)");
  await page.getByLabel("Licence reference").fill("PCI SSC order 4711");
  const importButton = page.getByRole("button", { name: /^Import/ });
  await expect(importButton).toBeDisabled();
  await page.getByRole("checkbox").check();
  await importButton.click();
  await expect(page.getByText(/Content imported/)).toBeVisible();

  await page.getByLabel("Search requirements").fill("Req.8.3");
  await expect(page.getByRole("row", { name: /Req\.8\.3\.1/ })).toContainText("imported");
  await expect(page.getByRole("row", { name: /Req\.8\.3 / }).first()).toContainText(/Refined into 2 imported/);

  page.once("dialog", (dialog) => dialog.accept());
  const remove = page.getByRole("button", { name: "Remove", exact: true });
  if (!(await remove.isVisible())) await page.getByText(/Licensed content/).click();
  await remove.click();
  await expect(page.getByText("Imported content removed")).toBeVisible();
  await expect(page.getByRole("row", { name: /Req\.8\.3\.1/ })).toHaveCount(0);
});

test("purging the sample posture returns the tenant to an empty state", async ({ page }) => {
  await page.goto("/compliance");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Remove the sample/ }).click();
  await expect(page.getByText(/Sample data removed/)).toBeVisible();
  await expect(page.getByText("Sample posture")).toHaveCount(0);
});

test("every page of the platform renders without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${page.url()}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  for (const route of ["/", "/risks", "/controls", "/ai-systems", "/evidence", "/vendors", "/audits", "/intelligence", "/operations", "/assurance", "/enterprise", "/compliance"]) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page.locator("main")).toBeVisible();
    await page.waitForLoadState("networkidle");
  }
  expect(errors).toEqual([]);
});

test("the sidebar links to the compliance hub", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: /Compliance hub/ }).click();
  await expect(page).toHaveURL(/\/compliance$/);
  await expect(page.getByRole("heading", { name: "Compliance hub" })).toBeVisible();
});
