import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".corp"];

export function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return isPrivateAddress(value.slice(7));
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
}

/** Synchronous structural check: HTTPS only, no credentials, no internal or literal private hosts. */
export function assertPublicHttpsUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
  if (url.username || url.password) throw new Error("URLs must not embed credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) throw new Error("Internal hosts are not allowed");
  if (isIP(host) && isPrivateAddress(host)) throw new Error("Private network addresses are not allowed");
  return url;
}

/** Resolves the hostname and refuses targets that point into private address space (SSRF defence). */
export async function assertResolvesPublic(raw: string) {
  const url = assertPublicHttpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return url;
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error("Host resolves to a private network address");
  return url;
}
