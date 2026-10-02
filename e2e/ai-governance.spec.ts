import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// Buttons fade while a request is pending; let the transition finish before measuring contrast.
const serious = async (page: Page) => (await page.waitForTimeout(500), await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => `${item.id} (${item.nodes.length}): ${item.nodes.map((node) => node.html.slice(0, 160)).join(" | ")}`);

test("an AI system is registered, classified high-risk with its reasoning, and given a model card", async ({ page }) => {
  await page.goto("/ai-governance");
  await expect(page.getByRole("heading", { name: "AI governance" })).toBeVisible();

  await page.getByLabel("AI system name").fill("Consumer credit scoring assistant");
  await page.getByLabel("Purpose").fill("Ranks loan applications for manual review");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText("AI system registered")).toBeVisible();
  await expect(page.getByRole("row", { name: /Consumer credit scoring assistant/ })).toContainText("not classified");

  await page.getByLabel("Annex III area").selectOption("essential_services");
  await page.getByRole("button", { name: "Classify", exact: true }).click();
  await expect(page.getByText("Classified", { exact: true })).toBeVisible();
  await expect(page.getByText(/Annex III area: Essential services/)).toBeVisible();
  await expect(page.getByRole("row", { name: /Consumer credit scoring assistant/ })).toContainText("high");
  expect(await serious(page)).toEqual([]);

  await page.getByRole("tab", { name: "Obligations" }).click();
  await expect(page.getByText("Art.26(1)")).toBeVisible();
  await expect(page.getByText("Art.27")).toBeVisible();

  await page.getByRole("tab", { name: "Model card" }).click();
  const sections = page.locator("textarea");
  const filled = ["Rank consumer loan applications for review", "Not for employment or insurance decisions", "Gradient-boosted model v3.2 trained in-house", "Five years of historical applications, rebalanced", "AUC 0.81, equal-opportunity gap 2.1 points", "Degrades for thin-file applicants", "An underwriter reviews every decline"];
  for (let index = 0; index < filled.length; index += 1) await sections.nth(index).fill(filled[index]);
  await page.getByRole("button", { name: "Save model card" }).click();
  await expect(page.getByText("Model card saved as a new version")).toBeVisible();
  await expect(page.getByText(/Version 1 of 1/)).toBeVisible();

  await page.getByRole("tab", { name: "Decision" }).click();
  await page.getByLabel(/Decision note for AIS-/).fill("Attempting to approve my own registration");
  await page.getByRole("button", { name: "Approve for use" }).click();
  await expect(page.getByText(/Separation of duties|impact assessment is required|owner/).first()).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test("a prohibited practice is blocked", async ({ page }) => {
  await page.goto("/ai-governance");
  await page.getByLabel("AI system name").fill("Workforce mood scoring");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText("AI system registered")).toBeVisible();
  await page.getByLabel(/Inferring emotions of people in the workplace/).check();
  await page.getByRole("button", { name: "Classify", exact: true }).click();
  await expect(page.getByRole("row", { name: /Workforce mood scoring/ })).toContainText("blocked");
  await expect(page.getByRole("row", { name: /Workforce mood scoring/ })).toContainText("prohibited");
});
