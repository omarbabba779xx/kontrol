import "server-only";

/**
 * Structured logging: one JSON object per line on stdout (errors on stderr), so a log shipper can parse it and an alert can match on
 * `event`. Fields that look like secrets are redacted by name and by value; messages are length-limited. This is not an audit trail
 * (the hash-chained audit log is): it is for operating the system.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_NAME = /(token|secret|password|authorization|api[-_]?key|cookie|signature|credential)/i;
const SECRET_VALUE = /(github_pat_\w+|gh[pousr]_\w{20,}|kontrol_[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*)/g;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]").slice(0, 500);
  if (value === null || typeof value !== "object") return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 40).map(([key, item]) => [key, SECRET_NAME.test(key) ? "[redacted]" : redact(item, depth + 1)]));
}

export function line(level: Level, event: string, fields: Record<string, unknown> = {}) {
  return JSON.stringify({ time: new Date().toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) });
}

const threshold = () => ORDER[(process.env.KONTROL_LOG_LEVEL as Level) in ORDER ? (process.env.KONTROL_LOG_LEVEL as Level) : "info"];

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => { if (ORDER.debug >= threshold()) console.log(line("debug", event, fields)); },
  info: (event: string, fields?: Record<string, unknown>) => { if (ORDER.info >= threshold()) console.log(line("info", event, fields)); },
  warn: (event: string, fields?: Record<string, unknown>) => { if (ORDER.warn >= threshold()) console.warn(line("warn", event, fields)); },
  error: (event: string, fields?: Record<string, unknown>) => { console.error(line("error", event, fields)); },
};
