// AgentDash: scrub text bound for the server log or the chat of every secret
// this box knows: credentials in the process environment and the provider key
// in the managed Hermes template profile's `.env`, plus generic key shapes.
import { configuredProviderKeysSync } from "./hermes-provider-setup.js";
import { knownKeysFromEnv, redactSecrets } from "./redact-secrets.js";

export function redactForDisplay(text: string): string {
  return redactSecrets(text, [...knownKeysFromEnv(), ...configuredProviderKeysSync()]);
}
