// AgentDash: the control plane's only client for Railway's public GraphQL API
// (spec §3.3, §3.6). Rules, from lib.sh and the #779 review (GH #763):
//   - the token is a Secret, revealed only into the Authorization header;
//   - request VARIABLES are never logged, never put in an error, never put in
//     a URL: they carry generated secrets (auth secret, master key, claim
//     code, Postgres password) and bare UUIDs the logger cannot tell from a
//     token. A log line names only the operation, the HTTP status and the time;
//   - Railway's own error messages can echo an input value back ("Variable
//     "$i" got invalid value …"), so every message is scrubbed of every string
//     in the request's variables before it reaches an error or a log;
//   - a 429 (or a rate-limit error) carries the Retry-After delay, so the job
//     runner can honour it (SC-3, GH #764).
import type { Logger } from "../logger.js";
import { REDACTED, type Secret } from "../secret.js";

export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

export type GqlVariables = Record<string, unknown>;

export class RailwayApiError extends Error {
  readonly operation: string;
  /** HTTP status, or 0 for a transport failure (DNS, reset, timeout). */
  readonly status: number;
  /** Railway's error messages, already scrubbed of every request variable. */
  readonly messages: string[];
  /** Milliseconds to wait before retrying, from Retry-After, when Railway sent one. */
  readonly retryAfterMs: number | null;
  readonly rateLimited: boolean;

  constructor(opts: { operation: string; status: number; messages: string[]; retryAfterMs?: number | null; rateLimited?: boolean }) {
    const detail = opts.messages.length ? opts.messages.join("; ") : `HTTP ${opts.status}`;
    super(`Railway ${opts.operation} failed: ${detail}`);
    this.name = "RailwayApiError";
    this.operation = opts.operation;
    this.status = opts.status;
    this.messages = opts.messages;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.rateLimited = opts.rateLimited ?? opts.status === 429;
  }
}

/** Parse Retry-After: delta seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(raw: string | null, now: number = Date.now()): number | null {
  if (!raw) return null;
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Every string (and number) leaf in the variables, longest first, for scrubbing. */
function variableValues(vars: GqlVariables | undefined): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 20 || v === null || v === undefined) return;
    if (typeof v === "string") {
      if (v.length >= 3) out.add(v);
    } else if (typeof v === "number" || typeof v === "bigint") {
      const s = String(v);
      if (s.length >= 3) out.add(s);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    }
  };
  walk(vars, 0);
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replace every variable value inside a message; drop Railway's "got invalid value" echoes wholesale. */
export function scrubMessage(message: string, values: string[]): string {
  if (/got invalid value|Expected value of type|Variable "\$[^"]*" of/i.test(message)) {
    const name = /Variable "\$([A-Za-z0-9_]+)"/.exec(message)?.[1];
    return `invalid value for variable ${name ? `$${name}` : "(unnamed)"} (value withheld)`;
  }
  let out = message;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(REDACTED);
  return out;
}

function parseBody<B>(text: string): B | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as B) : null;
  } catch {
    return null;
  }
}

export interface RailwayClientOptions {
  token: Secret;
  url?: string;
  fetch?: typeof fetch;
  log?: Logger;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export class RailwayClient {
  readonly #token: Secret;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #log: Logger | undefined;
  readonly #timeoutMs: number;

  constructor(opts: RailwayClientOptions) {
    this.#token = opts.token;
    this.#url = opts.url ?? RAILWAY_GRAPHQL_URL;
    this.#fetch = opts.fetch ?? fetch;
    this.#log = opts.log;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * Run one GraphQL operation. `operation` is a short fixed label for logs
   * and errors (e.g. "projectCreate"); it must never be built from input.
   */
  async request<T>(operation: string, query: string, variables?: GqlVariables, opts: RequestOptions = {}): Promise<T> {
    const values = variableValues(variables);
    const started = Date.now();
    const signals = [AbortSignal.timeout(this.#timeoutMs)];
    if (opts.signal) signals.push(opts.signal);
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#token.reveal()}` },
        body: JSON.stringify({ query, variables: variables ?? {} }),
        signal: AbortSignal.any(signals),
      });
    } catch (err) {
      // Never pass the underlying error through: some fetch implementations
      // attach the request (and so its body) to the cause.
      const code = err instanceof Error ? ((err as { code?: string }).code ?? err.name) : "unknown";
      this.#log?.warn("railway request failed", { operation, status: 0, ms: Date.now() - started, cause: code });
      throw new RailwayApiError({ operation, status: 0, messages: [`transport error (${code})`] });
    }
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    let text = "";
    try {
      text = await res.text();
    } catch {
      text = "";
    }
    type Body = { data?: T | null; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
    const body = parseBody<Body>(text);
    const ms = Date.now() - started;
    const errors = body?.errors ?? [];
    const messages = errors.map((e) => scrubMessage(String(e.message ?? "unknown error"), values));
    const rateLimited = res.status === 429 || messages.some((m) => /rate limit/i.test(m));
    if (!res.ok || errors.length || !body || body.data === undefined || body.data === null) {
      this.#log?.warn("railway request failed", { operation, status: res.status, ms, errors: messages.length, rateLimited });
      throw new RailwayApiError({
        operation,
        status: res.status,
        messages: messages.length ? messages : [body ? `HTTP ${res.status}` : `HTTP ${res.status}, non-JSON response`],
        retryAfterMs,
        rateLimited,
      });
    }
    this.#log?.debug("railway request", { operation, status: res.status, ms });
    return body.data as T;
  }
}
