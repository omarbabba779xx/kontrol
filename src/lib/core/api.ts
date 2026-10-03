import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { AuthError } from "@/lib/core/auth";
import { UserError } from "@/lib/core/errors";

export function apiError(error: unknown) {
  if (error instanceof AuthError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof UserError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return Response.json({ error: "Invalid request", issues: error.issues }, { status: 400 });
  // Anything else is a server fault. Its message can carry SQL, paths or library internals, so the caller gets a reference to quote and the
  // detail stays in the log. A failure the caller can act on is raised as a UserError, which carries its own status and message.
  const reference = randomUUID();
  console.error(
    JSON.stringify({
      level: "error",
      event: "request.failed",
      reference,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  return Response.json({ error: "Internal server error", reference }, { status: 500 });
}
