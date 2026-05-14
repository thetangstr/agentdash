const BASE = "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  const body = init?.body;
  if (!(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers,
      credentials: "include",
      ...init,
    });
  } catch (err) {
    if (err instanceof TypeError && err.message === "Failed to fetch") {
      throw new ApiError(
        "Unable to reach the server — check your connection and try again.",
        0,
        null,
      );
    }
    throw err;
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    // Closes #224: surface 402 cap-exceeded errors via a global event so
    // <UpgradePromptModal> (mounted in Layout) renders the upgrade card
    // inline regardless of which call site triggered the error. Avoids
    // requiring every invite/hire callsite to manually catch + render.
    if (res.status === 402 && errorBody && typeof errorBody === "object") {
      const code = (errorBody as { code?: string }).code;
      if (code === "seat_cap_exceeded" || code === "agent_cap_exceeded") {
        try {
          window.dispatchEvent(
            new CustomEvent("agentdash:cap-exceeded", {
              detail: { reason: code, companyId: (errorBody as { companyId?: string }).companyId ?? null },
            }),
          );
        } catch {
          // SSR / non-browser context — swallow; the throw below still surfaces
        }
      }
    }
    throw new ApiError(
      (errorBody as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  postForm: <T>(path: string, body: FormData) =>
    request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
