import "server-only";

import type { Policy } from "@/lib/core/policy-engine";

export type OpaVerdict =
  | { status: "disabled" }
  | { status: "unavailable"; detail: string }
  | { status: "agree"; opaPassed: boolean }
  | { status: "disagree"; opaPassed: boolean };

const TIMEOUT_MS = 2500;

/** Operator-configured OPA endpoint; only plain http(s) URLs are honoured. */
function endpoint() {
  const raw = process.env.OPA_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Asks Open Policy Agent to evaluate the same policy on the same facts (infra/opa/policy.rego) and compares verdicts.
 * The TypeScript engine stays authoritative; a disagreement is a signal that one of the two engines is wrong.
 * An unreachable OPA never blocks an evaluation.
 */
export async function crossCheckWithOpa(
  policy: Policy,
  facts: Record<string, unknown>,
  now: number,
  localPassed: boolean,
): Promise<OpaVerdict> {
  const base = endpoint();
  if (!base) return { status: "disabled" };
  try {
    const response = await fetch(`${base}/v1/data/kontrol/policy/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: { policy, facts, now } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return { status: "unavailable", detail: `HTTP ${response.status}` };
    const body = (await response.json()) as { result?: { passed?: unknown } };
    if (typeof body.result?.passed !== "boolean") return { status: "unavailable", detail: "Policy package kontrol.policy is not loaded" };
    return body.result.passed === localPassed
      ? { status: "agree", opaPassed: body.result.passed }
      : { status: "disagree", opaPassed: body.result.passed };
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : "request failed" };
  }
}
