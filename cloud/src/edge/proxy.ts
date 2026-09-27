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
// piped through. Connections to boxes are kept alive (the spike measured
// ~25 ms for the extra hop; a new TLS handshake per request would add more).
//
// Pages: unknown or reserved names get a 404 linking to /find; a suspended
// box gets a "waking" page and a resume request; a deleted box says so; a box
// still being set up says that.
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { isIP } from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { Logger } from "../logger.js";
import { RESERVED_SLUGS } from "../railway/slug.js";
import { badGatewayPage, deletedPage, notFoundPage, notReadyPage, wakingPage } from "./pages.js";
import type { EdgeRoute, RouteLookup } from "./routes.js";

export type ClientIpSource = "x-real-ip" | "socket";

export interface EdgeServerOptions {
  routes: RouteLookup;
  edgeDomain: string;
  log: Logger;
  /** Railway's edge overwrites X-Real-IP with the visitor's address (SC-0 §3.1); tests use the socket. */
  clientIpSource?: ClientIpSource;
  /** Upstream transport; https in production, http for tests (upstream hosts may then carry a port). */
  upstreamProtocol?: "https" | "http";
  findUrl?: string;
  /** Called for each human request (not health, not the assistant endpoint). */
  recordActivity?: (slug: string) => void;
  requestResume?: (slug: string) => Promise<void>;
  /** Minimum gap between resume requests for one box. */
  resumeEveryMs?: number;
  /** For the router's own health check on its Railway domain. */
  status?: () => Record<string, unknown>;
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
]);
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const PROXY_STATES = new Set(["awaiting_claim", "active"]);

function normaliseIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

export function clientIpOf(req: IncomingMessage, source: ClientIpSource): string | null {
  if (source === "x-real-ip") {
    const h = req.headers["x-real-ip"];
    const fromHeader = normaliseIp(Array.isArray(h) ? h[0] : h);
    if (fromHeader) return fromHeader;
  }
  return normaliseIp(req.socket.remoteAddress);
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
 * The headers sent to the box: hop-by-hop removed (unless upgrading), every
 * client X-AgentDash-* removed, then the router's own set.
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
    if (!input.upgrade && (HOP_BY_HOP.has(lower) || connectionListed.has(lower))) continue;
    out[lower] = value;
  }
  out.host = input.upstreamHost;
  out["x-forwarded-host"] = input.publicHost;
  out["x-agentdash-forwarded-host"] = input.publicHost;
  out["x-forwarded-proto"] = "https";
  out["x-agentdash-edge"] = input.edgeSecret;
  if (input.clientIp) out["x-agentdash-client-ip"] = input.clientIp;
  return out;
}

function activityCounts(path: string): boolean {
  const p = path.split("?")[0]!;
  return !(p === "/api/health" || p.startsWith("/api/health/") || p === "/api/mcp/assistant" || p.startsWith("/api/mcp/assistant/"));
}

type Decision =
  | { kind: "proxy"; route: EdgeRoute & { upstreamHost: string }; secret: string; slug: string; publicHost: string }
  | { kind: "page"; status: number; html: string; headers?: Record<string, string>; resume?: string }
  | { kind: "self" };

export function createEdgeServer(opts: EdgeServerOptions): http.Server {
  const log = opts.log.child({ component: "edge" });
  const protocol = opts.upstreamProtocol ?? "https";
  const findUrl = opts.findUrl ?? "https://www.agentdash.cloud/find";
  const ipSource = opts.clientIpSource ?? "x-real-ip";
  const resumeEvery = opts.resumeEveryMs ?? 30_000;
  const lastResume = new Map<string, number>();
  const agent = protocol === "https" ? new https.Agent({ keepAlive: true, maxSockets: 256 }) : new http.Agent({ keepAlive: true, maxSockets: 256 });

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
    if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) return { kind: "page", status: 404, html: notFoundPage(publicHost, findUrl) };
    const route = await opts.routes.lookup(slug);
    if (!route) return { kind: "page", status: 404, html: notFoundPage(publicHost, findUrl) };
    if (route.state === "suspended") {
      return { kind: "page", status: 503, html: wakingPage(slug), headers: { "retry-after": "10" }, resume: slug };
    }
    if (route.state === "deleted" || route.state === "pending_delete") return { kind: "page", status: 410, html: deletedPage(slug, findUrl) };
    if (PROXY_STATES.has(route.state) && route.upstreamHost && route.edgeSecret) {
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
    res.writeHead(d.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(d.headers ?? {}) });
    res.end(d.html);
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    let d: Decision;
    try {
      d = await decide(req);
    } catch (err) {
      log.error("route decision failed", { err });
      res.writeHead(500, { "content-type": "text/plain" }).end("edge error");
      return;
    }
    if (d.kind === "self") {
      if ((req.url ?? "").split("?")[0] === "/health") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ status: "ok", service: "edge", ...(opts.status?.() ?? {}) }));
      } else {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
      return;
    }
    if (d.kind === "page") return sendPage(res, d);

    if (activityCounts(req.url ?? "/")) opts.recordActivity?.(d.slug);
    const target = upstreamTarget(d.route.upstreamHost);
    const headers = upstreamHeaders(req.headers, {
      upstreamHost: d.route.upstreamHost,
      publicHost: d.publicHost,
      edgeSecret: d.secret,
      clientIp: clientIpOf(req, ipSource),
    });
    const client = protocol === "https" ? https : http;
    const upstream = client.request(
      { ...target, method: req.method, path: req.url, headers, agent, ...(protocol === "https" ? { servername: target.hostname } : {}) },
      (up) => {
        const out: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(up.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
          out[name] = value;
        }
        res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
        res.flushHeaders();
        up.pipe(res);
        up.on("error", () => res.destroy());
      },
    );
    upstream.on("error", (err) => {
      log.warn("upstream request failed", { slug: d.slug, err });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(badGatewayPage(d.slug));
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on("error", () => socket.destroy());
    let d: Decision;
    try {
      d = await decide(req);
    } catch {
      socket.end("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
      return;
    }
    if (d.kind !== "proxy") {
      const status = d.kind === "page" ? d.status : 404;
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const target = upstreamTarget(d.route.upstreamHost);
    const headers = upstreamHeaders(req.headers, {
      upstreamHost: d.route.upstreamHost,
      publicHost: d.publicHost,
      edgeSecret: d.secret,
      clientIp: clientIpOf(req, ipSource),
      upgrade: true,
    });
    const onConnect = () => {
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    };
    const up: Duplex =
      protocol === "https"
        ? tls.connect({ host: target.hostname, port: target.port, servername: target.hostname }, onConnect)
        : net.connect({ host: target.hostname, port: target.port }, onConnect);
    up.on("error", (err) => {
      log.warn("upstream upgrade failed", { slug: d.slug, err });
      socket.destroy();
    });
    up.on("close", () => socket.destroy());
    socket.on("close", () => up.destroy());
  }

  const server = http.createServer((req, res) => void onRequest(req, res));
  server.on("upgrade", (req, socket, head) => void onUpgrade(req, socket, head));
  // Long-lived WebSockets and streams: no server-side request timeout (Railway's limits apply on both hops).
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
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
