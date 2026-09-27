// AgentDash (#766, SC-5): a hosted box behind the edge router (self-serve
// cloud spec §4.4).
//
// The router (SC-4) forwards every request for https://<slug>.agentdash.cloud
// to the box's Railway domain with two headers:
//   X-AgentDash-Edge       the box's own edge secret (AGENTDASH_EDGE_SECRET)
//   X-AgentDash-Client-IP  the visitor's address
// Railway's edge passes custom headers from ANY caller who uses the Railway
// host directly (measured, SC-0 spike §3.1), so with the secret set:
//   - every request whose X-AgentDash-Edge does not match (constant time) is
//     refused with 403, except GET/HEAD /api/health (the control plane's
//     monitoring and the provisioner's health check use the Railway host);
//   - X-AgentDash-Client-IP becomes req.ip only when the edge header
//     matched, so rate limits key on real visitors, not on the router; a
//     forged client IP without the secret is ignored;
//   - the edge header is removed from the request before anything else
//     (logging included) can see it.
// With AGENTDASH_EDGE_SECRET unset nothing here runs: local dev, on-prem and
// self-hosted installs behave exactly as before.
//
// Rotation (#807 review): AGENTDASH_EDGE_SECRET_PREVIOUS is accepted as well,
// so a new secret can reach the router and the box in either order.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { Request, RequestHandler } from "express";

export const EDGE_SECRET_HEADER = "x-agentdash-edge";
export const EDGE_CLIENT_IP_HEADER = "x-agentdash-client-ip";
export const MIN_EDGE_SECRET_LENGTH = 32;

type Env = NodeJS.ProcessEnv;

export function configuredEdgeSecret(env: Env = process.env): string | null {
  const v = (env.AGENTDASH_EDGE_SECRET ?? "").trim();
  return v.length > 0 ? v : null;
}

/** The secrets a request may carry: the current one, then the previous one during a rotation. */
export function configuredEdgeSecrets(env: Env = process.env): string[] {
  const current = configuredEdgeSecret(env);
  if (!current) return [];
  const previous = (env.AGENTDASH_EDGE_SECRET_PREVIOUS ?? "").trim();
  return previous && previous !== current ? [current, previous] : [current];
}

/** True when the presented header matches any accepted secret (each compared in constant time). */
export function edgeHeaderMatchesAny(presented: string | string[] | undefined, secrets: string[]): boolean {
  let ok = false;
  for (const s of secrets) ok = edgeHeaderMatches(presented, s) || ok;
  return ok;
}

function headerValue(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Constant-time comparison of the presented edge header with the secret (fixed-length digests). */
export function edgeHeaderMatches(presented: string | string[] | undefined, secret: string): boolean {
  const value = headerValue(presented);
  if (value === null) return false;
  const a = createHash("sha256").update(value, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(a, b) && value.length === secret.length;
}

/** Requests allowed without the edge header: the health check only. */
export function isEdgeExempt(method: string | undefined, path: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  const p = path.split("?")[0]!.replace(/\/+$/, "");
  return (m === "GET" || m === "HEAD") && p === "/api/health";
}

/** The client address the router reported, when it is a valid IP. */
export function edgeClientIp(raw: string | string[] | undefined): string | null {
  const value = headerValue(raw)?.trim() ?? null;
  if (!value) return null;
  const v = value.startsWith("::ffff:") && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
  return isIP(v) ? v : null;
}

/**
 * Whether a WebSocket upgrade may proceed (live events use `ws`, outside
 * Express). The health exemption does not apply: an upgrade is never health.
 */
export function edgeUpgradeAllowed(req: IncomingMessage, env: Env = process.env): boolean {
  const secrets = configuredEdgeSecrets(env);
  if (!secrets.length) return true;
  const ok = edgeHeaderMatchesAny(req.headers[EDGE_SECRET_HEADER], secrets);
  delete req.headers[EDGE_SECRET_HEADER];
  return ok;
}

export function edgeGate(opts: { secret: string | null; previous?: string | null }): RequestHandler {
  const secrets = [opts.secret, opts.previous].filter((s): s is string => typeof s === "string" && s.length > 0);
  return (req: Request, res, next) => {
    if (!secrets.length) return next();
    const matched = edgeHeaderMatchesAny(req.headers[EDGE_SECRET_HEADER], secrets);
    // Never let the secret reach a logger, a handler or an error report.
    delete req.headers[EDGE_SECRET_HEADER];
    if (!matched) {
      // A forged client address is ignored, not trusted.
      delete req.headers[EDGE_CLIENT_IP_HEADER];
      if (isEdgeExempt(req.method, req.originalUrl ?? req.url)) return next();
      res.status(403).json({
        code: "edge_required",
        error: "This workspace is only reachable at its public address.",
      });
      return;
    }
    const clientIp = edgeClientIp(req.headers[EDGE_CLIENT_IP_HEADER]);
    // Better Auth's own limiter reads this header (ipAddressHeaders); keep it only when it is a valid IP.
    if (!clientIp) delete req.headers[EDGE_CLIENT_IP_HEADER];
    if (clientIp) {
      // Shadow Express's req.ip getter for this request, so every consumer
      // (each rate limiter, the trial's ip hash) sees the visitor.
      Object.defineProperty(req, "ip", { value: clientIp, configurable: true, enumerable: true, writable: false });
    }
    next();
  };
}
