import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const serious = async (page: Page) => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => `${item.id} (${item.nodes.length})`);

test("an engagement is created, a request is raised and answered, and the pack is offered", async ({ page }) => {
  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Audit workspace" })).toBeVisible();

  await page.getByText("New engagement").click();
  await page.getByLabel("Engagement name").fill("SOC 2 Type II 2026");
  await page.getByLabel("Period start").fill("2026-01-01");
  await page.getByLabel("Period end").fill("2026-12-31");
  await page.getByLabel("Audit firm").fill("Northwind Assurance");
  await page.getByRole("button", { name: "Create engagement" }).click();
  await expect(page.getByText("Engagement created")).toBeVisible();
  await expect(page.getByRole("heading", { name: "SOC 2 Type II 2026" })).toBeVisible();

  await page.getByLabel("Request title").fill("Access review for Q2");
  await page.getByRole("button", { name: "Add request" }).click();
  await expect(page.getByText("Request created")).toBeVisible();
  const row = page.getByRole("row", { name: /Access review for Q2/ });
  await expect(row).toContainText("PBC-001");
  expect(await serious(page)).toEqual([]);

  await row.getByRole("button", { name: /Thread/ }).click();
  await page.getByLabel("Message on PBC-001").fill("Quarterly access review completed on 30 June.");
  await page.getByRole("button", { name: "Provide response" }).click();
  await expect(page.getByText("Response provided")).toBeVisible();
  await expect(page.getByRole("row", { name: /Access review for Q2/ })).toContainText("provided");

  await page.getByRole("tab", { name: "Period coverage" }).click();
  await expect(page.getByText(/days elapsed/)).toBeVisible();
  await page.getByRole("tab", { name: "Evidence pack" }).click();
  await expect(page.getByRole("link", { name: /Download evidence pack/ })).toBeVisible();
  expect(await serious(page)).toEqual([]);
});
