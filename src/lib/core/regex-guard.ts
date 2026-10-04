import { runInNewContext } from "node:vm";

export const MAX_PATTERN = 120;
export const MAX_SUBJECT = 2_000;
const MAX_UNBOUNDED_QUANTIFIERS = 2;
const MAX_QUANTIFIERS = 5;

/**
 * Counts the quantifiers of a pattern, ignoring escaped characters and the inside of character classes. Matching time grows with the
 * subject length raised to the number of unbounded quantifiers (`a*a*a*b` is cubic even with nothing nested), so the number is capped.
 */
export function quantifiers(pattern: string) {
  let unbounded = 0,
    total = 0,
    inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "*" || char === "+") {
      unbounded += 1;
      total += 1;
    } else if (char === "?" && !"(*+?}".includes(pattern[index - 1] ?? "")) total += 1;
    else if (char === "{") {
      const bound = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
      if (bound) {
        total += 1;
        if (bound[2] !== undefined && bound[3] === "") unbounded += 1;
        index += bound[0].length - 1;
      }
    }
  }
  return { unbounded, total };
}

/** Rejects patterns that can backtrack badly: long ones, back-references, quantified groups, stacked quantifiers, or too many quantifiers. */
export function safeRegex(pattern: unknown): RegExp | null {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN) return null;
  // Escapes and character classes are blanked first, so a quantifier character that is only data does not look like structure.
  const structure = pattern.replace(/\\./g, "_").replace(/\[(?:[^\]\\]|\\.)*\]/g, "_");
  if (/\\[1-9]/.test(pattern) || /\)\s*[*+?{]/.test(structure) || /[*+?}]\s*[*+{]/.test(structure)) return null;
  const { unbounded, total } = quantifiers(pattern);
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS || total > MAX_QUANTIFIERS) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

const MATCH_BUDGET_MS = 25;

/**
 * Runs a match under a time budget. The structural checks above keep ordinary patterns fast; this is the bound that does not depend
 * on having thought of every shape of pattern: whatever the expression, a match that runs past the budget is stopped and counts as
 * no match (a control that cannot be evaluated in time fails closed). The pattern runs in its own context so the interruption
 * cannot leave shared state half-updated.
 */
export function matchWithin(pattern: RegExp, subject: string, budgetMs = MATCH_BUDGET_MS): boolean {
  if (subject.length > MAX_SUBJECT) return false;
  try {
    return runInNewContext("pattern.test(subject)", { pattern: new RegExp(pattern.source, pattern.flags), subject }, { timeout: budgetMs }) === true;
  } catch {
    return false;
  }
}
