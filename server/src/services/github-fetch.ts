import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { badRequest, HttpError, unprocessable } from "../errors.js";

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

// ---------------------------------------------------------------------------
// AgentDash: SSRF-hardened GitHub fetch (GH #709).
//
// Company import (and skill import) take a user-supplied "GitHub" URL and the
// server fetches from it. Before this, any HTTPS host was accepted and
// redirects were followed, so a board user could point the server at an
// attacker host that redirects to cloud metadata or a localhost admin port.
//
// Every request — and every redirect hop — now has to:
//   1. be https on the default port, with no embedded credentials;
//   2. target an allowlisted host (github.com family + operator-configured
//      GitHub Enterprise hosts);
//   3. resolve only to public addresses. The connection is pinned to the
//      address we validated, so a second DNS answer cannot swap in a private
//      one (DNS rebinding);
// and the response is bounded in size and time.
// ---------------------------------------------------------------------------

/** Hosts GitHub.com content is served from. raw.githubusercontent.com is what resolveRawGitHubUrl uses. */
export const DEFAULT_GITHUB_FETCH_HOSTS: readonly string[] = [
  "github.com",
  "www.github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
];

export const GITHUB_FETCH_MAX_REDIRECTS = 5;
export const GITHUB_FETCH_TIMEOUT_MS = 30_000;
export const GITHUB_FETCH_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const DNS_LOOKUP_TIMEOUT_MS = 5_000;

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Pull a bare hostname out of either "ghe.example.com" or "https://ghe.example.com/api/v3". */
function hostFromSetting(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:") return null;
    return normalizeHost(url.hostname) || null;
  } catch {
    return null;
  }
}

/**
 * The hosts ghFetch may talk to. Operators running GitHub Enterprise add their
 * hosts with AGENTDASH_GITHUB_ALLOWED_HOSTS (comma-separated). The existing
 * GitHub Enterprise settings (AGENTDASH_GITHUB_API_URL when https, and
 * AGENTDASH_GITHUB_ISSUES_HOSTNAME) are reused so an already-configured
 * enterprise host keeps working without a second setting.
 */
export function allowedGitHubFetchHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(DEFAULT_GITHUB_FETCH_HOSTS);
  for (const entry of (env.AGENTDASH_GITHUB_ALLOWED_HOSTS ?? "").split(",")) {
    const host = hostFromSetting(entry);
    if (host) hosts.add(host);
  }
  for (const setting of [env.AGENTDASH_GITHUB_API_URL, env.AGENTDASH_GITHUB_ISSUES_HOSTNAME]) {
    const host = hostFromSetting(setting);
    if (host) hosts.add(host);
  }
  for (const host of privateGitHubFetchHosts(env)) hosts.add(host);
  return hosts;
}

/**
 * AgentDash: exact hostnames the operator has said may resolve to private
 * addresses (an internal GitHub Enterprise on 10.x, say). Set with
 * AGENTDASH_GITHUB_PRIVATE_HOSTS (comma-separated, exact names, no wildcards).
 * Listing a host here also allows it. The relaxation is per hop: a redirect
 * only gets it when the redirect target's exact hostname is listed too, and
 * loopback, link-local/metadata, unspecified and multicast addresses stay
 * blocked even for listed hosts.
 */
