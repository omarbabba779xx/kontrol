import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// Buttons fade while a request is pending; let the transition finish before measuring contrast.
const serious = async (page: Page) => (await page.waitForTimeout(500), await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => `${item.id} (${item.nodes.length})`);

test("the ISMS page shows the clause checklist and records context, scope, an objective and a nonconformity", async ({ page }) => {
  await page.goto("/isms");
  await expect(page.getByRole("heading", { name: "ISMS" })).toBeVisible();
  const clauses = page.getByRole("table", { name: /clauses 4 to 10/ });
  await expect(clauses.getByRole("row")).toHaveCount(22);
  await expect(clauses.getByRole("row", { name: /4\.3/ })).toContainText("missing");
  expect(await serious(page)).toEqual([]);

  await page.getByRole("tab", { name: "Context" }).click();
  await page.getByLabel("Title").fill("Rapid growth of the engineering team");
  await page.getByLabel("Detail").fill("New joiners outpace onboarding");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Recorded", { exact: true })).toBeVisible();
  await expect(page.getByText("Rapid growth of the engineering team")).toBeVisible();
  await page.getByLabel("Kind").selectOption("interested_party");
  await page.getByLabel("Title").fill("Customers");
  await page.getByLabel("Requirement").fill("Incident notice within 72 hours");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText("Incident notice within 72 hours")).toBeVisible();

  await page.getByRole("tab", { name: "Scope" }).click();
  await page.getByLabel("Scope statement").fill("The ISMS covers the design, development and operation of the lending platform.");
  await page.getByRole("button", { name: "Approve scope" }).click();
  await expect(page.getByText("Scope approved")).toBeVisible();
  await expect(page.getByText(/Version 1, approved on/)).toBeVisible();

  await page.getByRole("tab", { name: "Objectives" }).click();
  await page.getByLabel("Objective", { exact: true }).fill("Patch critical vulnerabilities quickly");
  await page.getByLabel("Measure", { exact: true }).fill("Median days to patch");
  await page.getByLabel("Target").fill("7 days");
  await page.getByLabel("Owner").selectOption({ index: 1 });
  await page.getByLabel("Due date").fill("2027-06-30");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect(page.getByText("Objective set")).toBeVisible();
  await page.getByLabel(/Measured value for Patch critical/).fill("9 days");
  await page.getByRole("button", { name: "Record" }).click();
  await expect(page.getByText("Measurement recorded")).toBeVisible();
  await expect(page.getByText(/latest 9 days/)).toBeVisible();

  await page.getByRole("tab", { name: "Nonconformities" }).click();
  await page.getByLabel("Finding").fill("Leavers kept access for 30 days");
  await page.getByRole("button", { name: "Raise" }).click();
  await expect(page.getByText("Nonconformity raised")).toBeVisible();
  await expect(page.getByText("NC-001")).toBeVisible();
  expect(await serious(page)).toEqual([]);

  await page.getByRole("tab", { name: "Clauses" }).click();
  await expect(clauses.getByRole("row", { name: /4\.3/ })).toContainText("met");
  await expect(clauses.getByRole("row", { name: /4\.2/ })).toContainText("met");
  await expect(clauses.getByRole("row", { name: /6\.2/ })).toContainText("met");
});

test("the risk register shows the method and lets an administrator approve it", async ({ page }) => {
  await page.goto("/risk-register");
  await page.getByText("Risk method and appetite").click();
  await expect(page.getByText(/built-in defaults, not approved/)).toBeVisible();
  await page.getByLabel("Appetite").selectOption("low");
  await page.getByRole("button", { name: "Approve method" }).click();
  await expect(page.getByText("Risk method approved")).toBeVisible();
  await expect(page.getByText(/appetite: low · version 1, approved on/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Risk treatment plan/ })).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test("an incident is reported and moved forward, and a competence record is kept", async ({ page }) => {
  await page.goto("/isms");
  await page.getByRole("tab", { name: "Incidents" }).click();
  await page.getByLabel("Incident", { exact: true }).fill("Phishing email reported by staff");
  await page.getByLabel("Detected on").fill("2026-09-01");
  await page.getByRole("button", { name: "Report" }).click();
  await expect(page.getByText("Incident reported")).toBeVisible();
  await expect(page.getByText("INC-001")).toBeVisible();
  await page.getByRole("button", { name: "Mark contained" }).click();
  await expect(page.getByText("Incident contained")).toBeVisible();
  expect(await serious(page)).toEqual([]);

  await page.getByRole("tab", { name: "Records" }).click();
  await page.getByLabel("Record kind").selectOption("competence");
  await page.getByLabel("Record title").fill("Security lead");
  await page.getByLabel("Competence needed").fill("ISO 27001 lead implementer");
  await page.getByLabel("Evidence it is met").fill("Certificate 2025");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText("Security lead")).toBeVisible();
  await page.getByRole("tab", { name: "Internal audits" }).click();
  await expect(page.getByText(/An auditor does not audit controls they own/)).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test("an asset is valued, a threat is assessed on it, and the scenario shows in the traceability view", async ({ page }) => {
  await page.goto("/risk-register");
  await page.getByRole("tab", { name: "Identification" }).click();
  const asset = page.getByRole("listitem").filter({ hasText: "lending-decision-service" });
  await asset.getByLabel("confidentiality of lending-decision-service").selectOption("5");
  await asset.getByRole("button", { name: "Save valuation" }).click();
  await expect(page.getByText("Asset valued")).toBeVisible();
  await expect(page.getByText(/valued C5 I3 A3/)).toBeVisible();
  await asset.getByRole("button", { name: "Assess scenario" }).click();
  await expect(page.getByText("Scenario recorded as a risk")).toBeVisible();
  expect(await serious(page)).toEqual([]);
  await page.getByRole("tab", { name: "Traceability" }).click();
  const table = page.getByRole("table", { name: "Risk traceability" });
  await expect(table.getByRole("row", { name: /lending-decision-service/ }).first()).toBeVisible();
  expect(await serious(page)).toEqual([]);
});
