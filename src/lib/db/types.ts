export type Dialect = "sqlite" | "postgres";
export type Row = Record<string, unknown>;

/** Statement executor. SQL uses `?` placeholders for both dialects. */
export interface Executor {
  readonly dialect: Dialect;
  get<T = Row>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Row>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
}

/** Executor bound to a single transaction. */
export type Tx = Executor;

/** Executor bound to one tenant (row-level security scope) that can also open transactions. */
export interface Scope extends Executor {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface Db {
  readonly dialect: Dialect;
  /** Every statement runs with `app.tenant_id` set; PostgreSQL row-level security enforces the boundary. */
  scope(tenantId: string): Scope;
  /** Bypasses tenant isolation. Reserved for bootstrap, authentication lookups, health checks and migration. */
  system(): Scope;
  close(): Promise<void>;
}
