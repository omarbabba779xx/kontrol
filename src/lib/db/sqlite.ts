import "server-only";

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { renderSchema } from "@/lib/db/schema";
import type { Db, Scope, Tx } from "@/lib/db/types";

function executor(db: Database.Database): Tx {
  return {
    dialect: "sqlite",
    async get(sql, ...params) { return db.prepare(sql).get(...params) as never; },
    async all(sql, ...params) { return db.prepare(sql).all(...params) as never; },
    async run(sql, ...params) { return { changes: db.prepare(sql).run(...params).changes }; },
  };
}

export function createSqliteDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  for (const statement of renderSchema("sqlite")) db.exec(statement);

  const base = executor(db);
  // better-sqlite3 is a single synchronous connection. Transactions are explicit BEGIN/COMMIT blocks and
  // are serialised through a promise chain; plain statements wait for any open transaction to finish.
  let queue: Promise<unknown> = Promise.resolve();

  const scope: Scope = {
    dialect: "sqlite",
    get: async (sql, ...params) => { await queue; return base.get(sql, ...params); },
    all: async (sql, ...params) => { await queue; return base.all(sql, ...params); },
    run: async (sql, ...params) => { await queue; return base.run(sql, ...params); },
    transaction<T>(fn: (tx: Tx) => Promise<T>) {
      const run = async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(base);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
  return { dialect: "sqlite", scope: () => scope, system: () => scope, close: async () => { await queue; db.close(); } };
}
