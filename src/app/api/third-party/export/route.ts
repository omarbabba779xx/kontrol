import { requireActor } from "@/lib/core/auth";
import { apiError } from "@/lib/core/api";
import { exportRegister } from "@/lib/core/third-party";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "oscal:export");
    const format = new URL(request.url).searchParams.get("format") === "csv" ? "csv" : "json";
    const file = await exportRegister(actor, format);
    return new Response(file.body, {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
