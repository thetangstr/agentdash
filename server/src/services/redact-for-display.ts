// AgentDash: scrub text bound for the server log or the chat of every secret
// this box knows: credentials in the process environment and the provider key
// in the managed Hermes template profile's `.env`, plus generic key shapes.
import { configuredProviderKeysSync } from "./hermes-provider-setup.js";
import { knownKeysFromEnv, redactSecrets } from "./redact-secrets.js";

// Adapter stdout/stderr is unbounded and the display paths only ever show a
// short tail anyway (describeAdapterFailure caps at ~600 chars, the dispatch
// card at 240). Scanning more than the tail would just buy worst-case input.
const DISPLAY_REDACT_MAX_INPUT = 64 * 1024;

export function redactForDisplay(text: string): string {
  const input =
    text.length > DISPLAY_REDACT_MAX_INPUT ? text.slice(-DISPLAY_REDACT_MAX_INPUT) : text;
  return redactSecrets(input, [...knownKeysFromEnv(), ...configuredProviderKeysSync()]);
}
