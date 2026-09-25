// AgentDash: SSO — Google + Microsoft social sign-in for Better Auth.
//
// Providers are enabled ONLY when their credentials are present in the
// environment, so the buttons can be merged now and flipped on later by
// adding env vars (no code change). We never pass a provider with empty
// credentials to Better Auth, and we never leak the secrets — the public
// surface (`getConfiguredSocialProviders`) returns booleans only.

import { isHostedBox } from "../services/license.js";

type Env = Record<string, string | undefined>;

const DEFAULT_MICROSOFT_TENANT = "common";

/** Microsoft tenants that admit accounts from any organisation or none. */
export const MULTI_TENANT_MICROSOFT_TENANTS: readonly string[] = ["common", "organizations", "consumers"];

/** The Microsoft tenant Better Auth is configured with, defaulting like `buildSocialProviders`. */
export function configuredMicrosoftTenant(env: Env = process.env): string {
  return present(env.MICROSOFT_TENANT_ID) ? env.MICROSOFT_TENANT_ID.trim() : DEFAULT_MICROSOFT_TENANT;
}

/**
 * AgentDash (#726): whether Google or Microsoft sign-in may CREATE an account.
 *
 * Off on hosted boxes. Neither sign-up gate sees SSO: the invite-code guard
 * only runs on `/api/auth/sign-up/*`, and `PAPERCLIP_AUTH_DISABLE_SIGN_UP`
 * only covers email. Microsoft defaults to tenant `common`, so any Microsoft
 * account could create a user, and with self-serve bootstrap the first one to
 * create a company becomes instance admin. There is no company-invite token to
 * carry through the OAuth round trip yet (#731), so on a hosted box SSO signs
 * in people who already have an account and creates nobody. Everywhere else
 * behaviour is unchanged.
 */
export function ssoAccountCreationAllowed(env: Env = process.env): boolean {
  return !isHostedBox(env as NodeJS.ProcessEnv);
}

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Public-safe view of which social providers are wired up. Returns booleans
 * only — never the client ids/secrets — so it can be served to an
 * unauthenticated client that needs to decide whether to render a button.
 */
export function getConfiguredSocialProviders(
  env: Env = process.env,
): { google: boolean; microsoft: boolean } {
  return {
    google: present(env.GOOGLE_CLIENT_ID) && present(env.GOOGLE_CLIENT_SECRET),
    microsoft: present(env.MICROSOFT_CLIENT_ID) && present(env.MICROSOFT_CLIENT_SECRET),
  };
}

/**
 * Build the Better Auth `socialProviders` config object, including only the
 * providers whose credentials are present. Callback URLs use Better Auth's
 * defaults: `/api/auth/callback/google` and `/api/auth/callback/microsoft`.
 */
export function buildSocialProviders(env: Env = process.env): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  // AgentDash (#726): Better Auth's own switch for "sign in existing users
  // only". The OAuth callback honours it; the id-token sign-in path does not
  // read it in 1.6.x, so better-auth.ts also refuses the user row itself.
  const signUpOptions = ssoAccountCreationAllowed(env) ? {} : { disableSignUp: true };

  if (present(env.GOOGLE_CLIENT_ID) && present(env.GOOGLE_CLIENT_SECRET)) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID.trim(),
      clientSecret: env.GOOGLE_CLIENT_SECRET.trim(),
      ...signUpOptions,
    };
  }

  if (present(env.MICROSOFT_CLIENT_ID) && present(env.MICROSOFT_CLIENT_SECRET)) {
    providers.microsoft = {
      clientId: env.MICROSOFT_CLIENT_ID.trim(),
      clientSecret: env.MICROSOFT_CLIENT_SECRET.trim(),
      tenantId: configuredMicrosoftTenant(env),
      ...signUpOptions,
    };
  }

  return providers;
}
