// AgentDash: env-gated remote error tracking (Sentry) — dependency-free.
//
// Fully OFF by default. Sentry is only initialized when SENTRY_DSN is set.
// When the DSN is unset (or invalid), initSentry() is a no-op and
// captureServerError() silently does nothing — zero behavior change for
// local/dev and any deployment that does not opt in.
//
// This intentionally avoids the @sentry/node SDK: CI owns pnpm-lock.yaml and
// rejects feature-branch lockfile changes, so adding an npm dependency cannot
// pass CI. Instead we use the built-in global `fetch` (Node 24) to POST a
// minimal event to Sentry's store endpoint derived from the DSN. The payload
// is a small subset of the Sentry event schema — enough for issue grouping and
// triage without pulling in the SDK.

const SENTRY_CLIENT = "agentdash/1.0";
const SENTRY_VERSION = "7";
// Fire-and-forget transport timeout. Kept short so a slow/unreachable Sentry
// ingest endpoint never delays request handling or process startup.
const TRANSPORT_TIMEOUT_MS = 2000;

interface SentryEndpoint {
  /** Sentry ingest hostname (e.g. o0.ingest.sentry.io). */
  host: string;
  /** Numeric project id from the DSN path. */
  projectId: string;
  /** DSN public key (the userinfo component). */
  publicKey: string;
  /** Fully-derived store endpoint URL. */
  storeUrl: string;
}

let endpoint: SentryEndpoint | null = null;

/**
 * Parse a Sentry DSN of the form
 *   https://<publicKey>@<host>/<projectId>
 * into the derived store endpoint. Returns null for unset/invalid input.
 */
function parseDsn(raw: string | undefined): SentryEndpoint | null {
  const dsn = raw?.trim();
  if (!dsn) return null;

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }

  const publicKey = url.username;
  if (!publicKey) return null;

  const host = url.host;
  if (!host) return null;

  // Path is "/<projectId>" (optionally with leading path segments for
  // self-hosted Sentry, where the project id is the final segment).
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const projectId = segments[segments.length - 1];
  if (!projectId) return null;

  const storeUrl = `${url.protocol}//${host}/api/${projectId}/store/`;

  return { host, projectId, publicKey, storeUrl };
}

/**
 * Initialize Sentry error tracking if (and only if) SENTRY_DSN is set and
 * parses cleanly.
 *
 * Returns true when Sentry was initialized, false otherwise. Safe to call
 * multiple times — subsequent calls after a successful init are no-ops.
 */
export function initSentry(): boolean {
  if (endpoint) return true;

  const parsed = parseDsn(process.env.SENTRY_DSN);
  if (!parsed) return false;

  endpoint = parsed;
  return true;
}

/**
 * Whether Sentry has been initialized this process. Exposed mainly for tests
 * and for callers that want to short-circuit before building context.
 */
export function isSentryInitialized(): boolean {
  return endpoint !== null;
}

function randomEventId(): string {
  // Sentry event_id is a 32-char hex string (UUID without dashes).
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

/**
 * Capture a server error to Sentry. No-op when Sentry was never initialized
 * (i.e. SENTRY_DSN unset/invalid), so callers can wire this in unconditionally.
 *
 * Fire-and-forget: the POST runs detached with a short timeout and every
 * transport error is swallowed. This never throws and never blocks the caller.
 */
export function captureServerError(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const target = endpoint;
  if (!target) return;

  try {
    const error = err instanceof Error ? err : new Error(String(err));
    const event = {
      event_id: randomEventId(),
      timestamp: new Date().toISOString(),
      level: "error" as const,
      platform: "node" as const,
      environment: process.env.NODE_ENV,
      exception: {
        values: [
          {
            type: error.name,
            value: error.message,
            ...(error.stack ? { stacktrace: { frames: [], raw: error.stack } } : {}),
          },
        ],
      },
      ...(context ? { extra: context } : {}),
    };

    const authHeader = `Sentry sentry_version=${SENTRY_VERSION}, sentry_key=${target.publicKey}, sentry_client=${SENTRY_CLIENT}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSPORT_TIMEOUT_MS);
    // unref so a pending transport never keeps the process alive.
    (timer as { unref?: () => void }).unref?.();

    void fetch(target.storeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": authHeader,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
      .catch(() => {
        // Swallow all transport errors — error tracking must never surface.
      })
      .finally(() => {
        clearTimeout(timer);
      });
  } catch {
    // Swallow any synchronous failure (serialization, etc.). Never throw.
  }
}
