/**
 * AgentDash: tiered API rate limiting (#160)
 *
 * Four tiers:
 *  - Auth  (/api/auth/* mutations): 10 req / 15 min  — brute-force / credential-stuffing
 *  - Billing mutations:             20 req / 15 min  — abuse / billing-fraud
 *  - Onboarding invites:            20 req / 15 min  — Resend cost amplification
 *  - Anonymous trial entry points:  30 req / 15 min  — inference cost amplification
 *  - Default (/api/* mutations):   200 req / 15 min  — abuse ceiling for state-changing calls
 *
 * Env-var overrides:
 *  AGENTDASH_RATE_LIMIT_AUTH_MAX    (default 10)
 *  AGENTDASH_RATE_LIMIT_BILLING_MAX (default 20)
 *  AGENTDASH_RATE_LIMIT_INVITE_MAX  (default 20)
 *  AGENTDASH_RATE_LIMIT_TRIAL_MAX   (default 30)
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

/**
 * The bridge worker's poll for queued work.
 *
 * A POST by verb but a read by intent: it asks "is there anything for me?" and
 * changes nothing when the answer is no. It is also on a fixed timer, so it is
 * self-limiting in a way user traffic is not.
 *
 * It must be skipped, because the arithmetic does not work otherwise. The
 * worker polls every 5 seconds — 180 requests per 15-minute window — against a
 * 200-request budget shared with everything else that actor does. A laptop
 * simply being connected consumed 90% of its own rate limit, and anything real
 * (creating issues, answering fact requests, running a pipeline) tipped it into
 * 429s. That is the "connection bumps all the time" symptom: the bridge gets
 * rate limited, the poll fails, the worker looks disconnected.
 *
 * Skipping does not remove the ceiling that matters. /bridge/result and
 * /bridge/decline — the calls that actually write — stay limited, as does every
 * other mutation.
 */
function isBridgePollPath(req: Request): boolean {
  return req.path === "/bridge/poll";
}

/**
 * An enrolled bridge endpoint, polling.
 *
 * Checked by `source`, not by `type`, and that distinction is the whole bug
 * this replaced. A bridge credential is deliberately given `type: "none"` in
 * auth.ts so it cannot pass any ordinary guard by accident — good design, and
 * it meant `hasAuthenticatedActor` (which accepts only `board` and `agent`)
 * was false for every real bridge client. The exemption below therefore never
 * fired for the one population it was written for: a laptop polling every five
 * seconds still spent its whole budget and still got 429s.
 *
 * Confirmed against a live server before and after: 220 polls returned 76
 * `429`s with the type check, and none with this one.
 *
 * Still not open to anonymous callers — an endpoint id is only present after
 * the token has been verified and matched to an enrolled, approved endpoint.
 */
function isEnrolledBridgeEndpoint(req: Request): boolean {
  const actor = (req as { actor?: { source?: string; bridgeEndpointId?: string } }).actor;
  return actor?.source === "bridge_endpoint" && typeof actor?.bridgeEndpointId === "string";
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
      if (isBridgePollPath(req) && isEnrolledBridgeEndpoint(req)) return true;
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

/**
 * Tighter cap on user-filed bug reports and feature requests. Every POST
 * creates a real GitHub issue under one shared credential, so an abused
 * session could otherwise flood the team's queue (and burn the token's
 * secondary rate limit for everyone else). 10 / 15 min per actor is far
 * above anyone genuinely reporting problems.
 */
export function createIssueReportRateLimiter(opts: RateLimiterFactoryOptions = {}): RequestHandler {
  if (isDisabled(opts)) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_ISSUE_REPORT_MAX", 10), {
    skip(req) {
      return isSafeReadMethod(req.method) || isPreflightMethod(req.method);
    },
  });
}

/**
 * Tighter request-layer cap for the anonymous Test Drive trial. Each POST
 * /trial/session mints a fresh credit and each /trial/:token/design kicks off a
 * multi-agent MiniMax build, so these are cost-amplifying entry points. The
 * trial is anonymous (no actor), so keyGenerator falls back to req.ip — which is
 * the real client IP only when `trust proxy` is set (see app.ts). This bounds
 * rapid session/build creation per IP at the request layer, complementing the
 * per-IP/day and global-spend caps enforced in trialService.
 */
export function createTrialRateLimiter(opts: RateLimiterFactoryOptions = {}): RequestHandler {
  if (isDisabled(opts)) return noopMiddleware;
  return makeHandler(parseEnvInt("AGENTDASH_RATE_LIMIT_TRIAL_MAX", 30));
}
