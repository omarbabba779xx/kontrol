import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { githubSyncSchema } from "@/lib/core/schemas";
import { syncAws, syncGitHub, syncOkta } from "@/lib/connectors";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ connector: string }> }) {
  try {
    const actor = await requireActor(request, "connectors:sync");
    const { connector } = await params;
    if (connector === "github") return Response.json(await syncGitHub(actor, githubSyncSchema.parse(await request.json())));
    if (connector === "aws") return Response.json(await syncAws(actor));
    if (connector === "okta") return Response.json(await syncOkta(actor));
    return Response.json({ error: "Unsupported connector" }, { status: 404 });
  } catch (error) { return apiError(error); }
}
