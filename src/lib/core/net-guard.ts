import "server-only";

import { lookup } from "node:dns/promises";
import { lookup as lookupCallback } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".corp", ".home.arpa"];

function ipv4Private(a: number, b: number, c: number) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224
  ); // multicast, reserved, broadcast
}

/** Expands an IPv6 address (any textual form, including a trailing dotted IPv4) to its 16 bytes, or null when it is not valid. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[2].split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    text = `${dotted[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 255];
  });
}

export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return ipv4Private(a, b, c);
  }
  if (kind !== 6) return true; // anything that is not a valid address is refused
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const word = (index: number) => (bytes[index * 2] << 8) | bytes[index * 2 + 1];
  const embedded = (offset: number) => ipv4Private(bytes[offset], bytes[offset + 1], bytes[offset + 2]);
  const zeros = (count: number) => bytes.slice(0, count).every((byte) => byte === 0);
  if (zeros(16)) return true; // ::
  if (zeros(15) && bytes[15] === 1) return true; // ::1
  if (zeros(10) && word(5) === 0xffff) return embedded(12); // IPv4-mapped, in any spelling
  if (zeros(12)) return true; // deprecated IPv4-compatible
  if (word(0) === 0x64 && word(1) === 0xff9b) return word(2) === 0 && word(3) === 0 && word(4) === 0 && word(5) === 0 ? embedded(12) : true; // NAT64: judged by the IPv4 inside; local-use prefix refused
  if (word(0) === 0x2002) return embedded(2); // 6to4: judged by the IPv4 inside
  if (word(0) === 0x2001 && word(1) === 0) return true; // Teredo
  if (word(0) === 0x2001 && word(1) === 0xdb8) return true; // documentation
  if (word(0) === 0x100 && word(1) === 0 && word(2) === 0 && word(3) === 0) return true; // discard-only
  const first = bytes[0];
  return (
    (first & 0xfe) === 0xfc || // unique local fc00::/7
    (first === 0xfe && (bytes[1] & 0xc0) >= 0x80) || // link local fe80::/10 and site local fec0::/10
    first === 0xff
  ); // multicast
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

/**
 * Resolves the hostname and refuses targets that point into private address space. This is an early, readable refusal only: the
 * answer can change between this lookup and the connection (DNS rebinding). Outbound requests must go through `safeFetch`, which
 * checks the address it actually connects to.
 */
export async function assertResolvesPublic(raw: string) {
  const url = assertPublicHttpsUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return url;
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address)))
    throw new Error("Host resolves to a private network address");
  return url;
}

/** DNS lookup for the socket itself: the address that is checked is the address that is used, so there is no second resolution to poison. */
export function publicOnlyLookup(
  hostname: string,
  options: unknown,
  callback: (error: Error | null, address?: unknown, family?: number) => void,
) {
  const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
  lookupCallback(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address)))
      return callback(new Error("Host resolves to a private network address"));
    if (wantsAll) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

type Transport = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;
let transport: Transport | null = null;
/** Test seam: replaces the network under `safeFetch` (the URL checks still run). Never called by application code. */
export function setOutboundTransport(next: Transport | null) {
  transport = next;
}

/**
 * `fetch` for URLs that come from tenants or from remote documents (webhooks, connector base URLs, regulatory feeds, the identity
 * provider). HTTPS only; the connection is made to an address checked at connect time; redirects are not followed (a redirect is an
 * error, so a public host cannot bounce the request to an internal one); the response body is capped.
 */
export async function safeFetch(
  input: string | URL,
  init: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams; signal?: AbortSignal } = {},
): Promise<Response> {
  const url = assertPublicHttpsUrl(String(input));
  const body = init.body === undefined ? undefined : String(init.body);
  if (transport) return transport(url.toString(), { method: init.method, headers: init.headers, body, signal: init.signal });
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "content-length"))
      headers["Content-Length"] = String(Buffer.byteLength(body));
    const outgoing = httpsRequest(
      url,
      { method: init.method ?? "GET", headers, lookup: publicOnlyLookup as never, signal: init.signal, timeout: 20_000 },
      (incoming) => {
        const status = incoming.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          incoming.resume();
          return reject(new Error("Redirects are not followed"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            incoming.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          const noBody = status === 204 || status === 205 || status === 304;
          resolve(
            new Response(noBody ? null : Buffer.concat(chunks), { status, statusText: incoming.statusMessage, headers: responseHeaders }),
          );
        });
      },
    );
    outgoing.on("timeout", () => outgoing.destroy(new Error("Request timed out")));
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}
