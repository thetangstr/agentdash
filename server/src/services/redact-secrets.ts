// AgentDash: scrub secrets out of text that is about to be logged or shown.
//
// Adapter output reaches the server log and the chat's "CoS couldn't reply"
// card, and some providers echo part of the credential back on a 401. Callers
// pass the keys they know about; generic shapes are scrubbed regardless.

const REDACTED = "[redacted]";

const GENERIC_PATTERNS: RegExp[] = [
  // Authorization header values.
  /\b(?:[Bb]earer|BEARER|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  // Provider token prefixes: GitHub (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_) and xAI (xai-).
  /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xai-[A-Za-z0-9_-]{10,})/g,
  // Masked keys a provider prints back ("sk-proj-****abcd", "****abcd").
  /[A-Za-z0-9_-]*[*\u2022]{3,}[A-Za-z0-9_-]*/g,
  // sk-... style keys (OpenAI, Anthropic, MiniMax and friends).
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  // Z.AI style "<id>.<secret>" keys.
  /\b[A-Za-z0-9]{24,}\.[A-Za-z0-9]{8,}/g,
  // Long hex strings (tokens, digests).
  /(?<![\w-])[a-f0-9]{32,}\b/gi,
  // Long base64-ish tokens. Paths and profile names are not matched: they
  // contain "_", "-" or "." every few characters, which breaks the run.
  /(?<![\w-])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g,
];

const FIELD_NAME_SECRET =
  /(["']?(?:api[_-]?key|apikey|x-api-key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi;

/** Replace each known key and anything key-shaped with "[redacted]". */
export function redactSecrets(text: string, knownKeys: readonly (string | undefined | null)[] = []): string {
  let out = text;
  for (const key of knownKeys) {
    if (key && key.length >= 6) out = out.split(key).join(REDACTED);
  }
  for (const pattern of GENERIC_PATTERNS) out = out.replace(pattern, REDACTED);
  // Key-value secrets by field name: "api_key":"...", api_key=..., token: ...
  // (after the Bearer rule above, so "authorization: Bearer x" is covered whole).
  out = out.replace(FIELD_NAME_SECRET, `$1${REDACTED}`);
  return out;
}

/** Credentials this process was started with, for redacting adapter output. */
export function knownKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && /(API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(name)) keys.push(value);
  }
  return keys;
}
