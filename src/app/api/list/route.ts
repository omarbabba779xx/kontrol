import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { COLLECTIONS, page } from "@/lib/core/paging";

export const runtime = "nodejs";

/**
 * GET /api/list?collection=risks&limit=50&offset=100&status=identified
 * A page of any long list with its total. Every other query parameter is a filter and must be one the collection allows.
 */
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const name = params.get("collection") ?? "";
    const collection = (COLLECTIONS as Record<string, { permission: "graph:read" | "evidence:read" }>)[name];
    if (!collection) return Response.json({ error: `Unknown collection. Use one of: ${Object.keys(COLLECTIONS).join(", ")}` }, { status: 400 });
    const actor = await requireActor(request, collection.permission);
    const number = (key: string) => (params.has(key) ? Number(params.get(key)) : undefined);
    const limit = number("limit"), offset = number("offset");
    if ((limit !== undefined && !Number.isFinite(limit)) || (offset !== undefined && !Number.isFinite(offset))) return Response.json({ error: "limit and offset are numbers" }, { status: 400 });
    const filters = Object.fromEntries([...params.entries()].filter(([key]) => !["collection", "limit", "offset"].includes(key)));
    return Response.json(await page(actor.tenantId, name, { limit, offset, filters }));
  } catch (error) {
    return apiError(error);
  }
}
