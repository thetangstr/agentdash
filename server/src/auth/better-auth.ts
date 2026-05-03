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

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins: string[]): BetterAuthInstance {
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
      // Better Auth fires this when the user requests a password reset
      // via /api/auth/forget-password. The `url` it builds points at
      // /api/auth/reset-password?token=… on the auth server itself.
      // We rewrite it to /reset-password?token=… so the SPA's reset
      // page handles the token; that page POSTs back to /api/auth.
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        const appUrl = derivePublicAppUrl(publicUrl);
        const resetUrl = appUrl
          ? `${appUrl}/reset-password?${extractQuery(url)}`
          : url; // fallback: use whatever Better Auth built
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
          after: async (user: { email: string; name: string | null }) => {
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

/**
 * Extract just the query string from a Better Auth-generated URL so we
 * can re-attach it to the SPA route. Better Auth produces URLs like
 * `https://host/api/auth/reset-password?token=…`; we want just
 * `token=…` to hand off to /reset-password on the SPA.
 */
function extractQuery(url: string): string {
  const idx = url.indexOf("?");
  return idx >= 0 ? url.slice(idx + 1) : "";
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
