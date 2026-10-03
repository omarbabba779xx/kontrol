import { z } from "zod";
import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { POLLED_CONNECTORS, syncConnector, type PolledConnector } from "@/lib/connectors";

export const runtime = "nodejs";

const bodies = {
  github: z.object({ owner: z.string().min(1).max(100), repository: z.string().min(1).max(100), assetId: z.string().min(3).optional(), demo: z.boolean().default(false) }),
  gitlab: z.object({ project: z.string().min(1).max(300), assetId: z.string().min(3).optional(), demo: z.boolean().default(false) }),
};

/** Runs one connector now: collects facts, evaluates its controls and stores the evidence. */
export async function POST(request: Request, { params }: { params: Promise<{ connector: string }> }) {
  try {
    const actor = await requireActor(request, "connectors:sync");
    const { connector } = await params;
    if (!(POLLED_CONNECTORS as readonly string[]).includes(connector)) return Response.json({ error: "Unsupported connector" }, { status: 404 });
    const text = await request.text();
    const raw = text ? JSON.parse(text) : {};
    const input = connector === "github" ? bodies.github.parse(raw) : connector === "gitlab" ? bodies.gitlab.parse(raw) : {};
    return Response.json(await syncConnector(actor, connector as PolledConnector, input));
  } catch (error) { return apiError(error); }
}
