// Runs every verification step and reports each one as passed, failed or NOT RUN, with the reason. Tests that were skipped are counted
// apart from tests that passed, and a step that could not run (for example OPA without its binary) is never shown as green.
//   node scripts/verify.mjs            run everything, exit 1 if anything failed
//   node scripts/verify.mjs --strict   also exit 1 if a required step was NOT RUN (use in CI)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const strict = process.argv.includes("--strict");
const opaBinary = process.env.KONTROL_OPA_BIN || "opa";
const opaAvailable = spawnSync(opaBinary, ["version"], { shell: true, stdio: "ignore" }).status === 0;

const steps = [
  { name: "Dependencies match the lockfile", command: "npm ci --dry-run", required: true },
  { name: "Lint", command: "npm run lint", required: true },
  { name: "Types", command: "npm run typecheck", required: true },
  { name: "Rego policies", command: "npm run test:opa", required: true, skipIf: !opaAvailable && "the opa binary is not installed (set KONTROL_OPA_BIN)" },
  { name: "Tests on SQLite", command: "npm test", required: true, tests: true },
  { name: "Tests on PostgreSQL (row-level security)", command: "npm run test:postgres", required: true, tests: true },
  { name: "Production build", command: "npm run build", required: true },
  { name: "End-to-end (Playwright)", command: "npm run test:e2e", required: false, skipIf: !process.argv.includes("--e2e") && "pass --e2e to include it (needs a browser and a free port)" },
];

const count = (output, label) => Number(new RegExp(`^ℹ ${label} (\\d+)`, "m").exec(output)?.[1] ?? 0);
const results = [];

for (const step of steps) {
  if (step.skipIf) { results.push({ ...step, status: "NOT RUN", detail: step.skipIf }); continue; }
  const run = spawnSync(step.command, { shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const result = { ...step, status: run.status === 0 ? "PASSED" : "FAILED", detail: "" };
  if (step.tests) {
    const passed = count(output, "pass"), failed = count(output, "fail"), skipped = count(output, "skipped");
    const reasons = [...output.matchAll(/^﹣ (.+?) # (.+)$/gm)].map((match) => match[2]);
    const unique = [...new Set(reasons)];
    result.detail = `${passed} passed, ${failed} failed, ${skipped} skipped${unique.length ? ` (${unique.slice(0, 3).join("; ")}${unique.length > 3 ? "; ..." : ""})` : ""}`;
    // A test run that executed nothing is not a pass.
    if (run.status === 0 && passed === 0) { result.status = "FAILED"; result.detail += " - no test ran"; }
  } else if (run.status !== 0) result.detail = output.trim().split("\n").slice(-4).join(" | ").slice(0, 300);
  results.push(result);
}

const width = Math.max(...results.map((item) => item.name.length));
console.log("\nVerification\n");
for (const item of results) console.log(`${item.status.padEnd(8)} ${item.name.padEnd(width)}  ${item.detail}`);
const failed = results.filter((item) => item.status === "FAILED");
const notRun = results.filter((item) => item.status === "NOT RUN" && item.required);
console.log(`\n${results.filter((item) => item.status === "PASSED").length} passed, ${failed.length} failed, ${results.filter((item) => item.status === "NOT RUN").length} not run`);
if (notRun.length) console.log(`Not run but required: ${notRun.map((item) => item.name).join(", ")}${strict ? "" : " (use --strict to fail on this)"}`);
if (!existsSync("package-lock.json")) console.log("package-lock.json is missing");
process.exit(failed.length || (strict && notRun.length) ? 1 : 0);
