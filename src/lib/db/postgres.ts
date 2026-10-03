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

/**
 * In production the runtime connection must not be able to step around row-level security: not a superuser, not BYPASSRLS, and not the
 * owner of the tables (an owner can disable policies, and forced RLS is the only thing that stops it reading across tenants).
 * Run migrations with POSTGRES_MIGRATION_URL (an owner role) and the application with POSTGRES_URL (an unprivileged login role).
 */
export async function assertUnprivilegedRuntime(sql: Pick<Sql, "unsafe">) {
  const role = (await sql.unsafe("SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"))[0] as unknown as { rolname: string; rolsuper: boolean; rolbypassrls: boolean } | undefined;
  if (!role) throw new Error("Cannot read the database role the application connects as");
  const owned = Number((await sql.unsafe("SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user"))[0]?.n ?? 0);
  const problems = [role.rolsuper && "is a superuser", role.rolbypassrls && "has BYPASSRLS", owned > 0 && `owns ${owned} tables`].filter(Boolean);
  if (problems.length) throw new Error(`The application database role "${role.rolname}" ${problems.join(", ")}: that can bypass tenant isolation. Use POSTGRES_MIGRATION_URL for migrations and an unprivileged role in POSTGRES_URL (see infra/postgres/roles.sql), or set KONTROL_ALLOW_PRIVILEGED_DB=true to accept the risk explicitly.`);
}

export async function createPostgresDb(url: string, options: { max?: number; migrationUrl?: string; production?: boolean } = {}): Promise<Db> {
  const sql = postgres(url, {
    max: options.max ?? 10,
    connect_timeout: 10,
    onnotice: () => undefined,
    types: { bigint: { to: 20, from: [20], parse: Number, serialize: (value: unknown) => String(value) } },
  });

  // Migrations run as an owner role: the separate migration connection when one is configured, otherwise the connecting role.
  // The runtime then drops to the non-bypass application role for every transaction.
  const check = process.env.KONTROL_AUTO_MIGRATE === "false";
  if (options.migrationUrl) {
    const migrator = postgres(options.migrationUrl, { max: 1, connect_timeout: 10, onnotice: () => undefined });
    try {
      await applyPostgres(migrator, { check });
      // The unprivileged login the application uses must be allowed to become the application role.
      const login = process.env.KONTROL_RUNTIME_LOGIN;
      if (login && !check) {
        if (!/^[a-z_][a-z0-9_]{0,62}$/.test(login)) throw new Error("KONTROL_RUNTIME_LOGIN must be a plain lower-case role name");
        await migrator.unsafe(`GRANT ${APP_ROLE} TO ${login}`);
      }
    } finally { await migrator.end({ timeout: 5 }); }
  } else await applyPostgres(sql, { check });
  if (options.production && process.env.KONTROL_ALLOW_PRIVILEGED_DB !== "true") await assertUnprivilegedRuntime(sql);

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
