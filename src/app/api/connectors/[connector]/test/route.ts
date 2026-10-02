import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { testConnection } from "@/lib/connectors";
import { CREDENTIAL_KINDS, type CredentialKind } from "@/lib/core/credentials";

export const runtime = "nodejs";

/** Proves the stored (or environment) credentials work with a cheap read-only call. The answer never contains a secret. */
export async function POST(request: Request, { params }: { params: Promise<{ connector: string }> }) {
  try {
    const actor = await requireActor(request, "connectors:sync");
    const { connector } = await params;
    if (!(CREDENTIAL_KINDS as string[]).includes(connector)) return Response.json({ error: "Unsupported connector" }, { status: 404 });
    return Response.json(await testConnection(actor, connector as CredentialKind));
  } catch (error) { return apiError(error); }
}
