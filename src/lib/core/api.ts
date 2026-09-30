import { ZodError } from "zod";
import { AuthError } from "@/lib/core/auth";

export function apiError(error: unknown) {
  if (error instanceof AuthError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return Response.json({ error: "Invalid request", issues: error.issues }, { status: 400 });
  const message = error instanceof Error ? error.message : "Internal server error";
  console.error(error);
  return Response.json({ error: message }, { status: message.toLowerCase().includes("not found") ? 404 : 500 });
}
