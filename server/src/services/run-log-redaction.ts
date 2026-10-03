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

/** Stateful stream redactor for chunked adapter output (one per stream). */
export function createRunLogStreamRedactor(extraSecrets?: KnownSecrets) {
  return createSecretStreamRedactor(mergeSecrets(extraSecrets));
}
