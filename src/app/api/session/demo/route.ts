import { demoAuthAllowed } from "@/lib/core/config";
import { z } from "zod";
import { authenticate, demoActorFor, issueSessionToken } from "@/lib/core/auth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!demoAuthAllowed()) return Response.json({ error: "Demo sessions disabled" }, { status: 403 });
  // With a userId, the session is for that person of the demonstration organisation; without one, for its administrator.
  const body = z.object({ userId: z.string().min(3).max(80).optional() }).safeParse(await request.json().catch(() => ({})));
  if (!body.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const actor = body.data.userId ? await demoActorFor(body.data.userId) : await authenticate(request);
  if (!actor) return Response.json({ error: body.data.userId ? "No active person with that id in the demonstration organisation" : "Demo actor unavailable" }, { status: body.data.userId ? 404 : 500 });
  const token = await issueSessionToken(actor);
  return Response.json(
    { actor, token },
    {
      headers: {
        "Set-Cookie": `kontrol_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}`,
      },
    },
  );
}
