export type AuthSession = {
  session: { id: string; userId: string };
  user: { id: string; email: string | null; name: string | null };
};

function toSession(value: unknown): AuthSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sessionValue = record.session;
  const userValue = record.user;
  if (!sessionValue || typeof sessionValue !== "object") return null;
  if (!userValue || typeof userValue !== "object") return null;
  const session = sessionValue as Record<string, unknown>;
  const user = userValue as Record<string, unknown>;
  if (typeof session.id !== "string" || typeof session.userId !== "string") return null;
  if (typeof user.id !== "string") return null;
  return {
    session: { id: session.id, userId: session.userId },
    user: {
      id: user.id,
      email: typeof user.email === "string" ? user.email : null,
      name: typeof user.name === "string" ? user.name : null,
    },
  };
}

// AgentDash (AGE-101): typed auth error so the signup form can recognize
// AGE-60 (pro_requires_corp_email) and AGE-100 (free_tier_seat_cap) codes
// and render an inline upgrade CTA instead of a generic toast.
export class AuthRequestError extends Error {
  readonly code: string | null;
  readonly status: number;
  constructor(message: string, code: string | null, status: number) {
    super(message);
    this.name = "AuthRequestError";
    this.code = code;
    this.status = status;
  }
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
    const message =
      (payload as { error?: { message?: string } | string } | null)?.error &&
      typeof (payload as { error?: { message?: string } | string }).error === "object"
        ? ((payload as { error?: { message?: string } }).error?.message ?? `Request failed: ${res.status}`)
        : (payload as { error?: string } | null)?.error ?? `Request failed: ${res.status}`;
    const code =
      typeof (payload as { code?: unknown } | null)?.code === "string"
        ? ((payload as { code: string }).code)
        : null;
    throw new AuthRequestError(message, code, res.status);
  }
  return payload;
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

  signOut: async () => {
    await authPost("/sign-out", {});
  },
};
