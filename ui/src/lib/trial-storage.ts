// AgentDash (Test Drive): persistence for the PUBLIC no-signup trial.
//
// The trial token is the visitor's only credential and the company itself lives
// server-side (fetched via getCompany). We keep the token in localStorage (not
// sessionStorage) so closing the tab, opening a new tab, or navigating away and
// back resumes the built company + deliverables. We also persist the in-progress
// intake fields + current view so a refresh mid-intake/mid-designing does not
// wipe what the visitor typed.
//
// Pre-existing sessionStorage tokens are migrated to localStorage on first read.

export const TRIAL_TOKEN_KEY = "agentdash.trial.token";
export const TRIAL_STATE_KEY = "agentdash.trial.state";

type SimpleStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safeLocal(): SimpleStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeSession(): SimpleStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Read the trial token. Prefers localStorage; if absent, migrates a legacy
 * sessionStorage token into localStorage once and returns it.
 */
export function readStoredToken(): string | null {
  const local = safeLocal();
  const fromLocal = local?.getItem(TRIAL_TOKEN_KEY) ?? null;
  if (fromLocal) return fromLocal;

  // One-time migration from the old sessionStorage location.
  const session = safeSession();
  const fromSession = session?.getItem(TRIAL_TOKEN_KEY) ?? null;
  if (fromSession) {
    try {
      local?.setItem(TRIAL_TOKEN_KEY, fromSession);
      session?.removeItem(TRIAL_TOKEN_KEY);
    } catch {
      /* storage write blocked — token still returned for this session */
    }
    return fromSession;
  }

  return null;
}

export function writeStoredToken(token: string | null): void {
  const local = safeLocal();
  try {
    if (token) local?.setItem(TRIAL_TOKEN_KEY, token);
    else local?.removeItem(TRIAL_TOKEN_KEY);
    // Never leave a stale copy in the legacy location.
    safeSession()?.removeItem(TRIAL_TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — token still lives in React state */
  }
}

/** In-progress intake + view persisted across refreshes. */
export type TrialPersistedState = {
  view?: string;
  whatYouDo?: string;
  goal?: string;
  blocker?: string;
};

export function readPersistedState(): TrialPersistedState | null {
  const local = safeLocal();
  const raw = local?.getItem(TRIAL_STATE_KEY) ?? null;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    const pick = (k: string): string | undefined =>
      typeof obj[k] === "string" ? (obj[k] as string) : undefined;
    return {
      view: pick("view"),
      whatYouDo: pick("whatYouDo"),
      goal: pick("goal"),
      blocker: pick("blocker"),
    };
  } catch {
    return null;
  }
}

export function writePersistedState(state: TrialPersistedState): void {
  const local = safeLocal();
  try {
    local?.setItem(TRIAL_STATE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — non-fatal, state still lives in React */
  }
}

/** Clear all trial storage (intentional reset or after a successful claim). */
export function clearTrialStorage(): void {
  try {
    const local = safeLocal();
    local?.removeItem(TRIAL_TOKEN_KEY);
    local?.removeItem(TRIAL_STATE_KEY);
    const session = safeSession();
    session?.removeItem(TRIAL_TOKEN_KEY);
    session?.removeItem(TRIAL_STATE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}
