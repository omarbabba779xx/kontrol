// Takes the screenshots of the README from a running instance loaded with the Hydria example dossier.
//
//   1. start Kontrol on an empty database (KONTROL_SEED=empty, demo sign-in) and load examples/hydria (see its README)
//   2. KONTROL_URL=http://localhost:3000 npm run screenshots        (Chrome or Edge installed, or `npx playwright install chromium`)
//
// Images go to docs/screenshots/. Hydria is fictional: nothing on these pages describes a real organisation.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.KONTROL_URL ?? "http://localhost:3000";
const OUT = "docs/screenshots";
const WIDTH = 1440;

/** name, path, what to click before the capture (tab names), and how tall the capture is. */
const SHOTS = [
  ["decision-room", "/", [], 980],
  ["isms-clauses", "/isms", [], 1250],
  ["isms-incidents", "/isms", ["Incidents"], 900],
  ["isms-audits", "/isms", ["Internal audits"], 900],
  ["isms-reviews", "/isms", ["Reviews"], 900],
  ["isms-nonconformities", "/isms", ["Nonconformities"], 900],
  ["compliance-overview", "/compliance", [], 1100],
  ["compliance-frameworks", "/compliance", ["Frameworks"], 1000],
  ["risk-register", "/risk-register", [], 1000],
  ["risk-identification", "/risk-register", ["Identification"], 1000],
  ["risk-traceability", "/risk-register", ["Traceability"], 1000],
  ["tasks", "/tasks", [], 900],
  ["audit-workspace", "/audit", [], 900],
  ["administration", "/admin", [], 900],
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome" });
const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, deviceScaleFactor: 1 });
for (const [name, path, tabs, height] of SHOTS) {
  await page.setViewportSize({ width: WIDTH, height });
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  for (const tab of tabs) {
    await page.getByRole("tab", { name: tab, exact: true }).first().click();
    await page.waitForLoadState("networkidle");
  }
  // The development server shows its own badge in a corner; it is not part of the product.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  // Let numbers settle and transitions finish before the capture.
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`${OUT}/${name}.png`);
}
await browser.close();
