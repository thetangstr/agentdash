import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { sendEmail, resetPasswordEmailTemplate, welcomeEmailTemplate } from "./email.js";
import { logger } from "../middleware/logger.js";

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthInstance = ReturnType<typeof betterAuth>;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

export interface CreateBetterAuthInstanceOptions {
  /**
   * Fires after Better Auth has fully written a new user row. Used to
   * bootstrap a workspace + CoS agent + conversation for them so the
   * SPA's CloudAccessGate (which checks for ≥1 company membership)
   * doesn't block them at "No company access". Errors here are caught
   * by the caller and logged — sign-up still completes, the user just
   * has to retry workspace bootstrap manually.
   */
  onUserCreated?: (user: { id: string; email: string; name: string | null }) => Promise<void>;
}

export function createBetterAuthInstance(
  db: Db,
  config: Config,
  trustedOrigins: string[],
  opts?: CreateBetterAuthInstanceOptions,
): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL ?? baseUrl;
  const isHttpOnly = publicUrl ? publicUrl.startsWith("http://") : false;

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
      // Better Auth 1.4.x fires this from POST /api/auth/request-password-reset
      // (not /forget-password — that was the 1.3.x path). It hands us:
      //   user  — the row to email
      //   url   — `${baseURL}/reset-password/${token}?callbackURL=…`
      //           (an API endpoint that validates the token and 302s)
      //   token — the raw token, suitable for the SPA route
      //
      // We deep-link straight to the SPA's /reset-password?token=…
      // route and skip the redirect. That keeps the email URL on the
      // user's own origin and matches what ui/src/pages/ResetPassword.tsx
      // reads from the query string.
      sendResetPassword: async ({ user, token }: { user: { email: string }; token: string }) => {
        const appUrl = derivePublicAppUrl(publicUrl) ?? "http://localhost:3100";
        const resetUrl = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
        const { subject, html, text } = resetPasswordEmailTemplate({ resetUrl });
        await sendEmail({ to: user.email, subject, html, text });
      },
    },
    // Welcome email after a fresh sign-up. We hook the user create
    // event so we don't need a separate verification flow — the user
    // is already authenticated when this fires, and the email is just
    // a nice-to-have.
    databaseHooks: {
      user: {
        create: {
          after: async (user: { id: string; email: string; name: string | null }) => {
            // Two independent best-effort steps. Either failing must NOT
            // abort the user-create transaction — the account is already
            // committed by the time this runs, so all we'd do is leave a
            // user without a welcome email or without a workspace.
            // Bootstrap before email so a slow Resend call doesn't delay
            // the workspace becoming visible to the SPA.
            try {
              if (opts?.onUserCreated) {
                await opts.onUserCreated(user);
              }
            } catch (err) {
              logger.warn(
                { userId: user.id, error: err instanceof Error ? err.message : String(err) },
                "[auth] onUserCreated hook failed — user signed up without a workspace",
              );
            }
            try {
              const appUrl = derivePublicAppUrl(publicUrl) ?? "http://localhost:3100";
              const { subject, html, text } = welcomeEmailTemplate({
                name: user.name,
                appUrl,
              });
              await sendEmail({ to: user.email, subject, html, text });
            } catch (err) {
              logger.warn(
                { error: err instanceof Error ? err.message : String(err) },
                "[email] welcome email hook failed",
              );
            }
          },
        },
      },
    },
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies: isHttpOnly }),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

/**
 * Better Auth's `baseURL` points at the auth API root (typically the
 * same origin the SPA serves from). We send users to the SPA's reset
 * page, not the auth API, so the React route can POST back to
 * /api/auth/reset-password with the token. Strip any /api suffix and
 * fall back to localhost when no public URL is configured.
 */
function derivePublicAppUrl(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  const trimmed = publicUrl.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/api$/, "");
}

export function createBetterAuthHandler(auth: BetterAuthInstance): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthInstance,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = (auth as unknown as { api?: { getSession?: (input: unknown) => Promise<unknown> } }).api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthInstance,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
