// AgentDash (per-steward document access, slice 7): the browser half of the
// "connect your Microsoft 365 account" sign-in.
//
// The flow is a standard authorization-code redirect. My Agent asks the server
// for an authorization URL, remembers (in this tab only) which company the
// sign-in belongs to and where to come back to, and sends the browser to
// Microsoft. Microsoft returns to `/connect/<provider>/callback?code=…&state=…`;
// that page strips the query from the address bar at once, posts the code to
// the server, and goes back to My Agent.
//
// The code is a one-time credential. It must not outlive the callback in the
// address bar, in history, in a sign-in redirect's `next=`, or in a React Query
// key, so nothing here stores it: only the provider, company, redirect URI and
// return path are remembered, and those are not secrets.

export const DOCUMENT_CONNECT_PROVIDERS = ["microsoft"] as const;
export type DocumentConnectProvider = (typeof DOCUMENT_CONNECT_PROVIDERS)[number];

export function isDocumentConnectProvider(value: unknown): value is DocumentConnectProvider {
  return typeof value === "string" && (DOCUMENT_CONNECT_PROVIDERS as readonly string[]).includes(value);
}

/** The path every provider returns to; slice 2's server pins the same one. */
export function documentCallbackPath(provider: DocumentConnectProvider): string {
  return `/connect/${provider}/callback`;
}

/** The redirect URI for this browser's origin. The server checks the origin is its own. */
export function documentRedirectUri(provider: DocumentConnectProvider, origin: string): string {
  return `${origin.replace(/\/+$/, "")}${documentCallbackPath(provider)}`;
}

/** True for the callback page, whose query string carries a one-time code. */
export function isDocumentCallbackPath(pathname: string): boolean {
  return /^\/connect\/[^/]+\/callback\/?$/.test(pathname);
}

/**
 * Where the sign-in page should return to. A provider callback goes back
 * without its query: the code must not travel through `/auth?next=`, and once
 * the person has signed in again the old code is better spent than replayed.
 */
export function authNextPath(pathname: string, search: string): string {
  return isDocumentCallbackPath(pathname) ? pathname : `${pathname}${search}`;
}

/**
 * Leaving the app for the provider's sign-in page. An object rather than a
 * bare call so tests can replace it: jsdom cannot navigate.
 */
export const browserNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

const PENDING_KEY = "agentdash.documentConnect.pending";
/** Longer than the server's 15-minute state lifetime, so the server decides expiry. */
const PENDING_MAX_AGE_MS = 60 * 60_000;
const DEFAULT_RETURN_TO = "/my-agent";

export interface PendingDocumentConnect {
  provider: DocumentConnectProvider;
  companyId: string;
  redirectUri: string;
  returnTo: string;
  startedAt: number;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Only same-app, absolute paths: never another origin, never a
 * protocol-relative `//host`, never the callback itself. Control characters
 * are refused too: the URL parser strips tab, CR and LF, so `/\t/host` would
 * otherwise resolve, as an href, to the protocol-relative `//host`.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_RETURN_TO;
  if (CONTROL_CHARACTERS.test(value)) return DEFAULT_RETURN_TO;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return DEFAULT_RETURN_TO;
  const pathname = value.split(/[?#]/)[0] ?? value;
  if (isDocumentCallbackPath(pathname)) return DEFAULT_RETURN_TO;
  return pathname;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberPendingConnect(pending: Omit<PendingDocumentConnect, "startedAt">, now = Date.now()): void {
  const value: PendingDocumentConnect = { ...pending, returnTo: safeReturnTo(pending.returnTo), startedAt: now };
  try {
    storage()?.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    // Private mode or a full store: the callback falls back to the selected company.
  }
}

export function readPendingConnect(
  provider: DocumentConnectProvider,
  now = Date.now(),
): PendingDocumentConnect | null {
  let raw: string | null = null;
  try {
    raw = storage()?.getItem(PENDING_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingDocumentConnect>;
    if (
      parsed.provider !== provider ||
      typeof parsed.companyId !== "string" ||
      parsed.companyId.length === 0 ||
      typeof parsed.redirectUri !== "string" ||
      typeof parsed.startedAt !== "number" ||
      now - parsed.startedAt > PENDING_MAX_AGE_MS
    ) {
      return null;
    }
    return {
      provider,
      companyId: parsed.companyId,
      redirectUri: parsed.redirectUri,
      returnTo: safeReturnTo(parsed.returnTo),
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function clearPendingConnect(): void {
  try {
    storage()?.removeItem(PENDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

export interface DocumentCallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

export function readCallbackParams(search: string): DocumentCallbackParams {
  const params = new URLSearchParams(search);
  const pick = (name: string) => {
    const value = params.get(name);
    return value && value.length > 0 ? value : null;
  };
  return {
    code: pick("code"),
    state: pick("state"),
    error: pick("error"),
    errorDescription: pick("error_description"),
  };
}
