/**
 * Source validation — SSRF prevention and path-traversal protection
 * for server-side fetches and local file reads triggered by agent tools.
 *
 * - `isUnsafeIp` blocks private/loopback/link-local/metadata addresses.
 * - `assertSafeHttpUrl` validates a URL's scheme and resolved DNS records.
 * - `assertSafeLocalPath` confines local file reads to INGEST_DATA_DIR,
 *   resolving symlinks so attackers can't escape via symlinks.
 * - `safeFetch` wraps `fetch` with DNS-pinning (eliminates DNS-rebinding
 *   TOCTOU), manual redirect handling (re-validates every redirect
 *   target), and strips credentials on cross-host redirects.
 */
import {
  lookup as dnsLookupCb,
  type LookupAddress,
  type LookupOneOptions,
} from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { realpath } from "node:fs/promises";
import {
  resolve as resolvePath,
  isAbsolute as isAbsolutePath,
} from "node:path";
import process from "node:process";

import { Agent, type Dispatcher } from "undici";

import { getErrorMessage } from "./utils.js";

// ---------------------------------------------------------------------------
// IP validation
// ---------------------------------------------------------------------------

/**
 * Returns true if an IPv4 or IPv6 address is private/loopback/link-local
 * or otherwise unsafe for outbound fetch from the server.
 *
 * Handles IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) by extracting
 * and checking the embedded IPv4.
 */
export function isUnsafeIp(ip: string): boolean {
  // IPv4-mapped IPv6 — extract the embedded IPv4 and re-check.
  // Node's dns.lookup and the WHATWG URL parser can return these in
  // two forms: dotted ("::ffff:127.0.0.1") and hex ("::ffff:7f00:1").
  if (ip.startsWith("::ffff:")) {
    const rest = ip.slice("::ffff:".length);
    // Dotted IPv4 form: ::ffff:127.0.0.1
    if (rest.includes(".")) {
      return isUnsafeIp(rest);
    }
    // Hex form: ::ffff:7f00:1  →  convert to dotted IPv4
    const hexParts = rest.split(":");
    if (hexParts.length === 2) {
      const high = parseInt(hexParts[0], 16);
      const low = parseInt(hexParts[1], 16);
      if (!Number.isNaN(high) && !Number.isNaN(low)) {
        const a = (high >> 8) & 0xff;
        const b = high & 0xff;
        const c = (low >> 8) & 0xff;
        const d = low & 0xff;
        return isUnsafeIp(`${a}.${b}.${c}.${d}`);
      }
    }
    return false;
  }

  // IPv6 loopback / unspecified
  if (ip === "::1" || ip === "::") {
    return true;
  }

  // IPv6 unique-local fc00::/7 (covers fc00:: through fdff:).
  // The first hextet starts with "fc" or "fd".
  if (ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }

  // IPv6 link-local fe80::/10 and site-local fec0::/10.
  // fe80::/10 covers first hextet 0xfe80..0xfebf.
  // fec0::/10 covers first hextet 0xfec0..0xfeff.
  // Both share the prefix 0xfe80..0xfeff, so a single range check on
  // the first hextet suffices.
  const colonIdx = ip.indexOf(":");
  if (colonIdx > 0) {
    const firstHextet = parseInt(ip.slice(0, colonIdx), 16);
    if (
      !Number.isNaN(firstHextet) &&
      firstHextet >= 0xfe80 &&
      firstHextet <= 0xfeff
    ) {
      return true;
    }
  }

  // IPv4
  const parts = ip.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number);
    if (a === 10) return true; // private 10.0.0.0/8
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
    if (a === 192 && b === 168) return true; // private 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }
  return false;
}

// ---------------------------------------------------------------------------
// DNS-pinning undici Agent
// ---------------------------------------------------------------------------

/**
 * Custom DNS lookup for undici's Agent that validates every resolved
 * address at *connect time*. This eliminates the DNS-rebinding TOCTOU:
 * the IP is validated at the moment the connection is opened, not at
 * an earlier check time.
 *
 * Returns only safe addresses; if all resolved addresses are unsafe,
 * calls back with an error so the connection is refused.
 */
