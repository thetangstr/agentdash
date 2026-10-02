// AgentDash (GH #765, SC-4): the edge router (spec §4.3, SC-0 spike §3).
//
//   https://<slug>.agentdash.cloud  ->  https://<box's Railway domain>
//
// Headers to the box: Host becomes the upstream Railway host (Railway routes
// by Host); X-AgentDash-Edge carries the box's own edge secret and
// X-AgentDash-Client-IP the visitor's address, both OVERWRITTEN (a client's
// copies of any X-AgentDash-* header are stripped); X-Forwarded-Host and
// X-AgentDash-Forwarded-Host carry the public name (Railway's edge rewrites
// X-Forwarded-Host on the hop into the box, so the custom one is the one
// that arrives). Bodies stream unbuffered both ways; WebSocket upgrades are
// piped through once the box has answered 101. Connections to boxes are kept
// alive (the spike measured ~25 ms for the extra hop).
//
// Hardening (GH #808 security review):
//   - only origin-form request targets (`/path`, or `*` for OPTIONS) are
//     accepted; the upstream request line is always built from that path, so
//     an absolute-form target can never carry the edge secret elsewhere;
//   - only `Upgrade: websocket` is relayed, the box's status line is read
//     first, and bytes are piped both ways only after a 101; anything else is
//     relayed as a response and both sockets are closed (no open relay);
//   - request, header and idle timeouts, a per-client-IP concurrency limit
//     and a request body size limit, so slow or huge uploads cannot starve a
//     box's connection pool;
//   - `Domain=` is removed from every Set-Cookie a box sends, so cookies stay
//     host-only and a box cannot plant cookies on its siblings or www;
//   - no proxying while the route table is stale (Postgres unreachable for
//     minutes); X-Real-IP is ignored from private-network sockets.
//
// Pages: unknown or reserved names get a 404 linking to /find; a suspended
// box gets a "waking" page and a resume request; a deleted box says so; a box
// still being set up says that.
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { BlockList, isIP } from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { Logger } from "../logger.js";
import { isReservedSlug } from "../railway/slug.js";
import { badGatewayPage, deletedPage, notFoundPage, notReadyPage, unavailablePage, wakingPage } from "./pages.js";
import type { EdgeRoute, RouteLookup } from "./routes.js";

export type ClientIpSource = "x-real-ip" | "socket";

export interface EdgeLimits {
  /** Whole request (headers and body) must arrive within this. */
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  /** An upstream HTTP socket idle this long is dropped (Railway's own idle limit is 5 min). */
  upstreamIdleMs: number;
  /** A proxied WebSocket idle this long in both directions is closed. */
  websocketIdleMs: number;
  /** Concurrent proxied requests plus open WebSockets per client IP. */
  maxPerClient: number;
  /** Largest request body forwarded. */
  maxBodyBytes: number;
  /** Stop proxying when the route table has not loaded for this long. */
  maxRouteAgeMs: number;
}

export const DEFAULT_LIMITS: EdgeLimits = {
  requestTimeoutMs: 120_000,
  headersTimeoutMs: 30_000,
  upstreamIdleMs: 300_000,
  websocketIdleMs: 30 * 60_000,
  maxPerClient: 48,
  maxBodyBytes: 50 * 1024 * 1024,
  maxRouteAgeMs: 3 * 60_000,
};

