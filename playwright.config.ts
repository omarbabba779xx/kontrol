import { defineConfig, devices } from "@playwright/test";

const port = 3100;

/**
 * End-to-end tests run against a throwaway SQLite database on a dev server (demo authentication is only
 * honoured outside production). Locally PW_CHANNEL=chrome reuses the installed Chrome; CI installs Chromium.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  // Entrance animations are switched off so that axe never measures a half-faded page.
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure", screenshot: "only-on-failure", reducedMotion: "reduce" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL || undefined } }],
  webServer: { command: "node e2e/start.mjs", url: `http://localhost:${port}/api/health`, reuseExistingServer: false, timeout: 240_000, stdout: "pipe" },
});
