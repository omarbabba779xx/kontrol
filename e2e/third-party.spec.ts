import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// Buttons fade while a request is pending; let the transition finish before measuring contrast.
const serious = async (page: Page) => (await page.waitForTimeout(500), await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => `${item.id} (${item.nodes.length})`);

test("a provider and a critical arrangement are registered, flagged, and a vendor answers a one-time link", async ({ page, browser }) => {
  await page.goto("/third-party");
  await expect(page.getByRole("heading", { name: "Third parties" })).toBeVisible();

  await page.getByLabel("Provider name").fill("Nimbus Cloud");
  await page.getByLabel("Provider country").fill("IE");
  await page.getByRole("button", { name: "Add provider" }).click();
  await expect(page.getByText("Provider added")).toBeVisible();

  await page.getByText("Add a contractual arrangement").click();
  await page.getByLabel("Arrangement provider").selectOption({ label: "Nimbus Cloud" });
  await page.getByLabel("Function supported").fill("Core banking hosting");
  await page.getByLabel("Start date").fill("2025-01-01");
  await page.getByLabel("Service in").fill("IE");
  await page.getByLabel("Data in").fill("IE");
  await page.getByRole("button", { name: "Add arrangement" }).click();
  await expect(page.getByText("Arrangement added")).toBeVisible();
  await expect(page.getByRole("row", { name: /ARR-001/ })).toContainText("critical");
  expect(await serious(page)).toEqual([]);

  await page.getByRole("tab", { name: "Findings" }).click();
  await expect(page.getByText("provider has no legal entity identifier")).toBeVisible();
  await expect(page.getByText("Governing law of the contract is not recorded")).toBeVisible();
  await page.getByRole("tab", { name: "Export" }).click();
  await expect(page.getByText(/Export is blocked until/)).toBeVisible();

  await page.getByRole("tab", { name: "Questionnaires" }).click();
  await page.getByLabel("Questionnaire provider").selectOption({ label: "Nimbus Cloud" });
  await page.getByRole("button", { name: "Create link" }).click();
  const link = (await page.locator("code").first().textContent()) ?? "";
  expect(link).toContain("/vendor-response/");

  const vendor = await (await browser.newContext()).newPage();
  await vendor.goto(link);
  await expect(vendor.getByRole("heading", { name: "Security questionnaire" })).toBeVisible();
  expect(await serious(vendor)).toEqual([]);
  await vendor.getByLabel("Your name").fill("Sam Vendor");
  await vendor.getByLabel("Your work email").fill("sam@nimbus.example");
  const groups = await vendor.locator("fieldset").count();
  expect(groups).toBe(20);
  for (let index = 0; index < groups; index += 1) await vendor.locator("fieldset").nth(index).getByLabel("Yes").check();
  await vendor.getByRole("button", { name: "Submit answers" }).click();
  await expect(vendor.getByText(/Your answers were received/)).toBeVisible();
  await vendor.reload();
  await expect(vendor.getByText(/invalid, expired or has been used/)).toBeVisible();

  await page.reload();
  await page.getByRole("tab", { name: "Questionnaires" }).click();
  const row = page.getByRole("row", { name: /Nimbus Cloud/ });
  await expect(row).toContainText("submitted");
  await expect(row).toContainText("100");
});
