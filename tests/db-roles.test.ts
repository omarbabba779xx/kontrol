import assert from "node:assert/strict";
import { test } from "node:test";

const fake = (role: { rolsuper: boolean; rolbypassrls: boolean } | null, owned: number) => ({
  unsafe: async (query: string) => (/pg_roles/.test(query) ? (role ? [{ rolname: "kontrol_login", ...role }] : []) : [{ n: owned }]),
}) as never;

test("the runtime database role must not be able to bypass tenant isolation", async () => {
  const { assertUnprivilegedRuntime } = await import("../src/lib/db/postgres");
  await assertUnprivilegedRuntime(fake({ rolsuper: false, rolbypassrls: false }, 0));
  await assert.rejects(assertUnprivilegedRuntime(fake({ rolsuper: true, rolbypassrls: false }, 0)), /is a superuser/);
  await assert.rejects(assertUnprivilegedRuntime(fake({ rolsuper: false, rolbypassrls: true }, 0)), /has BYPASSRLS/);
  await assert.rejects(assertUnprivilegedRuntime(fake({ rolsuper: false, rolbypassrls: false }, 12)), /owns 12 tables/);
  await assert.rejects(assertUnprivilegedRuntime(fake({ rolsuper: true, rolbypassrls: true }, 3)), (error: Error) => /superuser/.test(error.message) && /BYPASSRLS/.test(error.message) && /owns 3/.test(error.message));
  await assert.rejects(assertUnprivilegedRuntime(fake(null, 0)), /Cannot read the database role/);
});

test("a real PostgreSQL role check agrees: the in-process test server connects as a privileged role, and a restricted role passes", { skip: process.env.KONTROL_TEST_DB !== "postgres" && "run with KONTROL_TEST_DB=postgres" }, async () => {
  const { startPglite } = await import("./setup");
  const server = await startPglite();
  const postgres = (await import("postgres")).default;
  const sql = postgres(server.url, { max: 1, onnotice: () => undefined });
  try {
    const { assertUnprivilegedRuntime } = await import("../src/lib/db/postgres");
    await assert.rejects(assertUnprivilegedRuntime(sql), /superuser|owns/);
    await sql.unsafe("CREATE ROLE kontrol_probe NOSUPERUSER NOBYPASSRLS");
    await sql.begin(async (handle) => {
      await handle.unsafe("SET LOCAL ROLE kontrol_probe");
      await assertUnprivilegedRuntime(handle);
    });
  } finally { await sql.end({ timeout: 2 }); await server.stop(); }
});
