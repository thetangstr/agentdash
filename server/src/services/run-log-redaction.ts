// AgentDash (GH #992): server-side secret redaction for run logs.
//
// Run output is redacted twice:
//   1. At persist time — every stdout/stderr chunk, run event, result payload
//      and error message passes through here before it reaches the log store
//      or the database. No raw unredacted copy is kept anywhere; that is a
//      deliberate choice — a raw copy would just be the leak again.
//   2. At serve time — log/event reads re-run the same redaction so rows and
//      log files written before this change are still safe to return.
//
// Coverage is pattern + known-secret matching: the anchored pattern set from
// `@paperclipai/shared` (the same one the UI uses) plus every secret this
// instance knows verbatim — credential-valued process env vars and the
// provider key written into the managed Hermes profile's `.env`. Callers can
// add run-scoped values (the run's injected JWT, resolved secret_ref env
// values). Stored agent API keys and board tokens are hashed at rest and so
// cannot be matched verbatim; they are covered by the `pcp_` shape instead.
import {
  createSecretStreamRedactor,
  redactSecrets,
  redactSecretsInValue,
  type KnownSecrets,
} from "@paperclipai/shared";
import { configuredProviderKeysSync } from "./hermes-provider-setup.js";
import { knownKeysFromEnv } from "./redact-secrets.js";

const INSTANCE_SECRETS_TTL_MS = 60_000;

let cachedInstanceSecrets: { at: number; keys: string[] } | null = null;

/**
 * Secrets configured on this instance, collected for verbatim matching:
 * credential-valued process env vars plus the provider key held in the managed
 * Hermes template profile's `.env`. Cached briefly — the profile `.env` read
 * is cheap but happens on every logged chunk.
 */
export function instanceKnownSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env === process.env && cachedInstanceSecrets && Date.now() - cachedInstanceSecrets.at < INSTANCE_SECRETS_TTL_MS) {
    return cachedInstanceSecrets.keys;
  }
  const keys = [...knownKeysFromEnv(env), ...configuredProviderKeysSync(env)];
  if (env === process.env) cachedInstanceSecrets = { at: Date.now(), keys };
  return keys;
}

/** Tests only: drop the cached instance secrets after env/profile fixtures change. */
export function resetInstanceSecretsCacheForTests(): void {
  cachedInstanceSecrets = null;
}

function mergeSecrets(extra?: KnownSecrets): string[] {
  const instance = instanceKnownSecrets();
  if (!extra || extra.length === 0) return instance;
  return [...instance, ...extra.filter((value): value is string => typeof value === "string" && value.length > 0)];
}

/** `redactSecrets` with this instance's known keys always included. */
export function redactRunLogText(text: string, extraSecrets?: KnownSecrets): string {
  if (!text) return text;
  return redactSecrets(text, mergeSecrets(extraSecrets));
}

/** `redactSecretsInValue` with this instance's known keys always included. */
export function redactRunLogValue<T>(value: T, extraSecrets?: KnownSecrets): T {
  return redactSecretsInValue(value, mergeSecrets(extraSecrets));
}

function redactRunLogNdjsonLine(line: string, secrets: KnownSecrets): string {
  if (!line.startsWith("{")) return redactSecrets(line, secrets);
  try {
    return JSON.stringify(redactSecretsInValue(JSON.parse(line), secrets));
  } catch {
    return redactSecrets(line, secrets);
  }
}

/**
 * Serve-time pass over an NDJSON run-log file. Each line is parsed and its
 * values redacted structurally before re-serialising, so a regex pass can
 * never corrupt the JSON escaping (`\"`, `\\`, `\uXXXX`) of stored chunks.
 * Lines that do not parse — truncated head/tail lines from byte-range reads —
 * get the plain-text pass instead; they were already partial.
 */
export function redactRunLogNdjson(content: string, extraSecrets?: KnownSecrets): string {
  if (!content) return content;
  const secrets = mergeSecrets(extraSecrets);
  return content
    .split("\n")
    .map((line) => redactRunLogNdjsonLine(line, secrets))
    .join("\n");
}

const NDJSON_YIELD_SLICE_MS = 8;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * AgentDash: `redactRunLogNdjson` for request paths — byte-for-byte the same
 * output, but it yields to the event loop every few milliseconds so one large
 * read can never stall health checks and every other request (2026-10-07: a
 * 624 KB log blocked the HQ server for 25–35 s per read).
 */
