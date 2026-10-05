// AgentDash (GH #992): the pattern set moved to `packages/shared` so the UI's
// display hygiene and the server's run-log redaction share one implementation.
// Server-side persistence redacts before storage; this re-export keeps the
// existing UI import paths working.
//
// AgentDash (c3-a11y): stored text reaches the UI with several different mask
// spellings — the shared "***REDACTED***", the server's "[REDACTED…]" family
// and "[redacted-github-token]", and the env block's "***SECRET_REF***". The
// wrappers below present ONE owner-friendly mask on screen. Stored values are
// untouched — this is display-only.
import {
  redactSecrets as sharedRedactSecrets,
  redactSecretsInValue as sharedRedactSecretsInValue,
  type KnownSecrets,
} from "@paperclipai/shared";

export {
  REDACTED,
  CREDENTIALS_HIDDEN_NOTE,
  isSecretName,
  containsSecrets,
} from "@paperclipai/shared";

// Parenthesised so the mask is a self-contained unit: a bare "hidden" word
// gets parsed as an email local part ("•••• hidden@db.internal" autolinks to
// mailto:) and merges into adjacent punctuation ("KEY = •••• hidden"]").
// "(hidden)" can neither autolink nor be mistaken for source text.
export const SECRET_MASK_DISPLAY = "•••• (hidden)";

// The "(?: ... hidden ...)?" tail keeps the wrapper idempotent: re-redacting
// display text redacts the "••••" run as a value, emitting
// "***REDACTED*** (hidden)" (or "***REDACTED*** hidden" from the pre-c4
// mask spelling), which must collapse back to one mask. The (?!\w) stop
// keeps "hiddenly"-style words from being eaten.
const KNOWN_MASK_RE =
  /\*\*\*(?:REDACTED|SECRET_REF)\*\*\*(?:\s*\(?hidden(?!\w)\)?)?|\[(?:REDACTED(?:_[A-Z]+)*|redacted-(?:github-token|key|token))\]/g;

/** Rewrite every baked-in mask marker to the one display mask. */
export function displayMaskedSecrets(text: string): string {
  if (!text || !/redacted|secret_ref/i.test(text)) return text;
  return text.replace(KNOWN_MASK_RE, SECRET_MASK_DISPLAY);
}

export function redactSecrets(text: string, knownSecrets?: KnownSecrets): string {
  return displayMaskedSecrets(sharedRedactSecrets(text, knownSecrets));
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn)) as T;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn);
    return out as T;
  }
  return value;
}

export function redactSecretsInValue<T>(value: T, knownSecrets?: KnownSecrets): T {
  return mapStrings(sharedRedactSecretsInValue(value, knownSecrets), displayMaskedSecrets);
}
