import {
  authSessionSchema,
  currentUserProfileSchema,
  type AuthSession,
  type CurrentUserProfile,
  type UpdateCurrentUserProfile,
} from "@paperclipai/shared";

type AuthErrorBody =
  | {
    code?: string;
    message?: string;
    error?: string | { code?: string; message?: string };
  }
  | null;

export class AuthApiError extends Error {
  status: number;
  code: string | null;
  body: unknown;

  constructor(message: string, status: number, body: unknown, code: string | null = null) {
    super(message);
    this.name = "AuthApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function toSession(value: unknown): AuthSession | null {
  const direct = authSessionSchema.safeParse(value);
  if (direct.success) return direct.data;

  if (!value || typeof value !== "object") return null;
  const nested = authSessionSchema.safeParse((value as Record<string, unknown>).data);
  return nested.success ? nested.data : null;
}

function extractAuthError(payload: AuthErrorBody, status: number) {
  const nested =
    payload?.error && typeof payload.error === "object"
      ? payload.error
      : null;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof payload?.code === "string"
        ? payload.code
        : null;
  const message =
    typeof nested?.message === "string" && nested.message.trim().length > 0
      ? nested.message
      : typeof payload?.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : typeof payload?.error === "string" && payload.error.trim().length > 0
          ? payload.error
          : `Request failed: ${status}`;

  return new AuthApiError(message, status, payload, code);
}

async function authPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return payload;
}

async function authPatch<T>(path: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> {
  const res = await fetch(`/api/auth${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw extractAuthError(payload as AuthErrorBody, res.status);
  }
  return parse(payload);
}

export const authApi = {
  getSession: async (): Promise<AuthSession | null> => {
    const res = await fetch("/api/auth/get-session", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (res.status === 401) return null;
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`Failed to load session (${res.status})`);
    }
    const direct = toSession(payload);
    if (direct) return direct;
    const nested = payload && typeof payload === "object" ? toSession((payload as Record<string, unknown>).data) : null;
    return nested;
  },

  signInEmail: async (input: { email: string; password: string }) => {
    await authPost("/sign-in/email", input);
  },

  signUpEmail: async (input: { name: string; email: string; password: string }) => {
    await authPost("/sign-up/email", input);
  },

  // AgentDash: SSO — which social providers the server has credentials for.
  // Returns booleans only; the Auth page hides a button when its provider is
  // false. Never throws on a missing/failed probe — SSO is purely additive, so
  // we degrade to "no providers" and the email/password form stays usable.
  getSocialProviders: async (): Promise<{ google: boolean; microsoft: boolean }> => {
    try {
      const res = await fetch("/api/auth/social-providers", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return { google: false, microsoft: false };
      const payload = (await res.json().catch(() => null)) as
        | { google?: unknown; microsoft?: unknown }
        | null;
      return {
        google: payload?.google === true,
        microsoft: payload?.microsoft === true,
      };
    } catch {
      return { google: false, microsoft: false };
    }
  },

  // AgentDash: SSO — kick off a social sign-in. Better Auth responds with the
  // provider's authorization URL; we hand the browser off to it. `callbackURL`
  // is where Better Auth lands the user after the OAuth round-trip (used to
  // preserve the trial-claim `next` deep link).
  signInSocial: async (input: { provider: "google" | "microsoft"; callbackURL: string }) => {
    const payload = (await authPost("/sign-in/social", input)) as
      | { url?: string; redirect?: boolean }
      | null;
    if (payload?.url) {
      window.location.href = payload.url;
      return;
    }
    throw new Error("Social sign-in is unavailable right now. Please try email instead.");
  },

  getProfile: async (): Promise<CurrentUserProfile> => {
    const res = await fetch("/api/auth/profile", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error((payload as { error?: string } | null)?.error ?? `Failed to load profile (${res.status})`);
    }
    return currentUserProfileSchema.parse(payload);
  },

  updateProfile: async (input: UpdateCurrentUserProfile): Promise<CurrentUserProfile> =>
    authPatch("/profile", input, (payload) => currentUserProfileSchema.parse(payload)),

  signOut: async () => {
    await authPost("/sign-out", {});
  },

  // Better Auth 1.4.x exposes this as `/request-password-reset` (not
  // `/forget-password` — that path was renamed away from the older
  // 1.3.x convention). The server fires the `sendResetPassword` hook
  // wired in server/src/auth/better-auth.ts, which emails the user a
  // link pointing at /reset-password?token=… on the SPA.
  forgetPassword: async (input: { email: string; redirectTo: string }) => {
    await authPost("/request-password-reset", input);
  },

  // The reset page POSTs the new password + token from the query string
  // back to Better Auth, which validates the token and writes the new
  // hash. After this resolves the user must sign in again.
  resetPassword: async (input: { newPassword: string; token: string }) => {
    await authPost("/reset-password", input);
  },
};
