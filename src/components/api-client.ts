export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function describeStatus(status: number) {
  if (status === 401) return "Session expired or not signed in (401)";
  if (status === 403) return "Access denied for this role (403)";
  if (status >= 500) return `Erreur serveur (${status})`;
  return `Request refused (${status})`;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
  if (!response.ok) {
    const apiMessage = body && typeof body.error === "string" ? body.error : null;
    throw new ApiError(apiMessage ?? describeStatus(response.status), response.status);
  }
  if (body === null) throw new ApiError("Invalid response from the server", response.status);
  return body;
}

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
