import { DDL, TABLES } from "@/lib/db/ddl.generated";
import type { Dialect } from "@/lib/db/types";

export { TABLES };
export const APP_ROLE = "kontrol_app";

const tokens: Record<Dialect, Record<string, string>> = {
  sqlite: { REAL: "REAL", BIGINT: "INTEGER", SEQUENCE: "INTEGER PRIMARY KEY AUTOINCREMENT" },
  postgres: { REAL: "DOUBLE PRECISION", BIGINT: "BIGINT", SEQUENCE: "BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY" },
};

function resolve(statement: string, dialect: Dialect) {
  return statement.replace(/\{\{(\w+)\}\}/g, (_, key: string) => tokens[dialect][key]);
}

/** Ledger integrity: a tenant chain cannot fork, and audit rows are append-only. */
const sqliteIntegrity = [
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_chain ON audit_log(tenant_id, previous_hash) WHERE previous_hash IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_genesis ON audit_log(tenant_id) WHERE previous_hash IS NULL",
  "CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
  "CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END",
];

const postgresIntegrity = [
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_chain ON audit_log(tenant_id, previous_hash) WHERE previous_hash IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_genesis ON audit_log(tenant_id) WHERE previous_hash IS NULL",
  "CREATE OR REPLACE FUNCTION kontrol_audit_immutable() RETURNS trigger AS $fn$ BEGIN RAISE EXCEPTION 'audit_log is append-only'; END; $fn$ LANGUAGE plpgsql",
  "DROP TRIGGER IF EXISTS audit_immutable ON audit_log",
  "CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION kontrol_audit_immutable()",
];

/** Tenant isolation. Every tenant table is forced under row-level security keyed on `app.tenant_id`. */
function postgresRls() {
  const statements = [
    `DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN CREATE ROLE ${APP_ROLE} NOLOGIN NOBYPASSRLS; END IF; END $do$`,
    `DO $do$ BEGIN EXECUTE format('GRANT %I TO %I', '${APP_ROLE}', current_user); END $do$`,
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
  ];
  for (const table of TABLES) {
    const column = table === "tenants" ? "id" : "tenant_id";
    const predicate = `${column} = current_setting('app.tenant_id', true) OR current_setting('app.system', true) = 'on'`;
    statements.push(
      `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS tenant_isolation ON ${table}`,
      `CREATE POLICY tenant_isolation ON ${table} USING (${predicate}) WITH CHECK (${predicate})`,
      table === "audit_log" ? `GRANT SELECT, INSERT ON ${table} TO ${APP_ROLE}` : `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${APP_ROLE}`,
    );
  }
  statements.push(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${APP_ROLE}`);
  statements.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  return statements;
}

export function renderSchema(dialect: Dialect) {
  const base = DDL.map((statement) => resolve(statement, dialect));
  return dialect === "sqlite" ? [...base, ...sqliteIntegrity] : [...base, ...postgresIntegrity, ...postgresRls()];
}
