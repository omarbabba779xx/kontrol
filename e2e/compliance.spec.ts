import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

test("an empty tenant offers the sample posture, and loading it scores six frameworks", async ({ page }) => {
  await page.goto("/compliance");
  await expect(page.getByText("Aucune posture enregistrée pour ce tenant.")).toBeVisible();
  await page.getByRole("button", { name: /Charger la posture d.exemple/ }).click();
  await expect(page.getByText("Sample posture").first()).toBeVisible();
  await expect(page.getByText("Posture globale")).toBeVisible();
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
  await page.getByRole("button", { name: "Valider" }).first().click();
  await expect(page.getByText(/validated par/)).toBeVisible();

  await page.getByLabel("Review note").fill("Logging is handled by a different control here.");
  await page.getByRole("button", { name: "Rejeter" }).first().click();
  await expect(page.getByText(/rejected par/)).toBeVisible();
  await page.getByRole("button", { name: "Réinitialiser" }).first().click();
  await expect(page.getByText(/rejected par/)).toHaveCount(0);
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
  await page.getByRole("button", { name: "Soumettre pour décision" }).click();
  await expect(page.getByText("Defer patching of the legacy billing host")).toBeVisible();

  const card = page.locator("article", { hasText: "Defer patching of the legacy billing host" });
  await card.getByLabel("Decision note").fill("Approving my own request should fail.");
  await card.getByRole("button", { name: "Approuver" }).click();
  await expect(page.getByText(/Separation of duties/)).toBeVisible();
});

test("purging the sample posture returns the tenant to an empty state", async ({ page }) => {
  await page.goto("/compliance");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /Purger l.exemple/ }).click();
  await expect(page.getByText(/Données d.exemple supprimées/)).toBeVisible();
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