export interface EdgeServerOptions {
  routes: RouteLookup;
  edgeDomain: string;
  log: Logger;
  /** Railway's edge overwrites X-Real-IP with the visitor's address (SC-0 §3.1); tests use the socket. */
  clientIpSource?: ClientIpSource;
  /** Sockets on these ranges never have their X-Real-IP believed (Railway's private network, #779/#763). */
  privateNetworkCidrs?: string[];
  /** Upstream transport; https in production, http for tests (upstream hosts may then carry a port). */
  upstreamProtocol?: "https" | "http";
  findUrl?: string;
  /** Called for each human request (not health, not the assistant endpoint). */
  recordActivity?: (slug: string) => void;
  requestResume?: (slug: string) => Promise<void>;
  /** Minimum gap between resume requests for one box. */
  resumeEveryMs?: number;
  /** Milliseconds since the route table last loaded; stale means no proxying. */
  routeAgeMs?: () => number;
  /** For the router's own health check on its Railway domain. */
  status?: () => Record<string, unknown>;
  limits?: Partial<EdgeLimits>;
  /** AgentDash (SC-10, GH #771): called once per response on a box host; true when the visitor got a 5xx error (./stats.ts). */
  recordResponse?: (serverError: boolean) => void;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "http2-settings",
]);
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const PROXY_STATES = new Set(["awaiting_claim", "active"]);
const DEFAULT_PRIVATE_CIDRS = ["10.0.0.0/8", "fc00::/7"];
const MAX_UPSTREAM_HEAD_BYTES = 16 * 1024;

function normaliseIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

function blockList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split("/") as [string, string];
    list.addSubnet(addr, Number(bits), isIP(addr) === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

export function clientIpOf(req: IncomingMessage, source: ClientIpSource, privateNet?: BlockList): string | null {
  const sock = normaliseIp(req.socket.remoteAddress);
  if (source === "x-real-ip") {
    // A sibling on the private network reaches the router directly and could write any X-Real-IP.
    const fromPrivate = sock !== null && privateNet?.check(sock, isIP(sock) === 6 ? "ipv6" : "ipv4");
    if (!fromPrivate) {
      const h = req.headers["x-real-ip"];
      const fromHeader = normaliseIp(Array.isArray(h) ? h[0] : h);
      if (fromHeader) return fromHeader;
    }
  }
  return sock;
}

/** The slug a Host header names under the edge domain, or null. */
export function slugOf(hostHeader: string | undefined, edgeDomain: string): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const suffix = `.${edgeDomain}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  return label.length > 0 && !label.includes(".") ? label : null;
}

/**
 * The request target to send upstream: origin-form only (`/…`), or `*` for
 * OPTIONS. Absolute-form (`http://other/…`) and authority-form are refused.
 */
export function originFormTarget(method: string | undefined, url: string | undefined): string | null {
  if (!url) return null;
  if (url === "*") return (method ?? "").toUpperCase() === "OPTIONS" ? "*" : null;
  if (!url.startsWith("/")) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(url)) return null;
  return url;
}

/**
 * The headers sent to the box: hop-by-hop removed (for an upgrade, only
 * Connection and Upgrade survive, rewritten), every client X-AgentDash-*
 * removed, then the router's own set.
 */
export function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  input: { upstreamHost: string; publicHost: string; edgeSecret: string; clientIp: string | null; upgrade?: boolean },
): Record<string, string | string[]> {
  const connectionListed = new Set(
    String(incoming.connection ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower.startsWith("x-agentdash-")) continue;
    if (lower === "host" || lower === "x-forwarded-host") continue;
    if (HOP_BY_HOP.has(lower) || connectionListed.has(lower)) continue;
    out[lower] = value;
  }
  if (input.upgrade) {
    out.connection = "Upgrade";
    out.upgrade = "websocket";
  }
  out.host = input.upstreamHost;
  out["x-forwarded-host"] = input.publicHost;
  out["x-agentdash-forwarded-host"] = input.publicHost;
  out["x-forwarded-proto"] = "https";
  out["x-agentdash-edge"] = input.edgeSecret;
  if (input.clientIp) out["x-agentdash-client-ip"] = input.clientIp;
  return out;
}

/** Remove every Domain attribute, so a box's cookies are host-only (no sibling boxes, no www). */
export function hostOnlyCookie(setCookie: string): string {
  return setCookie
    .split(";")
    .filter((part) => !/^\s*domain\s*=/i.test(part))
    .join(";");
}

