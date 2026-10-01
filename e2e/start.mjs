// Starts the application on a throwaway database for the end-to-end suite.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";

const port = process.env.E2E_PORT ?? "3100";
rmSync(".data/e2e", { recursive: true, force: true });

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [next, "dev", "-p", port], {
  stdio: "inherit",
  env: { ...process.env, KONTROL_DATABASE_PATH: ".data/e2e/kontrol.db", KONTROL_AUTH_MODE: "demo", KONTROL_DB_DRIVER: "sqlite", KONTROL_SEED: "true", NEXT_TELEMETRY_DISABLED: "1", OPA_URL: "" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill());
child.on("exit", (code) => process.exit(code ?? 0));