export function privateGitHubFetchHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set<string>();
  for (const entry of (env.AGENTDASH_GITHUB_PRIVATE_HOSTS ?? "").split(",")) {
    const host = hostFromSetting(entry);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * "github": only allowlisted GitHub hosts over HTTPS (company import, GitHub skill import, issue reports).
 * "public": any host on a public address, http or https on the default port. Used only for the
 * explicit "import a skill from a plain URL" path, which predates this guard and is not GitHub-specific.
 */
export type GitHubFetchHostPolicy = "github" | "public";

/** Why a URL is not an acceptable fetch target, or null when it is. */
function gitHubUrlProblem(url: URL, env: NodeJS.ProcessEnv, policy: GitHubFetchHostPolicy = "github"): string | null {
  if (policy === "public") {
    if (url.protocol !== "https:" && url.protocol !== "http:") return "URL must use HTTP or HTTPS";
    if (url.username || url.password) return "URL must not contain credentials";
    if (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) return "URL must use the default port";
    return null;
  }
  if (url.protocol !== "https:") return "GitHub source URL must use HTTPS";
  if (url.username || url.password) return "GitHub source URL must not contain credentials";
  if (url.port && url.port !== "443") return "GitHub source URL must use the default HTTPS port";
  const host = normalizeHost(url.hostname);
  if (!allowedGitHubFetchHosts(env).has(host)) {
    return `Host ${host} is not an allowed GitHub host. Operators can allow GitHub Enterprise hosts with AGENTDASH_GITHUB_ALLOWED_HOSTS.`;
  }
  return null;
}

/**
 * Validate a user-supplied GitHub source URL up front so the request fails
 * with a clear 400 before any network work happens.
 */
export function assertAllowedGitHubSourceUrl(rawUrl: string, env: NodeJS.ProcessEnv = process.env): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw badRequest("Invalid GitHub source URL", { code: "GITHUB_SOURCE_URL_INVALID" });
  }
  const problem = gitHubUrlProblem(url, env);
  if (problem) {
    throw badRequest(problem, { code: "GITHUB_SOURCE_HOST_NOT_ALLOWED", host: normalizeHost(url.hostname) });
  }
  return url;
}

// --- address classification -------------------------------------------------

// Two lists on purpose: node:net BlockList matches IPv4 addresses against IPv4-mapped
// IPv6 rules, so one shared list containing ::ffff:0:0/96 would block every IPv4.
const BLOCKED_IPV4 = (() => {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8], // "this network"
    ["10.0.0.0", 8], // RFC 1918
    ["100.64.0.0", 10], // CGNAT (also Tailscale)
    ["127.0.0.0", 8], // loopback
    ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
    ["172.16.0.0", 12], // RFC 1918
    ["192.0.0.0", 24], // IETF protocol assignments
    ["192.0.2.0", 24], // TEST-NET-1
    ["192.88.99.0", 24], // 6to4 relay anycast
    ["192.168.0.0", 16], // RFC 1918
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // TEST-NET-2
    ["203.0.113.0", 24], // TEST-NET-3
    ["224.0.0.0", 4], // multicast
    ["240.0.0.0", 4], // reserved + broadcast
  ];
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, "ipv4");
  return list;
})();

const BLOCKED_IPV6 = (() => {
  const list = new BlockList();
  const v6: Array<[string, number]> = [
    ["::", 96], // unspecified, loopback and deprecated IPv4-compatible
    ["::ffff:0:0", 96], // IPv4-mapped — GitHub never publishes these
    ["::ffff:0:0:0", 96], // IPv4-translated (SIIT) — embeds an arbitrary IPv4
    ["64:ff9b::", 96], // NAT64 — can reach internal IPv4
    ["64:ff9b:1::", 48], // local-use NAT64
    ["100::", 64], // discard-only
    ["2001::", 32], // Teredo
    ["2001:db8::", 32], // documentation
    ["2002::", 16], // 6to4 — embeds an arbitrary IPv4
    ["3fff::", 20], // documentation (RFC 9637)
    ["fc00::", 7], // ULA
    ["fe80::", 10], // link-local
    ["fec0::", 10], // deprecated site-local
    ["ff00::", 8], // multicast
  ];
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
})();

/** True for loopback, private, link-local, CGNAT, ULA, IPv4-mapped and other non-public addresses. */
export function isNonPublicAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(ip);
  if (family === 4) return BLOCKED_IPV4.check(ip, "ipv4");
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped?.[1]) return true;
    return BLOCKED_IPV6.check(ip, "ipv6");
  }
  // Not an IP literal at all: refuse rather than guess.
  return true;
}

// Never reachable, not even for an operator-listed private host: loopback,
// link-local (cloud metadata lives at 169.254.169.254), unspecified, multicast,
// reserved, and IPv4 embedded in IPv6 (which could smuggle any of those).
const ALWAYS_BLOCKED_IPV4 = (() => {
  const list = new BlockList();
  const v4: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, "ipv4");
  return list;
})();

const ALWAYS_BLOCKED_IPV6 = (() => {
  const list = new BlockList();
  const v6: Array<[string, number]> = [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["::ffff:0:0:0", 96],
    ["64:ff9b::", 96],
    ["2001::", 32],
    ["2002::", 16],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ];
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, "ipv6");
  return list;
})();