function safeLookup(
  hostname: string,
  options: LookupOneOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string,
    family: number,
  ) => void,
): void {
  dnsLookupCb(
    hostname,
    { all: true, family: options.family },
    (err, addresses) => {
      if (err) return callback(err, "", 0);
      const all = addresses as LookupAddress[];
      const safe = all.filter((a) => !isUnsafeIp(a.address));
      if (safe.length === 0) {
        const allAddrs = all.map((a) => a.address).join(", ") || "(none)";
        return callback(
          new Error(
            `Refusing to connect to ${hostname}: all resolved addresses (${allAddrs}) are unsafe`,
          ),
          "",
          0,
        );
      }
      callback(null, safe[0].address, safe[0].family);
    },
  );
}

/**
 * Shared undici Agent that enforces IP validation at connect time.
 * Used by `safeFetch` so that even DNS rebinding between the pre-check
 * and the actual connection cannot reach an unsafe host.
 */
const safeAgent: Dispatcher = new Agent({
  connect: { lookup: safeLookup },
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export interface ValidatedUrl {
  url: URL;
  /** Resolved IP addresses (all validated as safe). */
  resolvedAddresses: string[];
}

/**
 * Validate that an HTTP(S) URL is safe to fetch from the server.
 * Rejects non-http(s) schemes, literal unsafe IPs, and hostnames that
 * resolve (in part or wholly) to private/loopback/link-local/metadata
 * addresses.
 *
 * This is a pre-check that provides clear error messages early. The
 * actual connection is additionally guarded by `safeLookup` inside the
 * undici Agent, which re-validates at connect time.
 */
export async function assertSafeHttpUrl(rawUrl: string): Promise<ValidatedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname;
  // WHATWG URL.hostname includes brackets for IPv6 literals (e.g.
  // "[::ffff:7f00:1]"). Strip them for IP validation and DNS lookup.
  const hostForCheck =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  // Literal IP in the URL — check directly.
  if (isUnsafeIp(hostForCheck)) {
    throw new Error(`Refusing to fetch from unsafe host: ${host}`);
  }

  // Resolve the hostname and reject if ANY resolved address is unsafe.
  // This catches attacker-controlled DNS with mixed safe/unsafe records.
  let addresses: LookupAddress[];
  try {
    addresses = (await dnsLookup(hostForCheck, {
      all: true,
    })) as LookupAddress[];
  } catch (err) {
    throw new Error(`Failed to resolve host ${host}: ${getErrorMessage(err)}`, {
      cause: err,
    });
  }

  const unsafe = addresses.filter((a) => isUnsafeIp(a.address));
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to fetch from unsafe host: ${host} (resolves to ${unsafe.map((a) => a.address).join(", ")})`,
    );
  }

  return { url: parsed, resolvedAddresses: addresses.map((a) => a.address) };
}

// ---------------------------------------------------------------------------
// Local path validation
// ---------------------------------------------------------------------------

/**
 * Validate that a local file path is safe to read.
 *
 * Local reads are restricted to the directory configured via the
 * INGEST_DATA_DIR environment variable, preventing the agent from
 * reading arbitrary files (e.g. /etc/passwd, .env, ~/.ssh/id_rsa).
 *
 * Uses `realpath` to resolve symlinks before checking containment,
 * so a symlink inside INGEST_DATA_DIR that points outside is rejected.
 */
export async function assertSafeLocalPath(rawPath: string): Promise<string> {
  const base = process.env.INGEST_DATA_DIR;
  if (!base) {
    throw new Error(
      "Local file ingest requires INGEST_DATA_DIR to be set; refusing to read arbitrary paths",
    );
  }

  const resolvedBase = await realpath(resolvePath(base));

  // Resolve the target through symlinks. If the file doesn't exist yet,
  // realpath throws ENOENT — fall back to lexical resolution so the
  // caller gets a clear "file not found" error from readFile rather
  // than a confusing validation error. Relative paths are resolved
  // against INGEST_DATA_DIR (not process.cwd()) so a missing file inside
  // the ingest dir is reported as "not found" instead of "outside
  // INGEST_DATA_DIR".
  const isRelative = !isAbsolutePath(rawPath);
  const lexicalTarget = isRelative
    ? resolvePath(resolvedBase, rawPath)
    : resolvePath(rawPath);
  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(lexicalTarget);
  } catch (err) {
    if (getErrorMessage(err).includes("ENOENT")) {
      resolvedTarget = lexicalTarget;
    } else {
      throw err;
    }
  }

  const isInside =
    resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + "/");
  if (!isInside) {
    throw new Error(
      `Refusing to read path outside INGEST_DATA_DIR: ${rawPath}`,
    );
  }
  return resolvedTarget;
}

// ---------------------------------------------------------------------------
// Safe fetch (redirect-safe + DNS-pinned)
// ---------------------------------------------------------------------------

/** Node/undici-specific fetch options that include the dispatcher. */
interface NodeRequestInit extends RequestInit {
  dispatcher?: Dispatcher;
}

/**
 * Headers that are dropped when following a redirect to a different host.
 * These carry credentials or session state that must not leak to an
 * attacker-controlled (or simply different) destination.
 */
const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
]);

/**
 * Build the request init for a given hop, stripping sensitive headers when
 * the target host differs from the original request's host.
 *
 * `originalHost` is the host of the very first URL passed to `safeFetch`;
 * `currentHost` is the host of the URL about to be fetched on this hop.
 * Headers are preserved on same-host redirects (a common, legitimate pattern
 * for CDNs that redirect HTTP→HTTPS or path-normalize on the same origin)
 * and dropped on cross-host redirects.
 */
function buildRedirectInit(
  init: RequestInit,
  originalHost: string,
  currentHost: string,
): NodeRequestInit {
  const crossHost = originalHost.toLowerCase() !== currentHost.toLowerCase();
  let headers = init.headers;
  if (crossHost && headers) {
    // Normalize to a mutable record so we can delete entries.
    // Avoid `instanceof Headers` (project `no-instanceof` lint rule):
    // detect a Headers-like object by the presence of a `forEach` method
    // on a non-array value.
    const headerRecord: Record<string, string> = {};
    if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        headerRecord[key] = value;
      }
    } else if (
      typeof headers === "object" &&
      headers !== null &&
      typeof (headers as { forEach?: unknown }).forEach === "function"
    ) {
      // Headers (or any Headers-like iterable) — use its forEach.
      (headers as Headers).forEach((value, key) => {
        headerRecord[key] = value;
      });
    } else {
      for (const [key, value] of Object.entries(
        headers as Record<string, string>,
      )) {
        headerRecord[key] = value;
      }
    }
    for (const key of Object.keys(headerRecord)) {
      if (SENSITIVE_REDIRECT_HEADERS.has(key.toLowerCase())) {
        delete headerRecord[key];
      }
    }
    headers = headerRecord;
  }
  return {
    ...init,
    headers,
    redirect: "manual",
    dispatcher: safeAgent,
  };
}

/**
 * Fetch a URL safely:
 *
 * 1. Validates the URL scheme and resolved IPs before connecting.
 * 2. Uses a DNS-pinning undici Agent so the actual TCP connection
 *    goes to a validated IP (eliminates DNS-rebinding TOCTOU).
 * 3. Follows redirects manually, re-validating every redirect target
 *    so an attacker can't bypass the check with a 302 to an internal
 *    address.
 * 4. Strips `Authorization` / `Cookie` / `Proxy-Authorization` / `X-API-Key`
 *    headers when following a redirect to a different host, so credentials
 *    supplied for the original origin are not forwarded to a third party.
 *
 * Up to `maxRedirects` redirects are followed (default 5).
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  maxRedirects = 5,
): Promise<Response> {
  const originalHost = new URL(rawUrl).hostname;
  let currentUrl = rawUrl;

  for (let i = 0; i <= maxRedirects; i++) {
    // Pre-check: scheme, literal IP, DNS resolution.
    await assertSafeHttpUrl(currentUrl);

    const currentHost = new URL(currentUrl).hostname;
    const nodeInit = buildRedirectInit(init, originalHost, currentHost);

    const res = await fetch(currentUrl, nodeInit);

    // Handle redirects manually so we can re-validate the target.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) {
        throw new Error(
          `Redirect response (${res.status}) missing Location header`,
        );
      }
      // Resolve relative redirects against the current URL.
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    return res;
  }

  throw new Error(`Too many redirects (max ${maxRedirects})`);
}
