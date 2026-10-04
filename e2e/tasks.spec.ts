import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

// Buttons fade while a request is pending; let the transition finish before measuring contrast.
const serious = async (page: Page) => (await page.waitForTimeout(500), await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations.filter((item) => item.impact === "serious" || item.impact === "critical").map((item) => `${item.id} (${item.nodes.length})`);

test("a task is created, assigned, discussed and completed", async ({ page }) => {
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "Remediation tasks" })).toBeVisible();

  await page.getByLabel("Task title").fill("Rotate the production signing key");
  await page.getByLabel("Task description").fill("Rotate and record the new key fingerprint.");
  await page.getByLabel("Priority", { exact: true }).selectOption("high");
  await page.getByLabel("Due date").fill(new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10));
  await page.getByLabel("Assignee", { exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByText("Task created")).toBeVisible();

  const row = page.getByRole("row", { name: /Rotate the production signing key/ });
  await expect(row).toContainText("OVERDUE");
  await expect(row).toContainText("high");
  expect(await serious(page)).toEqual([]);

  await row.getByRole("button", { name: /Details/ }).click();
  await expect(page.getByText("Rotate and record the new key fingerprint.")).toBeVisible();
  await page.getByLabel("Comment on Rotate the production signing key").fill("Waiting for the HSM maintenance window.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Comment added")).toBeVisible();
  await expect(page.getByText("Waiting for the HSM maintenance window.")).toBeVisible();

  await page.getByLabel("Status of Rotate the production signing key").selectOption("done");
  await expect(page.getByText("Task updated")).toBeVisible();
  await expect(page.getByRole("row", { name: /Rotate the production signing key/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("row", { name: /Rotate the production signing key/ })).toBeVisible();
  expect(await serious(page)).toEqual([]);
});

test("tasks can be generated from the compliance roadmap", async ({ page }) => {
  await page.goto("/compliance");
  // Earlier specs may already have adopted frameworks: the roadmap exists either way.
  const load = page.getByRole("button", { name: /Load the sample posture/ });
  const loadedSample = await load.isVisible();
  if (loadedSample) {
    await load.click();
    await expect(page.getByText("Sample posture").first()).toBeVisible();
  }

  await page.goto("/tasks");
  await page.getByRole("button", { name: "Generate from roadmap" }).click();
  await expect(page.getByText("Tasks created from the roadmap")).toBeVisible();
  await expect(page.getByRole("row", { name: /Implement UC-/ }).first()).toBeVisible();
  expect(await page.getByRole("row", { name: /Implement UC-/ }).count()).toBe(10);

  if (loadedSample) {
    await page.goto("/compliance");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: /Remove the sample/ }).click();
    await expect(page.getByText(/Sample data removed/)).toBeVisible();
  }
});

test("a notification channel is created, switched off and deleted, and its destination never shown", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await page.getByLabel("Channel name").fill("#security-alerts");
  const url = "https://hooks.slack.com/services/T000/B000/XXXXSECRETXXXX";
  await page.getByLabel(/Slack .* Incoming webhook URL/).fill(url);
  await page.getByLabel("Minimum severity").selectOption("high");
  await page.getByLabel("task.overdue").check();
  await page.getByRole("button", { name: "Add channel" }).click();
  await expect(page.getByText("Channel created")).toBeVisible();

  const card = page.locator("div.border", { hasText: "#security-alerts" }).filter({ hasText: "slack" }).first();
  await expect(card).toContainText("hooks.slack.com");
  await expect(card).toContainText("task.overdue");
  await expect(card).toContainText("high+");
  expect(await page.content()).not.toContain("XXXXSECRETXXXX");
  expect(JSON.stringify(await (await page.request.get("/api/notifications")).json())).not.toContain("XXXXSECRETXXXX");
  expect(await serious(page)).toEqual([]);

  await card.getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("Channel turned off")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Channel deleted")).toBeVisible();
  await expect(page.getByText("#security-alerts")).toHaveCount(0);
});