/** True for addresses no host may reach, even one listed in AGENTDASH_GITHUB_PRIVATE_HOSTS. */
export function isAlwaysBlockedAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(ip);
  if (family === 4) return ALWAYS_BLOCKED_IPV4.check(ip, "ipv4");
  if (family === 6) {
    if (/^(?:0{0,4}:){0,5}:?ffff:\d{1,3}\./.test(ip.toLowerCase())) return true;
    return ALWAYS_BLOCKED_IPV6.check(ip, "ipv6");
  }
  return true;
}

// --- transport --------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface GitHubTransportRequest {
  url: URL;
  /** The validated address to connect to. The transport must not re-resolve the hostname. */
  address: ResolvedAddress;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface GitHubTransportResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array | string>;
  /** Release the underlying connection without reading the body. */
  discard(): void;
}

export interface GitHubFetchDeps {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  transport: (request: GitHubTransportRequest) => Promise<GitHubTransportResponse>;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
  hostPolicy: GitHubFetchHostPolicy;
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Options for a request connected straight to the validated IP. The Host header
 * and TLS SNI keep the real hostname, so certificate verification (left at the
 * Node default, never disabled) still checks the certificate against it.
 */
export function buildPinnedRequestOptions(request: GitHubTransportRequest) {
  const tls = request.url.protocol === "https:";
  return {
    protocol: tls ? "https:" : "http:",
    host: request.address.address,
    family: request.address.family,
    port: tls ? 443 : 80,
    path: `${request.url.pathname}${request.url.search}`,
    method: request.method,
    headers: { ...request.headers, host: request.url.host },
    ...(tls && isIP(request.url.hostname) === 0 ? { servername: request.url.hostname } : {}),
    signal: request.signal,
  };
}

function defaultTransport(request: GitHubTransportRequest): Promise<GitHubTransportResponse> {
  const tls = request.url.protocol === "https:";
  return new Promise((resolve, reject) => {
    const req = (tls ? httpsRequest : httpRequest)(
      buildPinnedRequestOptions(request),
      (res: IncomingMessage) => {
        resolve({
          status: res.statusCode ?? 502,
          statusText: res.statusMessage ?? "",
          headers: res.headers,
          body: res,
          discard: () => res.destroy(),
        });
      },
    );
    req.on("error", reject);
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}

const DEFAULT_DEPS: GitHubFetchDeps = {
  lookup: defaultLookup,
  transport: defaultTransport,
  env: process.env,
  timeoutMs: GITHUB_FETCH_TIMEOUT_MS,
  maxResponseBytes: GITHUB_FETCH_MAX_RESPONSE_BYTES,
  maxRedirects: GITHUB_FETCH_MAX_REDIRECTS,
  hostPolicy: "github",
};

function headersToRecord(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function requestBody(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  throw new Error("ghFetch only supports string request bodies");
}

async function resolvePublicAddress(hostname: string, deps: GitHubFetchDeps): Promise<ResolvedAddress> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  let results: ResolvedAddress[];
  if (isIP(bare)) {
    results = [{ address: bare, family: isIP(bare) }];
  } else {
    try {
      results = await deps.lookup(bare);
    } catch {
      throw unprocessable(`Could not resolve ${bare} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
    }
  }
  if (results.length === 0) {
    throw unprocessable(`Could not resolve ${bare}`);
  }
  // Strict: one non-public answer is enough to refuse. A real GitHub host never
  // mixes private and public records; a rebinding attacker does. A host the
  // operator listed in AGENTDASH_GITHUB_PRIVATE_HOSTS (exact name, checked per
  // hop) may resolve to private ranges, but never to loopback or link-local.
  const privateAllowed =
    deps.hostPolicy === "github" && privateGitHubFetchHosts(deps.env).has(normalizeHost(bare));
  const refused = privateAllowed
    ? results.some((entry) => isAlwaysBlockedAddress(entry.address))
    : results.some((entry) => isNonPublicAddress(entry.address));
  if (refused) {
    throw unprocessable(`Refusing to fetch from ${bare}: it resolves to a private or reserved address`, {
      code: "GITHUB_FETCH_PRIVATE_ADDRESS",
      host: bare,
    });
  }
  return results[0]!;
}

async function readBounded(
  response: GitHubTransportResponse,
  maxBytes: number,
  host: string,
): Promise<Buffer> {
  const declared = Number(firstHeader(response.headers["content-length"]));
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.discard();
    throw unprocessable(`Response from ${host} is too large (${declared} bytes; limit ${maxBytes})`, {
      code: "GITHUB_FETCH_RESPONSE_TOO_LARGE",
    });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      response.discard();
      throw unprocessable(`Response from ${host} exceeded ${maxBytes} bytes`, {
        code: "GITHUB_FETCH_RESPONSE_TOO_LARGE",
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Build a ghFetch bound to the given dependencies. Exported for tests; production code uses ghFetch. */
export function createGitHubFetch(overrides: Partial<GitHubFetchDeps> = {}) {
  const deps: GitHubFetchDeps = { ...DEFAULT_DEPS, ...overrides };

  return async function hardenedGhFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw badRequest("Invalid GitHub URL", { code: "GITHUB_SOURCE_URL_INVALID" });
    }
    const initialProblem = gitHubUrlProblem(url, deps.env, deps.hostPolicy);
    if (initialProblem) {
      throw badRequest(initialProblem, { code: "GITHUB_SOURCE_HOST_NOT_ALLOWED", host: normalizeHost(url.hostname) });
    }

    const signals = [AbortSignal.timeout(deps.timeoutMs)];
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);

    let method = (init?.method ?? "GET").toUpperCase();
    let headers = headersToRecord(init?.headers);
    // node:https sends no User-Agent of its own (fetch did), and api.github.com rejects requests without one.
    if (!headers["user-agent"]) headers["user-agent"] = "AgentDash";
    let body = requestBody(init?.body);

    try {
      for (let hop = 0; ; hop += 1) {
        const address = await resolvePublicAddress(url.hostname, deps);
        const response = await deps.transport({ url, address, method, headers, body, signal });

        const location = firstHeader(response.headers.location);
        if (response.status >= 300 && response.status < 400 && location) {
          response.discard();
          if (hop >= deps.maxRedirects) {
            throw unprocessable(`Too many redirects fetching from ${url.hostname}`, { code: "GITHUB_FETCH_TOO_MANY_REDIRECTS" });
          }
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            throw unprocessable(`Invalid redirect from ${url.hostname}`, { code: "GITHUB_FETCH_REDIRECT_BLOCKED" });
          }
          // Never downgrade: an https request may not be redirected to plain http.
          const problem = url.protocol === "https:" && next.protocol !== "https:"
            ? "redirect would downgrade HTTPS to HTTP"
            : gitHubUrlProblem(next, deps.env, deps.hostPolicy);
          if (problem) {
            throw unprocessable(`Refusing redirect from ${url.hostname} to ${normalizeHost(next.hostname)}: ${problem}`, {
              code: "GITHUB_FETCH_REDIRECT_BLOCKED",
              host: normalizeHost(next.hostname),
            });
          }
          // Mirror fetch's redirect semantics: 303 (and 301/302 for POST) become GET.
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
            method = method === "HEAD" ? "HEAD" : "GET";
            body = undefined;
            delete headers["content-type"];
            delete headers["content-length"];
          }
          // Never carry credentials to a different host.
          if (normalizeHost(next.hostname) !== normalizeHost(url.hostname)) {
            const { authorization: _authorization, cookie: _cookie, ...rest } = headers;
            headers = rest;
          }
          url = next;
          continue;
        }

        const buffer = await readBounded(response, deps.maxResponseBytes, url.hostname);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
        }
        return new Response(NULL_BODY_STATUSES.has(response.status) ? null : new Uint8Array(buffer), {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        });
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (signal.aborted) {
        throw unprocessable(`Timed out fetching from ${url.hostname}`, { code: "GITHUB_FETCH_TIMEOUT" });
      }
      throw unprocessable(`Could not connect to ${url.hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
    }
  };
}

const defaultGhFetch = createGitHubFetch();

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  return defaultGhFetch(url, init);
}

const defaultPublicUrlFetch = createGitHubFetch({ hostPolicy: "public" });

/**
 * AgentDash: same guards as ghFetch (public-address check per hop, pinned
 * connection, manual redirects, size + time bounds) without the GitHub host
 * allowlist. Only for the plain-URL skill import.
 */
export async function publicUrlFetch(url: string, init?: RequestInit): Promise<Response> {
  return defaultPublicUrlFetch(url, init);
}
