// AgentDash: SSO — Google + Microsoft social sign-in for Better Auth.
//
// Providers are enabled ONLY when their credentials are present in the
// environment, so the buttons can be merged now and flipped on later by
// adding env vars (no code change). We never pass a provider with empty
// credentials to Better Auth, and we never leak the secrets — the public
// surface (`getConfiguredSocialProviders`) returns booleans only.

type Env = Record<string, string | undefined>;

const DEFAULT_MICROSOFT_TENANT = "common";

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

  if (present(env.GOOGLE_CLIENT_ID) && present(env.GOOGLE_CLIENT_SECRET)) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID.trim(),
      clientSecret: env.GOOGLE_CLIENT_SECRET.trim(),
    };
  }

  if (present(env.MICROSOFT_CLIENT_ID) && present(env.MICROSOFT_CLIENT_SECRET)) {
    providers.microsoft = {
      clientId: env.MICROSOFT_CLIENT_ID.trim(),
      clientSecret: env.MICROSOFT_CLIENT_SECRET.trim(),
      tenantId: present(env.MICROSOFT_TENANT_ID)
        ? env.MICROSOFT_TENANT_ID.trim()
        : DEFAULT_MICROSOFT_TENANT,
    };
  }

  return providers;
}