export function isWebSocketUpgrade(headers: IncomingHttpHeaders): boolean {
  const upgrade = String(headers.upgrade ?? "").trim().toLowerCase();
  const connection = String(headers.connection ?? "").toLowerCase().split(",").map((s) => s.trim());
  return upgrade === "websocket" && connection.includes("upgrade");
}

function activityCounts(path: string): boolean {
  const p = path.split("?")[0]!;
  return !(p === "/api/health" || p.startsWith("/api/health/") || p === "/api/mcp/assistant" || p.startsWith("/api/mcp/assistant/"));
}

/** The provisioner's health probe: GET or HEAD of exactly /api/health (query ignored). */
export function isProvisioningHealthProbe(req: Pick<IncomingMessage, "method" | "url">): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const path = (req.url ?? "").split("?")[0];
  return path === "/api/health";
}

type Decision =
  | { kind: "proxy"; route: EdgeRoute & { upstreamHost: string }; secret: string; slug: string; publicHost: string }
  | { kind: "page"; status: number; html: string; headers?: Record<string, string>; resume?: string; fault?: boolean }
  | { kind: "self" };

function rawResponse(status: number, extra = ""): string {
  return `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`;
}

export function createEdgeServer(opts: EdgeServerOptions): http.Server {
  const log = opts.log.child({ component: "edge" });
  const limits: EdgeLimits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const protocol = opts.upstreamProtocol ?? "https";
  const findUrl = opts.findUrl ?? "https://www.agentdash.cloud/find";
  const ipSource = opts.clientIpSource ?? "x-real-ip";
  const privateNet = blockList(opts.privateNetworkCidrs ?? DEFAULT_PRIVATE_CIDRS);
  const resumeEvery = opts.resumeEveryMs ?? 30_000;
  const lastResume = new Map<string, number>();
  const perClient = new Map<string, number>();
  const agent =
    protocol === "https"
      ? new https.Agent({ keepAlive: true, maxSockets: 256, timeout: limits.upstreamIdleMs })
      : new http.Agent({ keepAlive: true, maxSockets: 256, timeout: limits.upstreamIdleMs });

  const acquire = (ip: string | null): (() => void) | null => {
    const key = ip ?? "unknown";
    const n = perClient.get(key) ?? 0;
    if (n >= limits.maxPerClient) return null;
    perClient.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (perClient.get(key) ?? 1) - 1;
      if (left <= 0) perClient.delete(key);
      else perClient.set(key, left);
    };
  };

  const upstreamTarget = (host: string) => {
    if (protocol === "https") return { hostname: host, port: 443 };
    const [hostname, port] = host.split(":");
    return { hostname: hostname!, port: Number(port ?? 80) };
  };

  async function decide(req: IncomingMessage): Promise<Decision> {
    const hostHeader = req.headers.host ?? "";
    const slug = slugOf(hostHeader, opts.edgeDomain);
    if (!slug) {
      // Our own Railway domain (health checks) or a name we do not serve.
      return hostHeader.toLowerCase().endsWith(opts.edgeDomain) ? { kind: "page", status: 404, html: notFoundPage(hostHeader, findUrl) } : { kind: "self" };
    }
    const publicHost = `${slug}.${opts.edgeDomain}`;
    if (!SLUG_RE.test(slug) || isReservedSlug(slug)) return { kind: "page", status: 404, html: notFoundPage(publicHost, findUrl) };
    if (opts.routeAgeMs && opts.routeAgeMs() > limits.maxRouteAgeMs) {
      return { kind: "page", status: 503, html: unavailablePage(), headers: { "retry-after": "30" }, fault: true };
    }
    const route = await opts.routes.lookup(slug);
    if (!route) return { kind: "page", status: 404, html: notFoundPage(publicHost, findUrl) };
    if (route.state === "suspended") {
      return { kind: "page", status: 503, html: wakingPage(slug), headers: { "retry-after": "10" }, resume: slug };
    }
    if (route.state === "deleted" || route.state === "pending_delete") return { kind: "page", status: 410, html: deletedPage(slug, findUrl) };
    if (PROXY_STATES.has(route.state) && route.upstreamHost && route.edgeSecret) {
      return { kind: "proxy", route: route as EdgeRoute & { upstreamHost: string }, secret: route.edgeSecret.reveal(), slug, publicHost };
    }
    // AgentDash (MVP launch): the provisioner's last check (step 8, CLOUD_EDGE_LIVE)
    // reads GET /api/health through this router while the box is still
    // `provisioning`, before the publish step moves it to `awaiting_claim`.
    // Forward exactly that request (health is public) so a new box is not
    // held at the not-ready page forever; everything else waits for publish.
    if (route.state === "provisioning" && route.upstreamHost && route.edgeSecret && isProvisioningHealthProbe(req)) {
      return { kind: "proxy", route: route as EdgeRoute & { upstreamHost: string }, secret: route.edgeSecret.reveal(), slug, publicHost };
    }
    if (route.state === "failed" || route.state === "cleanup") return { kind: "page", status: 404, html: notFoundPage(publicHost, findUrl) };
    return { kind: "page", status: 503, html: notReadyPage(slug), headers: { "retry-after": "15" } };
  }

  function maybeResume(slug: string) {
    const now = Date.now();
    if (!opts.requestResume || now - (lastResume.get(slug) ?? 0) < resumeEvery) return;
    lastResume.set(slug, now);
    void opts.requestResume(slug).catch((err: unknown) => log.warn("resume request failed", { slug, err }));
  }

  function sendPage(res: ServerResponse, d: Extract<Decision, { kind: "page" }>) {
    if (d.resume) maybeResume(d.resume);
    opts.recordResponse?.(d.fault === true);
    res.writeHead(d.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(d.headers ?? {}) });
    res.end(d.html);
  }

  function plain(res: ServerResponse, status: number, text: string) {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" }).end(text);
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    let d: Decision;
    try {
      d = await decide(req);
    } catch (err) {
      log.error("route decision failed", { err });
      opts.recordResponse?.(true);
      return plain(res, 500, "edge error");
    }
    if (d.kind === "self") {
      if ((req.url ?? "").split("?")[0] === "/health") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ status: "ok", service: "edge", ...(opts.status?.() ?? {}) }));
      } else {
        plain(res, 404, "not found");
      }
      return;
    }
    if (d.kind === "page") return sendPage(res, d);

    const target = originFormTarget(req.method, req.url);
    if (!target) return plain(res, 400, "bad request target");
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > limits.maxBodyBytes) return plain(res, 413, "request body too large");
    const clientIp = clientIpOf(req, ipSource, privateNet);
    const release = acquire(clientIp);
    if (!release) {
      res.setHeader("retry-after", "5");
      return plain(res, 429, "too many concurrent requests");
    }
    res.on("close", release);

    if (activityCounts(target)) opts.recordActivity?.(d.slug);
    const up = upstreamTarget(d.route.upstreamHost);
    const headers = upstreamHeaders(req.headers, { upstreamHost: d.route.upstreamHost, publicHost: d.publicHost, edgeSecret: d.secret, clientIp });
    const client = protocol === "https" ? https : http;
    const upstream = client.request(
      { ...up, method: req.method, path: target, headers, agent, ...(protocol === "https" ? { servername: up.hostname } : {}) },
      (upRes) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(upRes.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
          out[name] = name.toLowerCase() === "set-cookie" ? [value].flat().map(hostOnlyCookie) : value;
        }
        opts.recordResponse?.((upRes.statusCode ?? 502) >= 500);
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, out);
        res.flushHeaders();
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());
      },
    );
    upstream.setTimeout(limits.upstreamIdleMs, () => upstream.destroy(new Error("upstream idle timeout")));
    upstream.on("error", (err) => {
      log.warn("upstream request failed", { slug: d.slug, err });
      if (!res.headersSent) {
        opts.recordResponse?.(true);
        res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(badGatewayPage(d.slug));
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    // Stream the body with a running size check (chunked bodies declare no length).
    let seen = 0;
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > limits.maxBodyBytes) {
        upstream.destroy();
        if (!res.headersSent) plain(res, 413, "request body too large");
        req.destroy();
      }
    });
    req.pipe(upstream);
  }

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    if (!isWebSocketUpgrade(req.headers)) {
      socket.end(rawResponse(400));
      return;
    }
    const target = originFormTarget(req.method, req.url);
    if (!target || target === "*") {
      socket.end(rawResponse(400));
      return;
    }
    let d: Decision;
    try {
      d = await decide(req);
    } catch {
      socket.end(rawResponse(500));
      return;
    }
    if (d.kind !== "proxy") {
      socket.end(rawResponse(d.kind === "page" ? d.status : 404));
      return;
    }
    const clientIp = clientIpOf(req, ipSource, privateNet);
    const release = acquire(clientIp);
    if (!release) {
      socket.end(rawResponse(429, "Retry-After: 5\r\n"));
      return;
    }
    socket.once("close", release);
    const up = upstreamTarget(d.route.upstreamHost);
    const headers = upstreamHeaders(req.headers, { upstreamHost: d.route.upstreamHost, publicHost: d.publicHost, edgeSecret: d.secret, clientIp, upgrade: true });

    const conn: net.Socket =
      protocol === "https"
        ? tls.connect({ host: up.hostname, port: up.port, servername: up.hostname })
        : net.connect({ host: up.hostname, port: up.port });
    const closeBoth = () => {
      conn.destroy();
      socket.destroy();
    };
    conn.on("error", (err) => {
      log.warn("upstream upgrade failed", { slug: d.slug, err });
      closeBoth();
    });
    socket.on("close", () => conn.destroy());
    conn.once(protocol === "https" ? "secureConnect" : "connect", () => {
      const lines = [`GET ${target} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      conn.write(`${lines.join("\r\n")}\r\n\r\n`);
      // Read the box's status line and headers BEFORE relaying anything from the client.
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buf.length > MAX_UPSTREAM_HEAD_BYTES) closeBoth();
          return;
        }
        conn.off("data", onData);
        const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1] ?? 0);
        if (status !== 101) {
          // Relay the refusal and close: the client never gets a raw pipe to the box.
          socket.end(buf);
          conn.destroy();
          return;
        }
        socket.write(buf);
        if (head.length) conn.write(head);
        (socket as net.Socket).setTimeout(limits.websocketIdleMs, closeBoth);
        conn.setTimeout(limits.websocketIdleMs, closeBoth);
        conn.pipe(socket);
        socket.pipe(conn);
      };
      conn.on("data", onData);
      conn.setTimeout(limits.headersTimeoutMs, () => {
        if (buf.indexOf("\r\n\r\n") < 0) closeBoth();
      });
    });
  }

  const server = http.createServer((req, res) => void onRequest(req, res));
  server.on("upgrade", (req, socket, head) => void onUpgrade(req, socket, head));
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = 65_000;
  // Idle client connections are dropped; longer than the upstream idle limit, so
  // a hung box produces a 502 page rather than a reset.
  server.timeout = limits.upstreamIdleMs + 15_000;
  return server;
}

/** Batches box activity into one write per interval (spec §4.3 "Activity"). */
export class ActivityBuffer {
  #pending = new Set<string>();
  constructor(private readonly flushFn: (slugs: string[]) => Promise<void>) {}

  add(slug: string): void {
    this.#pending.add(slug);
  }

  get size(): number {
    return this.#pending.size;
  }

  async flush(): Promise<number> {
    if (!this.#pending.size) return 0;
    const slugs = [...this.#pending];
    this.#pending.clear();
    try {
      await this.flushFn(slugs);
      return slugs.length;
    } catch (err) {
      for (const s of slugs) this.#pending.add(s);
      throw err;
    }
  }
}
