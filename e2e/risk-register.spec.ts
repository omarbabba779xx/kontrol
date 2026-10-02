import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const serious = async (page: Page) => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => `${item.id} (${item.nodes.length})`);

test("a risk is added, rated, quantified, planned and shown on the heat map", async ({ page }) => {
  await page.goto("/risk-register");
  await expect(page.getByRole("heading", { name: "Risk register" })).toBeVisible();

  await page.getByText("Add a risk").click();
  await page.getByLabel("Risk title").fill("Ransomware on the claims platform halts payouts");
  await page.getByLabel("Likelihood", { exact: true }).selectOption("4");
  await page.getByLabel("Impact", { exact: true }).selectOption("5");
  await page.getByLabel("Linked controls").fill("UC-OPS-02, UC-DAT-05");
  await page.getByRole("button", { name: "Add risk" }).click();
  await expect(page.getByText("Risk added")).toBeVisible();

  const row = page.getByRole("row", { name: /Ransomware on the claims platform/ });
  await expect(row).toContainText("RSK-");
  await expect(row).toContainText("20 critical");
  await expect(page.getByRole("cell", { name: "Likelihood 4, impact 5: 1 risk" }).first()).toBeVisible();
  expect(await serious(page)).toEqual([]);

  await row.getByRole("button", { name: /Details/ }).click();
  await expect(page.getByText("Controls treating this risk")).toBeVisible();
  await page.getByLabel(/Treatment plan of RSK-/).fill("Segment backups and test restoration quarterly.");
  await page.getByRole("button", { name: "Save plan" }).click();
  await expect(page.getByText("Plan saved")).toBeVisible();
  await page.getByRole("button", { name: /Quantify/ }).click();
  await expect(page.getByText("Quantified", { exact: true })).toBeVisible();
  await expect(page.getByText(/A simulation under stated assumptions, not a forecast/)).toBeVisible();

  await page.getByLabel(/Treatment of RSK-/).selectOption("mitigate");
  await expect(page.getByText("Treatment updated")).toBeVisible();
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByText("Treatment task created")).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test("risks are created from control gaps", async ({ page }) => {
  await page.goto("/compliance");
  const load = page.getByRole("button", { name: /Charger la posture d.exemple/ });
  const loadedSample = await load.isVisible();
  if (loadedSample) { await load.click(); await expect(page.getByText("Sample posture").first()).toBeVisible(); }
  await page.goto("/risk-register");
  await page.getByRole("button", { name: "Create risks from control gaps" }).click();
  await expect(page.getByText("Risks created from control gaps")).toBeVisible();
  await expect(page.getByRole("row", { name: /Gap:/ }).first()).toBeVisible();
  if (loadedSample) {
    await page.goto("/compliance");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Purger l.exemple/ }).click();
    await expect(page.getByText(/Données d.exemple supprimées/)).toBeVisible();
  }
});
