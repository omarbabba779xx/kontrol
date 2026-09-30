import { demoAuthAllowed } from "@/lib/core/config";
import { authenticate, issueSessionToken } from "@/lib/core/auth";

export const runtime = "nodejs";
export async function POST(request: Request) {
  if (!demoAuthAllowed()) return Response.json({ error: "Demo sessions disabled" }, { status: 403 });
  const actor = await authenticate(request);
  if (!actor) return Response.json({ error: "Demo actor unavailable" }, { status: 500 });
  const token = await issueSessionToken(actor);
  return Response.json({ actor, token }, { headers: { "Set-Cookie": `kontrol_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${process.env.NODE_ENV === "production" ? "; Secure" : ""}` } });
}
