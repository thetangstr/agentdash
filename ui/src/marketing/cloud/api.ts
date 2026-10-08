/**
 * AgentDash (SC-7, GH #768): the front-door API on www.agentdash.cloud.
 * `/api/cloud/*` is rewritten by Vercel to the control plane (vercel.json),
 * so these calls are same-origin and the session is a first-party cookie.
 */

export interface CloudConfig {
  turnstileSiteKey: string | null;
  signupOpen: boolean;
  // AgentDash: optional for compatibility with older control planes.
  invitationCodesEnabled?: boolean;
  waitlist: boolean;
  edgeDomain: string;
}

export type Phase = "waitlisted" | "approved" | "provisioning" | "ready" | "active" | "suspended" | "failed" | "closing";

export interface BoxView {
  slug: string;
  url: string;
  state: string;
  phase: Phase;
  stepIndex: number | null;
  slow: boolean;
  claimUrl: string | null;
  createdAt: string;
}

export interface MyBoxes {
  email: string;
  boxes: BoxView[];
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/cloud${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CloudApiError("We could not reach AgentDash. Check your connection and try again.", 0, "network");
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok) {
    throw new CloudApiError(data?.error ?? "Something went wrong. Try again in a minute.", res.status, data?.code ?? "unknown");
  }
  return data as T;
}

export const cloudApi = {
  config: () => call<CloudConfig>("GET", "/config"),
  slugAvailable: (slug: string) =>
    call<{ slug: string; available: boolean; reason?: string; message?: string }>("GET", `/slug-available?slug=${encodeURIComponent(slug)}`),
  signup: (input: { email: string; workspaceName: string; slug: string; acceptTerms: boolean; invitationCode?: string; turnstileToken?: string }) =>
    call<{ ok: true }>("POST", "/signup", input),
  verify: (token: string) =>
    call<{ ok: true; outcome: "box_requested" | "existing" | "signed_in"; provisioning?: "queued" | "waitlisted"; reason?: string | null }>("POST", "/verify", { token }),
  mine: () => call<MyBoxes>("GET", "/boxes/mine"),
  redeemInvitation: (code: string) =>
    call<{ ok: true; provisioning: "queued" | "waitlisted" | "already_started"; reason?: string | null }>("POST", "/invitation/redeem", { code }),
  resend: (email?: string) => call<{ ok: true }>("POST", "/resend", email ? { email } : {}),
  find: (input: { email: string; turnstileToken?: string }) => call<{ ok: true }>("POST", "/find", input),
};

/** The control plane's slug rule for new boxes: 3-16 of a-z, 0-9 and '-', starting with a letter, not ending with '-'. */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/;

/** A slug suggestion from a workspace name ("Acme Robotics, Inc." → "acme-robotics-in"). */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 16)
    .replace(/-+$/, "");
}