export async function redactRunLogNdjsonAsync(
  content: string,
  extraSecrets?: KnownSecrets,
  opts?: { sliceMs?: number },
): Promise<string> {
  if (!content) return content;
  const sliceMs = opts?.sliceMs ?? NDJSON_YIELD_SLICE_MS;
  const secrets = mergeSecrets(extraSecrets);
  const lines = content.split("\n");
  let sliceStart = performance.now();
  for (let i = 0; i < lines.length; i++) {
    lines[i] = redactRunLogNdjsonLine(lines[i]!, secrets);
    if (performance.now() - sliceStart >= sliceMs && i + 1 < lines.length) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }
  return lines.join("\n");
}

/**
 * Most bytes NOT covered by the store's written-redacted mark that one log
 * read redacts. Larger requests are trimmed at a line boundary and answer a
 * `nextOffset`, so the client pages through the rest — the response contract
 * (offset/limitBytes/nextOffset) is unchanged.
 */
export const RUN_LOG_SERVE_MAX_UNVERIFIED_BYTES = 256_000;

const NEWLINE = 0x0a;

/**
 * Serve a run-log read: bytes the store vouches for (redacted at write time)
 * pass through; the rest gets the serve-time NDJSON pass, chunked so it
 * yields, and capped at `maxUnverifiedBytes` per request.
 */
export async function redactRunLogReadForServe(
  result: {
    content: string;
    nextOffset?: number;
    redactedAtPersist?: boolean;
    verifiedChars?: number;
    startOffset?: number;
  },
  opts?: { maxUnverifiedBytes?: number; extraSecrets?: KnownSecrets },
): Promise<{ content: string; nextOffset?: number; redactedAtPersist: boolean }> {
  const { content } = result;
  if (result.redactedAtPersist) {
    return { content, nextOffset: result.nextOffset, redactedAtPersist: true };
  }
  const verifiedChars = Math.max(0, Math.min(result.verifiedChars ?? 0, content.length));
  const head = content.slice(0, verifiedChars);
  let tail = content.slice(verifiedChars);
  let nextOffset = result.nextOffset;
  const cap = Math.max(1, opts?.maxUnverifiedBytes ?? RUN_LOG_SERVE_MAX_UNVERIFIED_BYTES);
  if (typeof result.startOffset === "number" && tail.length > 0) {
    const tailBytes = Buffer.from(tail, "utf8");
    if (tailBytes.length > cap) {
      // Cut after the last newline inside the cap so the next page starts a
      // whole line (a secret is never split across two redaction passes). A
      // single line longer than the cap is kept whole.
      let cut = tailBytes.lastIndexOf(NEWLINE, cap - 1) + 1;
      if (cut <= 0) cut = tailBytes.indexOf(NEWLINE, cap) + 1;
      if (cut > 0 && cut < tailBytes.length) {
        tail = tailBytes.subarray(0, cut).toString("utf8");
        nextOffset = result.startOffset + Buffer.byteLength(head, "utf8") + cut;
      }
    }
  }
  const redactedTail = await redactRunLogNdjsonAsync(tail, opts?.extraSecrets);
  return { content: head + redactedTail, nextOffset, redactedAtPersist: false };
}

/**
 * An Error (or thrown value) that is safe to hand to pino: adapter/provider
 * failures can echo the credential they failed with, so the message and stack
 * go through the same redaction as run output. Never logs the secret itself.
 */
export function logSafeError(err: unknown, extraSecrets?: KnownSecrets): unknown {
  if (err instanceof Error) {
    const safe: Record<string, unknown> = {
      name: err.name,
      message: redactRunLogText(err.message, extraSecrets),
    };
    if (err.stack) safe.stack = redactRunLogText(err.stack, extraSecrets);
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) safe.cause = logSafeError(cause, extraSecrets);
    return safe;
  }
  return typeof err === "string" ? redactRunLogText(err, extraSecrets) : err;
}

/** Stateful stream redactor for chunked adapter output (one per stream). */
export function createRunLogStreamRedactor(extraSecrets?: KnownSecrets) {
  return createSecretStreamRedactor(mergeSecrets(extraSecrets));
}
