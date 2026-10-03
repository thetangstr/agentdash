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
    .map((line) => {
      if (!line.startsWith("{")) return redactSecrets(line, secrets);
      try {
        return JSON.stringify(redactSecretsInValue(JSON.parse(line), secrets));
      } catch {
        return redactSecrets(line, secrets);
      }
    })
    .join("\n");
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
