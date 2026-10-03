// AgentDash: scrub secrets out of text that is about to be logged or shown.
//
// Adapter output reaches the server log and the chat's "CoS couldn't reply"
// card, and some providers echo part of the credential back on a 401. Callers
// pass the keys they know about; generic shapes are scrubbed regardless.
//
// The anchored pattern set lives in `@paperclipai/shared` so the UI and the
// server share one implementation (GH #992). This wrapper adds exact-match
// known-key scrubbing plus server-only extra patterns for provider error
// text: masked key echoes ("sk-proj-****abcd"), Z.AI "<id>.<secret>" keys,
// and long hex/base64 blobs. The extras are deliberately NOT applied to run
// logs — long-hex would shred git SHAs in transcripts.
import { redactSecrets as redactSharedSecrets, isSecretName, REDACTED } from "@paperclipai/shared";

const MASKED_KEY_RE = /[A-Za-z0-9_-]*[*•]{3,}[A-Za-z0-9_-]*/g;

const FIELD_NAME_SECRET =
  /(["']?(?:api[_-]?key|apikey|x-api-key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi;

const BASIC_SCHEME_RE = /(\bBasic\s+)[A-Za-z0-9._~+/=-]{8,}/g;

const EXTRA_PATTERNS: RegExp[] = [
  // Z.AI style "<id>.<secret>" keys.
  /\b[A-Za-z0-9]{24,}\.[A-Za-z0-9]{8,}/g,
  // Long hex strings (tokens, digests).
  /(?<![\w-])[a-f0-9]{32,}\b/gi,
  // Long base64-ish tokens. Paths and profile names are not matched: they
  // contain "_", "-" or "." every few characters, which breaks the run.
  /(?<![\w-])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g,
];

// A masked key echoed by a provider, e.g. "sk-proj-****abcd" or "****abcd".
// The adjacency guard keeps the `***REDACTED***` marker itself (and markdown
// emphasis) from being mangled on a second pass.
function redactMaskedKeys(text: string): string {
  return text.replace(MASKED_KEY_RE, (match: string, offset: number, whole: string) => {
    if (match.includes("REDACTED")) return match;
    const before = whole.slice(Math.max(0, offset - 8), offset);
    const after = whole.slice(offset + match.length, offset + match.length + 8);
    if (before.endsWith("REDACTED") || after.startsWith("REDACTED")) return match;
    return REDACTED;
  });
}

/** Replace each known key and anything key-shaped with "***REDACTED***". */
export function redactSecrets(text: string, knownKeys: readonly (string | undefined | null)[] = []): string {
  let out = redactSharedSecrets(text, knownKeys);
  out = redactMaskedKeys(out);
  // `Basic <credentials>` anywhere (shared covers `Bearer` already).
  out = out.replace(BASIC_SCHEME_RE, `$1${REDACTED}`);
  for (const pattern of EXTRA_PATTERNS) out = out.replace(pattern, REDACTED);
  // Key-value secrets by field name: "api_key":"...", api_key=..., token: ...
  out = out.replace(FIELD_NAME_SECRET, (match: string, head: string, offset: number, whole: string) => {
    const value = match.slice(head.length);
    if (value.startsWith("*")) return match;
    // `Authorization: Bearer ***REDACTED***` — the shared pass left the scheme
    // word in front of the marker; re-redacting "Bearer" would mangle it.
    if (
      /^(?:Bearer|Basic|Token|Digest|ApiKey|Key|Negotiate)$/i.test(value)
      && whole.slice(offset + match.length).trimStart().startsWith("*")
    ) {
      return match;
    }
    return `${head}${REDACTED}`;
  });
  return out;
}

/** Credentials this process was started with, for redacting adapter output. */
export function knownKeysFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    // `AWS_SECRET_ACCESS_KEY`, `PGPASSWORD`, `*_PRIVATE_KEY`, `*_MASTER_KEY`,
    // `*SECRET_KEY` — any credential-named variable, not just the classic four.
    if (value.length >= 8 && (isSecretName(name) || /_?KEY$/i.test(name))) keys.push(value);
    // DSNs carry their password inline: postgres://user:pass@host.
    const dsn = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@"']+:([^\s/"']+)@/i.exec(value);
    if (dsn && dsn[1].length >= 6) keys.push(dsn[1]);
  }
  return keys;
}
