// AgentDash: MCP-native signup — claim a FRESH authenticated-mode install
// entirely through the MCP server, no browser signup form.
//
// POST /api/onboarding/mcp-signup is UNAUTHENTICATED but hard-gated:
//   1. deploymentMode must be "authenticated" (local_trusted has no signup).
//   2. AGENTDASH_SELF_SERVE_BOOTSTRAP must be "true" (same env flag that
//      gates the browser self-serve bootstrap in routes/companies.ts).
//   3. Founding-only, strictly: ZERO instance_admin roles AND ZERO auth
//      users. The instant any user exists the endpoint returns 409 forever.
//   4. The tighter auth-tier rate limiter (createAuthRateLimiter) applies.
//
// Flow: crypto-random throwaway password → Better Auth signUpEmail (threaded
// in from server/src/index.ts where the auth instance lives) → mint a board
// API key for the new user (same insert shape as the CLI approve flow in
// services/board-auth.ts) → promote to instance_admin → respond ONCE with
// the plaintext key. The password is never logged and never returned; the
// user sets a browser password later via "Forgot password".
//
// Why promotion happens HERE and not later: the browser flow promotes the
// first user inside POST /api/companies (routes/companies.ts self-serve
// bootstrap block), but the MCP journey creates its company via
// POST /api/onboarding/bootstrap → onboardingOrchestrator.bootstrap(), which
// does NOT run that promotion. Without promoting at signup the founding MCP
// user would never become instance admin. promoteFirstInstanceAdmin
// serializes under an advisory lock and re-checks the admin count, so at
// most one caller ever wins even under a race.

import { randomBytes } from "node:crypto";
import { Router } from "express";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { authUsers, boardApiKeys, instanceUserRoles } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import { createAuthRateLimiter } from "../middleware/rate-limit.js";
import { logger } from "../middleware/logger.js";
import { accessService } from "../services/index.js";
import {
  boardApiKeyExpiresAt,
  createBoardApiToken,
  hashBearerToken,
} from "../services/board-auth.js";

/**
 * Server-side user creation, threaded in from server/src/index.ts where the
 * Better Auth instance exists (auth.api.signUpEmail). Optional so buildApp
 * stays backward-compatible for tests / local_trusted deployments that never
 * construct an auth instance.
 */
export type McpSignupCreateUser = (input: {
  name: string;
  email: string;
  password: string;
}) => Promise<{ userId: string | null }>;

/**
 * Captures a one-time password-reset URL for the just-created founding user,
 * so MCP signup can return a browser-login link the agent hands the customer —
 * no email in the critical path. Threaded in from server/src/index.ts where the
 * Better Auth instance lives. Optional: when absent (or when it returns null)
 * the response falls back to the text "Forgot password" hint.
 */
export type McpSignupCaptureResetUrl = (email: string) => Promise<string | null>;

export interface McpSignupRoutesOptions {
  deploymentMode: DeploymentMode;
  createUser?: McpSignupCreateUser;
  captureResetUrl?: McpSignupCaptureResetUrl;
}

const mcpSignupBodySchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(120),
  inviteCode: z.string().trim().min(1).max(120).optional(),
});

// AgentDash: invite-code funnel gate. Self-serve signup phones home to the
// AgentDash cloud to validate an invite code before the founding user is
// created — handing out codes controls who can claim instances through our
// funnel (the code is open source; this is funnel control, not DRM).
// Escape hatch for dev / CI / airgapped installs: AGENTDASH_INVITE_VALIDATION=off.
const DEFAULT_INVITE_VALIDATION_URL = "https://www.agentdash.cloud/api/invites/validate";

function isInviteValidationEnabled(): boolean {
  return process.env.AGENTDASH_INVITE_VALIDATION !== "off";
}

function inviteValidationUrl(): string {
  return process.env.AGENTDASH_INVITE_VALIDATION_URL || DEFAULT_INVITE_VALIDATION_URL;
}

type InviteCheck = { ok: true } | { ok: false; status: number; code: string; error: string };

async function checkInviteCode(inviteCode: string | undefined): Promise<InviteCheck> {
  if (!isInviteValidationEnabled()) return { ok: true };
  if (!inviteCode) {
    return {
      ok: false,
      status: 403,
      code: "invite_code_required",
      error:
        "This install requires an invite code to sign up. Ask the human for their "
        + "AgentDash invite code and retry with { inviteCode }. Codes come from the "
        + "AgentDash team (https://www.agentdash.cloud).",
    };
  }
  try {
    const resp = await fetch(inviteValidationUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: inviteCode }),
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) throw new Error(`validation endpoint returned ${resp.status}`);
    const body = (await resp.json()) as { valid?: unknown };
    if (body.valid === true) return { ok: true };
    return {
      ok: false,
      status: 403,
      code: "invalid_invite_code",
      error: "The invite code is not valid. Check for typos or request a code from the AgentDash team.",
    };
  } catch (err) {
    logger.warn({ err }, "invite-code validation unreachable — failing closed");
    return {
      ok: false,
      status: 503,
      code: "invite_validation_unavailable",
      error:
        "Could not reach the invite validation service; signup is blocked (fail-closed). "
        + "Retry shortly. Airgapped/dev installs may set AGENTDASH_INVITE_VALIDATION=off.",
    };
  }
}

export const MCP_SIGNUP_PASSWORD_SETUP_HINT =
  "Use 'Forgot password' on the web UI with this email to set a browser password later.";

function isSelfServeBootstrapEnabled(): boolean {
  return process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP === "true";
}

