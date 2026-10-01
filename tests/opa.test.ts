import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { testCondition, type Condition } from "../src/lib/core/policy-engine";
import { admin, isolateDatabase, setEnv } from "./setup";

isolateDatabase();

const passingFacts = { production: true, branchProtection: { enabled: true, requiredReviews: 2 } };
const failingFacts = { production: true, branchProtection: { enabled: false, requiredReviews: 0 } };

async function listen(handler: (body: { input: { policy: unknown; facts: unknown; now: number } }) => { status: number; body: unknown }) {
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const reply = handler(JSON.parse(raw || "{}"));
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const evaluate = async (facts: Record<string, unknown>) => {
  const { evaluateControl } = await import("../src/lib/core/policy-engine");
  return evaluateControl(admin, { controlCode: "CTL-SDLC-004", assetId: "asset_repo_lending", facts, source: "test" });
};

test("without OPA_URL the cross-check is disabled and evaluation is unaffected", async () => {
  setEnv({ OPA_URL: undefined });
  const result = await evaluate(passingFacts);
  assert.equal(result.opa.status, "disabled");
  assert.equal(result.passed, true);
});

test("an agreeing OPA is recorded in the evidence", async () => {
  const seen: unknown[] = [];
  const opa = await listen((request) => { seen.push(request.input); return { status: 200, body: { result: { passed: true } } }; });
  setEnv({ OPA_URL: opa.url });
  try {
    const result = await evaluate(passingFacts);
    assert.equal(result.opa.status, "agree");
    assert.equal(seen.length, 1);
    assert.deepEqual((seen[0] as { facts: unknown }).facts, passingFacts);
    const { getDb } = await import("../src/lib/db");
    const evidence = await (await getDb()).scope(admin.tenantId).get<{ content_json: string }>("SELECT content_json FROM evidence WHERE id = ?", result.evidenceId);
    assert.equal(JSON.parse(evidence!.content_json).opa.status, "agree");
  } finally { await opa.close(); }
});

test("a disagreeing OPA raises a drift event but the local verdict stays authoritative", async () => {
  const opa = await listen(() => ({ status: 200, body: { result: { passed: true } } }));
  setEnv({ OPA_URL: opa.url });
  try {
    const result = await evaluate(failingFacts);
    assert.equal(result.opa.status, "disagree");
    assert.equal(result.passed, false, "the TypeScript engine decides");
    const { getDb } = await import("../src/lib/db");
    const drift = await (await getDb()).scope(admin.tenantId).all<{ kind: string; severity: string; status: string }>("SELECT kind, severity, status FROM drift_events WHERE tenant_id = ? AND kind = 'policy_engine_divergence'", admin.tenantId);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].severity, "high");
    await evaluate(failingFacts);
    assert.equal((await (await getDb()).scope(admin.tenantId).all("SELECT id FROM drift_events WHERE tenant_id = ? AND kind = 'policy_engine_divergence'", admin.tenantId)).length, 1, "repeated divergence is deduplicated");
  } finally { await opa.close(); }
});

test("an unreachable, broken or unloaded OPA never blocks an evaluation", async () => {
  setEnv({ OPA_URL: "http://127.0.0.1:1" });
  assert.equal((await evaluate(passingFacts)).opa.status, "unavailable");

  const noPolicy = await listen(() => ({ status: 200, body: {} }));
  setEnv({ OPA_URL: noPolicy.url });
  try {
    const result = await evaluate(passingFacts);
    assert.equal(result.opa.status, "unavailable");
    assert.equal(result.passed, true);
  } finally { await noPolicy.close(); }

  const broken = await listen(() => ({ status: 500, body: { error: "boom" } }));
  setEnv({ OPA_URL: broken.url });
  try { assert.equal((await evaluate(passingFacts)).opa.status, "unavailable"); } finally { await broken.close(); }

  setEnv({ OPA_URL: "file:///etc/passwd" });
  assert.equal((await evaluate(passingFacts)).opa.status, "disabled", "non-http URLs are ignored");
  setEnv({ OPA_URL: undefined });
});

// ---- Parity against a real OPA server ------------------------------------------------------------------------------
// Runs when an OPA binary is available (KONTROL_OPA_BIN or `opa` on PATH); CI installs it.
function findOpa() {
  const candidate = process.env.KONTROL_OPA_BIN ?? "opa";
  const probe = spawnSync(candidate, ["version"], { encoding: "utf8" });
  return probe.status === 0 ? candidate : null;
}

const opaBinary = findOpa();
let opaProcess: ChildProcess | undefined;
after(() => { opaProcess?.kill(); });

test("the Rego evaluator and the TypeScript engine agree on every operator", { skip: opaBinary ? false : "OPA binary not available (set KONTROL_OPA_BIN)" }, async () => {
  const port = 18_000 + Math.floor(Math.random() * 1000);
  opaProcess = spawn(opaBinary!, ["run", "--server", "--addr", `127.0.0.1:${port}`, join(process.cwd(), "infra", "opa", "policy.rego")], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const now = Date.parse("2026-01-15T00:00:00Z");
  const facts = { n: 5, zero: 0, neg: -3, f: 2.5, s: "hello-world", empty: "", yes: true, no: false, nil: null, list: ["x", "y"], none: [], when: "2026-01-10T00:00:00Z", epoch: now - 3 * 86_400_000, future: "2026-02-01T00:00:00Z", nested: { deep: { value: 42 } } };
  const paths = ["n", "zero", "neg", "f", "s", "empty", "yes", "no", "list", "none", "when", "epoch", "future", "nested.deep.value", "nested", "missing", "nested.missing"];
  const values: unknown[] = [0, 1, 5, 2.5, -3, 42, "hello-world", "world", "^hello", "x", "(a+)+$", "(hello)\\1", "^\\d+$", "(", true, false, ["x", "y"], [1, 5], [5, 5], [6, 9], [1], 2, 7, 365, 3, 4, "str"];
  const ops = ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in", "not_in", "includes", "exists", "not_exists", "length_gte", "length_lte", "matches", "within_days", "older_than_days"] as const;

  const disagreements: string[] = [];
  let compared = 0;
  for (const op of ops) {
    for (const path of paths) {
      const candidates = op === "exists" || op === "not_exists" ? [undefined, true, false] : values;
      for (const value of candidates) {
        const condition: Condition = value === undefined ? { path, op } : { path, op, value };
        const local = testCondition(facts, condition, now);
        const response = await fetch(`${base}/v1/data/kontrol/policy/result`, { method: "POST", body: JSON.stringify({ input: { policy: { all: [condition] }, facts, now } }) });
        const remote = ((await response.json()) as { result?: { passed?: boolean } }).result?.passed;
        compared += 1;
        if (local !== remote) disagreements.push(`${JSON.stringify(condition)} local=${local} opa=${remote}`);
      }
    }
  }
  assert.ok(compared > 5000, `compared ${compared} cases`);
  assert.deepEqual(disagreements.slice(0, 20), [], `${disagreements.length} disagreements`);
});
