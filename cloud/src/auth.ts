// AgentDash: guards for the operator surface. All must pass, in this order:
//   0. the caller is not locked out for repeated failures (429),
//   1. the caller's IP is on CLOUD_ADMIN_ALLOWED_IPS (empty list = nobody),
//   2. `Authorization: Bearer <CLOUD_ADMIN_TOKEN>`, compared in constant time.
// The client IP comes from the socket, or from X-Real-IP when
// CLOUD_CLIENT_IP_SOURCE=x-real-ip. Railway's edge overwrites X-Real-IP with
// the real client address (measured in the SC-0 spike), so that source is
// safe for traffic through a Railway public domain and nowhere else. A
// sibling service on the project's private network (the router, spec §3)
// reaches this service directly and can write any X-Real-IP it likes, so in
// that mode a request whose SOCKET address is on the private network is
// refused outright (GH #778).
import { isIP } from "node:net";
import type { BlockList } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { CloudConfig } from "./config.js";
import { constantTimeEqual } from "./crypto.js";
import type { Logger } from "./logger.js";

function normaliseIp(raw: string | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : null;
}

function inList(list: BlockList, ip: string): boolean {
  return list.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
}

export function socketIp(req: Request): string | null {
  return normaliseIp(req.socket.remoteAddress);
}

export function clientIp(req: Request, source: CloudConfig["clientIpSource"]): string | null {
  if (source === "x-real-ip") {
    const h = req.headers["x-real-ip"];
    return normaliseIp(Array.isArray(h) ? h[0] : h);
  }
  return socketIp(req);
}

/**
 * True when X-Real-IP must not be believed for this request: the header is
 * the configured source and the connection itself comes from the private
 * network, i.e. it never passed through Railway's public edge.
 */
export function fromPrivateNetwork(req: Request, config: Pick<CloudConfig, "clientIpSource" | "privateNetwork">): boolean {
  if (config.clientIpSource !== "x-real-ip" || !config.privateNetwork) return false;
  const sock = socketIp(req);
  // An unreadable socket address is treated as untrusted.
  return sock === null || inList(config.privateNetwork, sock);
}

/**
 * Per-IP failure counter for /internal (GH #778). After `maxFailures`
 * refusals inside `windowMs`, the IP gets 429 until the window has passed
 * since its last failure. In memory: cloud-control runs one replica
 * (railway.json); a restart clears it, which a 128-bit token makes harmless.
 * The table is bounded so a scan from many addresses cannot grow it forever.
 */
export class FailureLimiter {
  readonly #entries = new Map<string, { count: number; last: number }>();
  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}

  /** Milliseconds until the key may try again, or 0 if it is not locked. */
  lockedFor(key: string): number {
    const e = this.#entries.get(key);
    if (!e) return 0;
    const age = this.now() - e.last;
    if (age >= this.windowMs) {
      this.#entries.delete(key);
      return 0;
    }
    return e.count >= this.maxFailures ? this.windowMs - age : 0;
  }

  /** Record a failure; returns the new count inside the window. */
  fail(key: string): number {
    const t = this.now();
    const e = this.#entries.get(key);
    const count = e && t - e.last < this.windowMs ? e.count + 1 : 1;
    this.#entries.delete(key);
    this.#entries.set(key, { count, last: t });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
    return count;
  }

  succeed(key: string): void {
    this.#entries.delete(key);
  }
}

export type RefusalReason = "private_network" | "ip_not_allowed" | "bad_bearer" | "locked_out";

export interface Refusal {
  reason: RefusalReason;
  ip: string | null;
  socketIp: string | null;
  method: string;
  path: string;
  failures?: number;
}

export interface RequireAdminOptions {
  /** Called for each refusal that should be audited. Must not throw. */
  onRefused?: (r: Refusal) => void | Promise<void>;
  limiter?: FailureLimiter;
  /**
   * Cap on audited refusals per minute across all callers, so a scan from
   * many addresses cannot turn the audit table into a write amplifier.
   * Refusals past the cap are still logged, just not written to the table.
   */
  maxAuditsPerMinute?: number;
  now?: () => number;
}

export function requireAdmin(config: CloudConfig, log: Logger, opts: RequireAdminOptions = {}): RequestHandler {
  const limiter = opts.limiter ?? new FailureLimiter(config.adminMaxFailures, config.adminLockoutMs);
  const now = opts.now ?? Date.now;
  const cap = opts.maxAuditsPerMinute ?? 60;
  let windowStart = now();
  let written = 0;
  const audit = (r: Refusal) => {
    if (!opts.onRefused) return;
    if (now() - windowStart >= 60_000) {
      windowStart = now();
      written = 0;
    }
    if (written >= cap) {
      if (written === cap) log.warn("admin refusal audit cap reached; further refusals this minute are logged only");
      written += 1;
      return;
    }
    written += 1;
    void Promise.resolve()
      .then(() => opts.onRefused!(r))
      .catch((err: unknown) => log.error("admin refusal audit failed", { err }));
  };
  return (req: Request, res: Response, next: NextFunction) => {
    const sock = socketIp(req);
    const base = { socketIp: sock, method: req.method, path: req.path };

    if (fromPrivateNetwork(req, config)) {
      // Not counted against the limiter: X-Real-IP is forged here, so it is
      // no key at all. The socket address is logged so an operator can see
      // what reached the service.
      log.warn("admin request refused: X-Real-IP from the private network", { socketIp: sock, path: req.path });
      audit({ reason: "private_network", ip: null, ...base });
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const ip = clientIp(req, config.clientIpSource);
    const key = ip ?? `socket:${sock ?? "unknown"}`;
    const wait = limiter.lockedFor(key);
    if (wait > 0) {
      res.setHeader("retry-after", String(Math.ceil(wait / 1000)));
      res.status(429).json({ error: "too many failed attempts" });
      return;
    }

    const allowed = ip !== null && inList(config.adminAllowList, ip);
    if (!allowed) {
      const failures = limiter.fail(key);
      log.warn("admin request refused: ip not allowed", { ip, socketIp: sock, path: req.path });
      audit({ reason: failures >= config.adminMaxFailures ? "locked_out" : "ip_not_allowed", ip, failures, ...base });
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !constantTimeEqual(match[1]!.trim(), config.adminToken.reveal())) {
      const failures = limiter.fail(key);
      log.warn("admin request refused: bad bearer", { ip, path: req.path, failures });
      audit({ reason: failures >= config.adminMaxFailures ? "locked_out" : "bad_bearer", ip, failures, ...base });
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    limiter.succeed(key);
    res.locals.adminIp = ip;
    next();
  };
}
