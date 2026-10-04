import assert from "node:assert/strict";
import { test } from "node:test";
import { collectGitHub, type JsonResponse } from "../src/lib/connectors/collectors";
import { PACK, missingFacts } from "../src/lib/connectors/pack";

const BASE = "/repos/jane/repo";
const api = (routes: Record<string, JsonResponse>) => async (path: string): Promise<JsonResponse> => routes[path] ?? { status: 404, body: { message: "Not Found" } };
const personalPrivate = { status: 200, body: { full_name: "jane/repo", default_branch: "main", visibility: "private", archived: false, owner: { type: "User" }, security_and_analysis: null } };
const notProtected = { status: 404, body: { message: "Branch not protected" } };
const dependabot = PACK.find((control) => control.code === "CTL-GH-003")!;

// What a private repository of a personal account really answers: `security_and_analysis` is null, yet the Dependabot setting is
// readable through its own endpoint. Observed against the live API.
test("Dependabot security updates are read from their own endpoint when the repository summary does not carry them", async () => {
  const enabled = await collectGitHub(api({ [BASE]: personalPrivate, [`${BASE}/branches/main/protection`]: notProtected, [`${BASE}/rules/branches/main`]: { status: 200, body: [] }, [`${BASE}/vulnerability-alerts`]: { status: 204, body: null }, [`${BASE}/automated-security-fixes`]: { status: 200, body: { enabled: true, paused: false } } }), "jane", "repo");
  assert.equal((enabled.security as { dependabotSecurityUpdates: string }).dependabotSecurityUpdates, "enabled");
  assert.deepEqual(missingFacts(dependabot, enabled), [], "the control can now be evaluated instead of being skipped");

  const off = await collectGitHub(api({ [BASE]: personalPrivate, [`${BASE}/branches/main/protection`]: notProtected, [`${BASE}/vulnerability-alerts`]: { status: 404, body: { message: "Vulnerability alerts are disabled." } }, [`${BASE}/automated-security-fixes`]: { status: 200, body: { enabled: false, paused: false } } }), "jane", "repo");
  assert.equal((off.security as { dependabotSecurityUpdates: string }).dependabotSecurityUpdates, "disabled");
  assert.equal(off.vulnerabilityAlertsEnabled, false);

  const paused = await collectGitHub(api({ [BASE]: personalPrivate, [`${BASE}/branches/main/protection`]: notProtected, [`${BASE}/vulnerability-alerts`]: { status: 204, body: null }, [`${BASE}/automated-security-fixes`]: { status: 200, body: { enabled: true, paused: true } } }), "jane", "repo");
  assert.equal((paused.security as { dependabotSecurityUpdates: string }).dependabotSecurityUpdates, "disabled", "paused updates are not fixing anything");
});

test("when neither source can be read the setting stays unknown, and the summary wins when it is present", async () => {
  const forbidden = await collectGitHub(api({ [BASE]: personalPrivate, [`${BASE}/branches/main/protection`]: notProtected, [`${BASE}/vulnerability-alerts`]: { status: 403, body: { message: "Resource not accessible" } }, [`${BASE}/automated-security-fixes`]: { status: 403, body: { message: "Resource not accessible" } } }), "jane", "repo");
  assert.equal((forbidden.security as { dependabotSecurityUpdates: string | null }).dependabotSecurityUpdates, null, "no permission is unknown, never disabled");
  assert.ok(missingFacts(dependabot, forbidden).length > 0);

  let asked = false;
  const summary = { status: 200, body: { ...(personalPrivate.body as object), security_and_analysis: { dependabot_security_updates: { status: "enabled" } } } };
  const routes = api({ [BASE]: summary, [`${BASE}/branches/main/protection`]: notProtected, [`${BASE}/vulnerability-alerts`]: { status: 204, body: null } });
  const facts = await collectGitHub(async (path) => { if (path.endsWith("/automated-security-fixes")) asked = true; return routes(path); }, "jane", "repo");
  assert.equal((facts.security as { dependabotSecurityUpdates: string }).dependabotSecurityUpdates, "enabled");
  assert.equal(asked, false, "no extra call when the summary already answers");
});

test("an exhausted GitHub quota stops the collection with the reset time instead of recording unknowns", async () => {
  const realFetch = globalThis.fetch;
  const reset = Math.floor(Date.UTC(2026, 9, 4, 12, 0, 0) / 1000);
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })) as typeof fetch;
  try {
    const { githubApiFor } = await import("../src/lib/connectors");
    await assert.rejects(githubApiFor("token")("/repos/jane/repo"), /rate limit reached; it resets at 2026-10-04T12:00:00.000Z/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403, headers: { "x-ratelimit-remaining": "4999" } })) as typeof fetch;
    assert.equal((await githubApiFor("token")("/repos/jane/repo")).status, 403, "an ordinary refusal is passed on to the collector");
  } finally { globalThis.fetch = realFetch; }
});
