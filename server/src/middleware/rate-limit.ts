/**
 * AgentDash: tiered API rate limiting (#160)
 *
 * Four tiers:
 *  - Auth  (/api/auth/* mutations): 10 req / 15 min  — brute-force / credential-stuffing
 *  - Billing mutations:             20 req / 15 min  — abuse / billing-fraud
 *  - Onboarding invites:            20 req / 15 min  — Resend cost amplification
 *  - Default (/api/* mutations):   200 req / 15 min  — abuse ceiling for state-changing calls
 *
 * Env-var overrides:
 *  AGENTDASH_RATE_LIMIT_AUTH_MAX    (default 10)
 *  AGENTDASH_RATE_LIMIT_BILLING_MAX (default 20)
 *  AGENTDASH_RATE_LIMIT_INVITE_MAX  (default 20)
 *  AGENTDASH_RATE_LIMIT_API_MAX     (default 200)
 *  AGENTDASH_RATE_LIMIT_DISABLED=true  — no-op middleware (tests / dev)
 *
 * Local trusted deployments are loopback/private developer instances, so they
 * also use no-op middleware by default. Authenticated deployments still keep
 * the protection unless the explicit env override is set. The default limiter
 * skips health checks and authenticated read polling so normal dashboard use
 * does not exhaust the mutation/abuse quota.
 */

import { rateLimit, type Options as RateLimitOptions } from "express-rate-limit";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { DeploymentMode } from "@paperclipai/shared";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface RateLimiterFactoryOptions {
  deploymentMode?: DeploymentMode;
}

function isDisabled(opts: RateLimiterFactoryOptions = {}): boolean {
  return (
    opts.deploymentMode === "local_trusted" ||
    process.env.AGENTDASH_RATE_LIMIT_DISABLED === "true" ||
    process.env.NODE_ENV === "test"
  );
}

function parseEnvInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Key generator: prefer authenticated actor identity over IP address.
 * This avoids false-positives for users behind NAT / corporate proxies.
 */
function keyGenerator(req: Request): string {
  const actor = (req as any).actor;
  if (actor?.userId) return `user:${actor.userId}`;
  if (actor?.agentId) return `agent:${actor.agentId}`;
  // Fallback to IP — express sets req.ip
  return `ip:${req.ip ?? "unknown"}`;
}

function makeHandler(max: number, extraOpts?: Partial<RateLimitOptions>): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: "draft-7", // Retry-After + RateLimit-* headers
    legacyHeaders: false,
    keyGenerator,
    handler(_req: Request, res: Response) {
      const retryAfter = Math.ceil(WINDOW_MS / 1000);
      res
        .status(429)
        .set("Retry-After", String(retryAfter))
        .json({ error: "Rate limited", retryAfter });
    },
    ...extraOpts,
  });
}

/** No-op pass-through used when rate limiting is disabled. */
function noopMiddleware(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

function hasAuthenticatedActor(req: Request): boolean {
  const actor = (req as any).actor;
  return actor?.type === "board" || actor?.type === "agent";
}

function isSafeReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function isPreflightMethod(method: string): boolean {
  return method === "OPTIONS";
}

function isHealthPath(req: Request): boolean {
  return req.path === "/health" || req.path === "/health/";
}

export function createAuthRateLimiter(opts: RateLimiterFactoryOptions = {}): RequestHandler {
  if (isDisabled(opts)) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_AUTH_MAX", 10), {
    skip(req) {
      return isSafeReadMethod(req.method) || isPreflightMethod(req.method);
    },
  });
}

export function createBillingRateLimiter(opts: RateLimiterFactoryOptions = {}): RequestHandler {
  if (isDisabled(opts)) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_BILLING_MAX", 20));
}

export function createDefaultApiRateLimiter(opts: RateLimiterFactoryOptions = {}): RequestHandler {
  if (isDisabled(opts)) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_API_MAX", 200), {
    skip(req) {
      if (isHealthPath(req)) return true;
      if (isPreflightMethod(req.method)) return true;
      return isSafeReadMethod(req.method) && hasAuthenticatedActor(req);
    },
  });
}

/**
 * Tighter limit for the onboarding invite endpoint. Each request can
 * batch up to MAX_INVITE_BATCH (25) emails, each of which fans out to
 * a Resend API call — so 20 req / 15 min × 25 = 500 emails per actor
 * per quarter-hour. That's well above any legit "invite my team" flow
 * but caps the cost-amplification window if a token is abused.
 */
export function createInviteRateLimiter(opts: RateLimiterFactoryOptions = {}): RequestHandler {
  if (isDisabled(opts)) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_INVITE_MAX", 20));
}
