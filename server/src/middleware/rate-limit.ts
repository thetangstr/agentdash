/**
 * AgentDash: tiered API rate limiting (#160)
 *
 * Four tiers:
 *  - Auth  (/api/auth/*):           10 req / 15 min  — brute-force / credential-stuffing
 *  - Billing mutations:             20 req / 15 min  — abuse / billing-fraud
 *  - Onboarding invites:            20 req / 15 min  — Resend cost amplification
 *  - Default (/api/*):             200 req / 15 min  — generous ceiling for legit usage
 *
 * Env-var overrides:
 *  AGENTDASH_RATE_LIMIT_AUTH_MAX    (default 10)
 *  AGENTDASH_RATE_LIMIT_BILLING_MAX (default 20)
 *  AGENTDASH_RATE_LIMIT_INVITE_MAX  (default 20)
 *  AGENTDASH_RATE_LIMIT_API_MAX     (default 200)
 *  AGENTDASH_RATE_LIMIT_DISABLED=true  — no-op middleware (tests / dev)
 */

import { rateLimit, type Options as RateLimitOptions } from "express-rate-limit";
import type { Request, Response, NextFunction, RequestHandler } from "express";

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function isDisabled(): boolean {
  return (
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

export function createAuthRateLimiter(): RequestHandler {
  if (isDisabled()) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_AUTH_MAX", 10));
}

export function createBillingRateLimiter(): RequestHandler {
  if (isDisabled()) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_BILLING_MAX", 20));
}

export function createDefaultApiRateLimiter(): RequestHandler {
  if (isDisabled()) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_API_MAX", 200));
}

/**
 * Tighter limit for the onboarding invite endpoint. Each request can
 * batch up to MAX_INVITE_BATCH (25) emails, each of which fans out to
 * a Resend API call — so 20 req / 15 min × 25 = 500 emails per actor
 * per quarter-hour. That's well above any legit "invite my team" flow
 * but caps the cost-amplification window if a token is abused.
 */
export function createInviteRateLimiter(): RequestHandler {
  if (isDisabled()) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_INVITE_MAX", 20));
}
