import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const serious = async (page: Page) => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => `${item.id} (${item.nodes.length})`);

test("an administrator adds a user and cannot demote the last administrator", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
  await expect(page.getByText("leila@acme.example")).toBeVisible();

  await page.getByLabel("Full name").fill("Priya Nair");
  await page.getByLabel("Email", { exact: true }).fill("priya.nair@acme.example");
  await page.getByLabel("Role", { exact: true }).selectOption("control_owner");
  await page.getByRole("button", { name: "Add user" }).click();
  await expect(page.getByText("User created")).toBeVisible();
  await expect(page.getByText("priya.nair@acme.example")).toBeVisible();

  await page.getByLabel("Role of priya.nair@acme.example").selectOption("auditor");
  await expect(page.getByText("Role updated")).toBeVisible();

  await page.getByLabel("Role of leila@acme.example").selectOption("viewer");
  await expect(page.getByText(/last active administrator cannot be demoted/)).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test("API keys are shown once and can be revoked", async ({ page }) => {
  await page.goto("/admin");
  await tab(page, "API keys").click();
  await page.getByLabel("Key name").fill("CI pipeline");
  await page.getByLabel("Key role").selectOption("auditor");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText(/Copy this key now/)).toBeVisible();
  await expect(page.getByText(/^kon_[A-Za-z0-9_-]{43}$/)).toBeVisible();
  expect(await serious(page)).toEqual([]);

  await page.getByRole("button", { name: "I have saved it" }).click();
  await expect(page.getByText(/^kon_[A-Za-z0-9_-]{43}$/)).toHaveCount(0);
  await expect(page.getByRole("row", { name: /CI pipeline/ })).toContainText("auditor");
  await page.getByRole("button", { name: "Revoke" }).first().click();
  await expect(page.getByText("API key revoked")).toBeVisible();
  await expect(page.getByRole("row", { name: /CI pipeline/ })).toContainText("revoked");
});

test("connector credentials are stored encrypted and never displayed again", async ({ page }) => {
  await page.goto("/admin");
  await tab(page, "Connections").click();
  const card = page.locator("div.border", { hasText: "GitHub" }).filter({ hasText: "Fine-grained token" }).first();
  await card.getByRole("button", { name: "Configure" }).click();
  const secret = `github_pat_${"B".repeat(30)}WXYZ`;
  await page.getByLabel("GitHub Access token").fill(secret);
  await page.getByRole("button", { name: "Save encrypted" }).click();
  await expect(page.getByText("GitHub credentials saved")).toBeVisible();
  await expect(page.getByText("configured …WXYZ")).toBeVisible();
  expect(await page.content()).not.toContain(secret);

  const response = await page.request.get("/api/admin");
  expect(JSON.stringify(await response.json())).not.toContain(secret);
  expect(await serious(page)).toEqual([]);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Remove" }).first().click();
  await expect(page.getByText("GitHub credentials removed")).toBeVisible();
});

test("a connector can be tested, scheduled and run on demand", async ({ page }) => {
  await page.goto("/admin");
  await tab(page, "Connections").click();
  for (const name of ["GitHub", "GitLab", "Okta", "AWS", "Google Workspace", "Microsoft Entra ID"]) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();

  const okta = page.locator("div.border", { hasText: "API token with read access to users, roles and policies" }).first();
  await okta.getByRole("button", { name: "Test connection" }).click();
  await expect(okta.getByText(/No Okta credentials are stored/)).toBeVisible();

  await page.getByLabel("Okta schedule").selectOption("1440");
  await expect(page.getByText("Schedule saved")).toBeVisible();
  await okta.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Collection finished")).toBeVisible();
  await expect(okta.getByText(/^ok · last/)).toBeVisible();
  await expect(page.getByRole("row", { name: /okta.*MANUAL.*OK/i })).toBeVisible();
  expect(await serious(page)).toEqual([]);

  await page.getByLabel("Okta schedule").selectOption("0");
  await expect(page.getByText("Schedule turned off")).toBeVisible();
});

test("the authentication overview explains the instance's security posture", async ({ page }) => {
  await page.goto("/admin");
  await tab(page, "Authentication").click();
  await expect(page.getByText("Single sign-on (OIDC)")).toBeVisible();
  await expect(page.getByText(/anyone reaching this instance acts as the demo administrator/)).toBeVisible();
  expect(await serious(page)).toEqual([]);
});
