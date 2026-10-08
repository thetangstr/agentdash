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
import { createHash } from "node:crypto";
import {
  REDACTION_RULES_VERSION,
  createSecretStreamRedactor,
  redactSecrets,
  redactSecretsAsync,
  type AsyncRedactionOptions,
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

let redactionEpochCache: { keys: string[]; epoch: string } | null = null;

/**
 * Fingerprint of what the run-log redactor hides right now: the shared rules
 * version plus a hash of the sorted, de-duplicated instance known-secret set
 * (never the secrets themselves). A written-redacted mark is only trusted
 * while this is unchanged — a provider key added or rotated at runtime makes
 * every earlier "already redacted" byte go through the serve pass again.
 */
export function runLogRedactionEpoch(): string {
  const keys = instanceKnownSecrets();
  if (redactionEpochCache && redactionEpochCache.keys === keys) return redactionEpochCache.epoch;
  const hash = createHash("sha256").update(`rules:${REDACTION_RULES_VERSION}\u0000`);
  for (const key of [...new Set(keys)].sort()) hash.update(`${key.length}:${key}\u0000`);
  const epoch = hash.digest("hex");
  redactionEpochCache = { keys, epoch };
  return epoch;
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

/** Cooperative whole-text pass: crossline patterns retain their full context. */
export function redactRunLogTextAsync(text: string, extraSecrets?: KnownSecrets, opts?: AsyncRedactionOptions): Promise<string> {
  return redactSecretsAsync(text, mergeSecrets(extraSecrets), { yieldToEventLoop, ...opts });
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
  opts?: { sliceMs?: number; signal?: AbortSignal },
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
      // The client went away: stop spending CPU on a response nobody reads.
      opts?.signal?.throwIfAborted();
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
 * Serve a run-log read: bytes the store vouches for (redacted at write time,
 * in this process, under the current redaction epoch) pass through; the rest
 * gets the serve-time NDJSON pass, chunked so it yields, and capped at
 * `maxUnverifiedBytes` per request. Paging offsets are computed on the raw
 * file bytes (`buffer`), never on re-encoded text.
 */
export async function redactRunLogReadForServe(
  result: {
    content: string;
    nextOffset?: number;
    redactedAtPersist?: boolean;
    buffer?: Buffer;
    verifiedBytes?: number;
    startOffset?: number;
  },
  opts?: { maxUnverifiedBytes?: number; extraSecrets?: KnownSecrets; signal?: AbortSignal },
): Promise<{ content: string; nextOffset?: number; redactedAtPersist: boolean }> {
  if (result.redactedAtPersist) {
    return { content: result.content, nextOffset: result.nextOffset, redactedAtPersist: true };
  }
  const { buffer } = result;
  if (!buffer) {
    // No raw bytes to page on (a caller-built result): whole-content pass.
    return {
      content: await redactRunLogNdjsonAsync(result.content, opts?.extraSecrets, { signal: opts?.signal }),
      nextOffset: result.nextOffset,
      redactedAtPersist: false,
    };
  }
  const verifiedBytes = Math.max(0, Math.min(result.verifiedBytes ?? 0, buffer.length));
  let tailBytes = buffer.subarray(verifiedBytes);
  let nextOffset = result.nextOffset;
  const cap = Math.max(1, opts?.maxUnverifiedBytes ?? RUN_LOG_SERVE_MAX_UNVERIFIED_BYTES);
  if (typeof result.startOffset === "number" && tailBytes.length > cap) {
    // Cut just after the last newline inside the cap — on the raw file bytes
    // — so the next page starts a whole line (a secret is never split across
    // two redaction passes). A single line longer than the cap is kept whole.
    let cut = tailBytes.lastIndexOf(NEWLINE, cap - 1) + 1;
    if (cut <= 0) cut = tailBytes.indexOf(NEWLINE, cap) + 1;
    if (cut > 0 && cut < tailBytes.length) {
      tailBytes = tailBytes.subarray(0, cut);
      nextOffset = result.startOffset + verifiedBytes + cut;
    }
  }
  // The verified boundary sits just after a newline (or at 0), so decoding
  // the two halves separately equals decoding the range as one.
  const head = buffer.subarray(0, verifiedBytes).toString("utf8");
  const redactedTail = await redactRunLogNdjsonAsync(tailBytes.toString("utf8"), opts?.extraSecrets, {
    signal: opts?.signal,
  });
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
