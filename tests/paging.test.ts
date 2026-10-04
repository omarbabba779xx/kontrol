import assert from "node:assert/strict";
import { test } from "node:test";
import { admin, isolateDatabase, riskOwner, setEnv } from "./setup";

isolateDatabase();
setEnv({ KONTROL_SECRETS_KEY: "k".repeat(40) });

test("a long list is read page by page with its total, and nothing is cut off silently", async () => {
  const { page, MAX_PAGE } = await import("../src/lib/core/paging");
  const { createRisk } = await import("../src/lib/core/risk-register");
  for (let index = 0; index < 23; index += 1) await createRisk(riskOwner, { title: `Risk number ${index + 1}`, category: index % 2 ? "cyber" : "privacy", likelihood: 2, impact: 2 });
  const first = await page(admin.tenantId, "risks", { limit: 10 });
  assert.deepEqual([first.items.length, first.total, first.offset, first.next], [10, 23, 0, 10]);
  const last = await page(admin.tenantId, "risks", { limit: 10, offset: 20 });
  assert.deepEqual([last.items.length, last.next], [3, null], "the last page says there is no next one");
  const all = [first, await page(admin.tenantId, "risks", { limit: 10, offset: 10 }), last].flatMap((part) => part.items.map((item) => item.ref));
  assert.equal(new Set(all).size, 23, "every row appears exactly once across the pages");
  assert.equal((await page(admin.tenantId, "risks", { filters: { category: "cyber" } })).total, 11);
  assert.equal((await page(admin.tenantId, "risks", { limit: 100_000 })).limit, MAX_PAGE, "a page has a ceiling");
  assert.equal((await page("tenant_other", "risks")).total, 0, "another organisation sees nothing");
});

test("only the listed collections and filters are accepted: nothing from the request reaches the SQL", async () => {
  const { page } = await import("../src/lib/core/paging");
  await assert.rejects(page(admin.tenantId, "users; DROP TABLE users"), /not found/);
  await assert.rejects(page(admin.tenantId, "risks", { filters: { "1=1 OR status": "x" } }), /cannot be filtered by/);
  assert.equal((await page(admin.tenantId, "risks", { filters: { status: "' OR '1'='1" } })).total, 0, "a filter value is a parameter, never text");
  assert.equal((await page(admin.tenantId, "evidence")).collection, "evidence");
  assert.ok(!Object.keys((await page(admin.tenantId, "evidence")).items[0] ?? {}).includes("content_json"), "evidence pages carry the metadata, not the content");
});

test("the list API pages, filters and applies the permission of the collection", async () => {
  const { GET } = await import("../src/app/api/list/route");
  const { issueSessionToken } = await import("../src/lib/core/auth");
  const call = async (query: string, role = "viewer") => GET(new Request(`http://localhost/api/list${query}`, { headers: { authorization: `Bearer ${await issueSessionToken({ ...admin, role } as typeof admin)}` } }));
  const body = (await (await call("?collection=risks&limit=5&offset=5&category=privacy")).json()) as { items: unknown[]; total: number; next: number | null };
  assert.deepEqual([body.items.length, body.total, body.next], [5, 12, 10]);
  assert.equal((await call("?collection=nope")).status, 400);
  assert.equal((await call("?collection=risks&limit=abc")).status, 400);
  assert.equal((await call("?collection=risks&colour=red")).status, 400);
  assert.equal((await call("?collection=evidence")).status, 200);
});