export function onboardingMcpSignupRoutes(db: Db, opts: McpSignupRoutesOptions) {
  const router = Router();
  const access = accessService(db);

  router.post(
    "/mcp-signup",
    // AgentDash (#160): signup is a brute-force / abuse vector — apply the
    // tight auth-tier limiter (10 req / 15 min), same as /api/auth/*.
    createAuthRateLimiter({ deploymentMode: opts.deploymentMode }),
    async (req, res) => {
      if (opts.deploymentMode !== "authenticated") {
        res.status(403).json({
          code: "mcp_signup_requires_authenticated_mode",
          error:
            "MCP signup is only available on authenticated deployments. "
            + "local_trusted installs already have an implicit founding user.",
        });
        return;
      }
      if (!isSelfServeBootstrapEnabled()) {
        res.status(403).json({
          code: "self_serve_bootstrap_disabled",
          error:
            "Self-serve bootstrap is disabled on this instance. "
            + "Set AGENTDASH_SELF_SERVE_BOOTSTRAP=true to allow the founding user to sign up via MCP.",
        });
        return;
      }
      if (!opts.createUser) {
        res.status(503).json({
          code: "auth_not_ready",
          error: "The auth subsystem is not initialized; MCP signup is unavailable.",
        });
        return;
      }

      const parsed = mcpSignupBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code: "invalid_body",
          error: "Body must be { email: valid email, name: 1-120 chars }.",
          details: parsed.error.flatten(),
        });
        return;
      }
      const { email, name, inviteCode } = parsed.data;

      // Invite-code funnel gate BEFORE any user creation. Fail-closed on
      // transport errors; AGENTDASH_INVITE_VALIDATION=off disables entirely.
      const invite = await checkInviteCode(inviteCode);
      if (!invite.ok) {
        res.status(invite.status).json({ code: invite.code, error: invite.error });
        return;
      }

      // Founding-only gate, strict on BOTH counts: the same instance_admin
      // predicate health.ts uses for bootstrapStatus, AND zero auth users —
      // so a signed-up-but-not-yet-promoted user still closes the door.
      const [adminCount, userCount] = await Promise.all([
        db
          .select({ count: count() })
          .from(instanceUserRoles)
          .where(eq(instanceUserRoles.role, "instance_admin"))
          .then((rows) => Number(rows[0]?.count ?? 0)),
        db
          .select({ count: count() })
          .from(authUsers)
          .then((rows) => Number(rows[0]?.count ?? 0)),
      ]);
      if (adminCount > 0 || userCount > 0) {
        res.status(409).json({
          code: "instance_already_claimed",
          error:
            "This instance already has a user. MCP signup only works on a fresh install. "
            + "Sign in with an existing account instead.",
        });
        return;
      }

      // Crypto-random 32-byte throwaway password. Never logged, never
      // returned — the founding user authenticates with the board API key
      // and can set a real browser password via "Forgot password".
      const password = randomBytes(32).toString("hex");

      let userId: string | null = null;
      try {
        ({ userId } = await opts.createUser({ name, email, password }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "sign-up failed";
        logger.warn({ email, error: message }, "[mcp-signup] user creation failed");
        res.status(400).json({ code: "signup_failed", error: message });
        return;
      }

      if (!userId) {
        // Defensive fallback: some auth-layer versions return a thinner
        // payload — resolve the freshly created row by email.
        userId = await db
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.email, email))
          .then((rows) => rows[0]?.id ?? null);
      }
      if (!userId) {
        res.status(500).json({
          code: "signup_user_missing",
          error: "Sign-up completed but the new user row could not be resolved.",
        });
        return;
      }

      // Mint the board API key — same columns as the CLI approve flow
      // (services/board-auth.ts approveCliAuthChallenge insert).
      const apiKey = createBoardApiToken();
      const expiresAt = boardApiKeyExpiresAt();
      await db.insert(boardApiKeys).values({
        userId,
        name: "MCP signup (founding user)",
        keyHash: hashBearerToken(apiKey),
        expiresAt,
      });

      // Promote to instance_admin (see the header comment for why the
      // /onboarding/bootstrap path can't do it later).
      const promoted = await access.promoteFirstInstanceAdmin(userId);

      // Audit entry. activity_log.company_id is NOT NULL with an FK to
      // companies, and no company exists at signup time, so a DB activity
      // row is structurally impossible here — emit the same fields as the
      // "instance.admin_self_serve_bootstrap" logActivity call in
      // routes/companies.ts through the structured server log instead.
      logger.info(
        {
          action: "instance.mcp_signup",
          actorType: "user",
          actorId: userId,
          entityType: "instance",
          entityId: userId,
          details: { email, promotedToInstanceAdmin: promoted },
        },
        "[mcp-signup] founding user signed up via MCP",
      );

      // AgentDash (MCP-native first login): capture a one-time reset URL so the
      // founding user sets a browser password by clicking a link the agent
      // hands them — no Resend dependency. Falls back to the text hint when
      // capture isn't wired, times out, or throws.
      let passwordSetupUrl: string | null = null;
      if (opts.captureResetUrl) {
        try {
          passwordSetupUrl = await opts.captureResetUrl(email);
        } catch (err) {
          logger.warn(
            { email, error: err instanceof Error ? err.message : String(err) },
            "[mcp-signup] captureResetUrl failed; falling back to the text hint",
          );
        }
      }

      res.status(201).json({
        userId,
        email,
        name,
        apiKey,
        apiKeyExpiresAt: expiresAt.toISOString(),
        passwordSetupUrl,
        passwordSetup: passwordSetupUrl
          ? "Open this one-time link to set your browser password (expires in ~1 hour):"
          : MCP_SIGNUP_PASSWORD_SETUP_HINT,
      });
    },
  );

  return router;
}
