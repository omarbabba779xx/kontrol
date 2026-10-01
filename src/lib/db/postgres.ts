import "server-only";

import postgres, { type Sql } from "postgres";
import { applyPostgres } from "@/lib/db/migrations/apply";
import { APP_ROLE } from "@/lib/db/schema";
import type { Db, Scope, Tx } from "@/lib/db/types";

/** Converts `?` placeholders to `$n`, leaving quoted string literals untouched. */
export function toPositional(sql: string) {
  let index = 0;
  let quote = false;
  let out = "";
  for (const char of sql) {
    if (char === "'") quote = !quote;
    out += char === "?" && !quote ? `$${++index}` : char;
  }
  return out;
}

type Handle = Pick<Sql, "unsafe">;

function executor(handle: Handle): Tx {
  const exec = async (sql: string, params: unknown[]) => handle.unsafe(toPositional(sql), params as never[]);
  return {
    dialect: "postgres",
    async get(sql, ...params) { return (await exec(sql, params))[0] as never; },
    async all(sql, ...params) { return [...(await exec(sql, params))] as never; },
    async run(sql, ...params) { return { changes: (await exec(sql, params)).count }; },
  };
}

export async function createPostgresDb(url: string, options: { max?: number } = {}): Promise<Db> {
  const sql = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: 10,
    onnotice: () => undefined,
    types: { bigint: { to: 20, from: [20], parse: Number, serialize: (value: unknown) => String(value) } },
  });

  // Migrations run as the connecting (owner) role; the runtime then drops to the non-bypass application role.
  await applyPostgres(sql, { check: process.env.KONTROL_AUTO_MIGRATE === "false" });

  async function inTenant<T>(tenantId: string | null, fn: (tx: Tx) => Promise<T>) {
    return sql.begin(async (handle) => {
      await handle.unsafe(`SET LOCAL ROLE ${APP_ROLE}`);
      await handle.unsafe("SELECT set_config('app.tenant_id', $1, true), set_config('app.system', $2, true)", [tenantId ?? "", tenantId === null ? "on" : "off"]);
      return fn(executor(handle));
    }) as Promise<T>;
  }

  const scopeFor = (tenantId: string | null): Scope => ({
    dialect: "postgres",
    get: (query, ...params) => inTenant(tenantId, (tx) => tx.get(query, ...params)),
    all: (query, ...params) => inTenant(tenantId, (tx) => tx.all(query, ...params)),
    run: (query, ...params) => inTenant(tenantId, (tx) => tx.run(query, ...params)),
    transaction: (fn) => inTenant(tenantId, fn),
  });

  return { dialect: "postgres", scope: (tenantId) => scopeFor(tenantId), system: () => scopeFor(null), close: () => sql.end({ timeout: 5 }) };
}
