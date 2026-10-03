// AgentDash (scan 4 lane O1, GH #992): credential redaction shared by the UI
// (display hygiene, PR #990) and the server (run logs persisted and served).
// Agents run shell commands that carry credentials (curl headers, env
// assignments, DSNs, JSON bodies), and tools echo them back. One pattern set
// keeps the redaction identical on both sides.
//
// The patterns are anchored so ordinary text survives: `KEYBOARD=us`,
// `echo MONKEY=banana`, `grep 'TOKEN=' src` and prose such as
// "Authorization: required for this endpoint" are left alone.

export const REDACTED = "***REDACTED***";

/** Name segments that mark an env var / query parameter as a credential. */
const SECRET_NAME_SEGMENTS = new Set([
  "TOKEN", "KEY", "APIKEY", "SECRET", "PASSWORD", "PASSWD", "AUTHORIZATION", "JWT", "CREDENTIAL", "CREDENTIALS",
  "COOKIE", "SIGNATURE",
]);

/** `PAPERCLIP_API_KEY`, `api_key`, `access_token`, `key` — but not `KEYBOARD` or `MONKEY`. */
export function isSecretName(name: string): boolean {
  const segments = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[_\-.]+/)
    .filter(Boolean);
  return segments.some((segment) => SECRET_NAME_SEGMENTS.has(segment));
}

/** A header value with no auth scheme is redacted only when it looks like a credential, not prose. */
function looksLikeCredential(value: string): boolean {
  if (value.length >= 20) return true;
  return /[0-9$_.=+/-]/.test(value);
}

// Obfuscation defeats patterns: zero-width characters inside a header name
// ("Authori​zation") and `\u00xx` escapes inside a JSON key ("api\u005fkey")
// carry the credential past literal matching. The normalization strips
// zero-width codepoints and decodes `\u00xx` escapes that decode to an
// identifier-ish character — quotes and backslashes are deliberately left
// escaped so NDJSON/JSON structure is never corrupted.
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const UNICODE_ESCAPE_RE = /(?<!\\)\\u00([0-9a-fA-F]{2})/g;

function normalizeForDetection(text: string): string {
  const withoutZeroWidth = text.replace(ZERO_WIDTH_RE, "");
  return withoutZeroWidth.replace(UNICODE_ESCAPE_RE, (match, hex: string) => {
    const decoded = String.fromCharCode(parseInt(hex, 16));
    return /^[A-Za-z0-9_.-]$/.test(decoded) ? decoded : match;
  });
}

const AUTH_SCHEMES = "(?:Bearer|Basic|Token|Digest|Bot|ApiKey|Key|Negotiate|AWS4-HMAC-SHA256)";

// Authorization-style headers: `Authorization: Bearer x`, `x-api-key: x`,
// `X-Goog-Api-Key: x`, `api-key: x`, `PRIVATE-TOKEN: x`, `x-access-token: x`.
// The value runs to the closing quote; an escaped quote inside it is part of it.
const AUTH_HEADER_RE = new RegExp(
  String.raw`(\b(?:proxy-)?authorization|\bprivate-token|(?:\bx-[\w-]*?)?\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret))(\s*:\s*)(?:(${AUTH_SCHEMES})(\s+))?((?:\\.|[^\s"'\\,;])+)`,
  "gi",
);
// Cookie headers: everything to the end of the quoted value / line.
const COOKIE_HEADER_RE = /(\b(?:set-)?cookie\s*:\s*)((?:\\.|[^"'\n\\])+)/gi;
// `NAME=value` (env assignment, query parameter, form field) for a credential name.
const ASSIGNMENT_RE = /(^|[\s;&|?("'`])([A-Za-z_][A-Za-z0-9_.-]*)=("[^"\n]*"|'[^'\n]*'|[^\s"'`;&|()]+)/g;
// `scheme://user:pass@host`.
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"']+):([^\s/@"']+)@/gi;
// `scheme://TOKEN@host` — a credential as the whole userinfo with no
// `user:` prefix. Only when the value looks credential-ish: `ssh://git@` and
// `https://user@` are left alone.
const URL_BARE_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:"'\\]{4,})@/gi;
// curl `-u user:pass` / `--user user:pass`.
const CURL_USER_RE = /(\s(?:-u|--user)(?:\s+|=))(["']?)([^\s"':]+):([^\s"']+)\2/g;
// curl `-b "name=value"` / `--cookie` (a cookie file path has no `=` and is kept).
const CURL_COOKIE_RE = /(\s(?:-b|--cookie)(?:\s+|=))("[^"\n]*=[^"\n]*"|'[^'\n]*=[^'\n]*'|[^\s"']*=[^\s"']*)/g;
// mysql / mariadb `-p<password>` (no space). Only on those commands: elsewhere `-p8080` is a port.
const MYSQL_LINE_RE = /\b(?:mysql\w*|mariadb\w*)\b[^\n]*/g;
const MYSQL_PASSWORD_RE = /(\s-p)(?!\s)([^\s"']+)/g;
// `--password x`, `--token=x`, `--api-key x`, `--client-secret=x`.
const CLI_SECRET_OPTION_RE =
  /((?:^|\s)--?(?:api[-_]?key|(?:access[-_]?|auth[-_]?|refresh[-_]?)?token|password|passwd|secret|client[-_]?secret|private[-_]?key|credentials?)(?:\s+|=))(["']?)(?!-)([^\s"']+)\2/gim;
// JSON keys in bodies and responses: `"password": "x"`, `"apiKey":"x"`. Also
// the escaped form inside a JSON string (`\"token\":\"x\"`).
const JSON_KEYS = String.raw`(?:api[_-]?key|apiKey|token|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|id[_-]?token|secret|client[_-]?secret|clientSecret|password|passwd|private[_-]?key|privateKey|authorization)`;
const JSON_SECRET_RE = new RegExp(String.raw`("${JSON_KEYS}"\s*:\s*)"(?:\\.|[^"\\])*"`, "gi");
const ESCAPED_JSON_SECRET_RE = new RegExp(String.raw`(\\"${JSON_KEYS}\\"\s*:\s*)\\"(?:\\\\.|[^"\\])*\\"`, "gi");
// `Bearer <token>` anywhere (JSON bodies, logs).
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/g;
// Well-known key shapes.
const KEY_SHAPES: RegExp[] = [
  // Stripe secret / restricted keys and webhook signing secrets.
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{10,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // xAI keys (xai-…).
  /\bxai-[A-Za-z0-9_-]{10,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Paperclip agent API keys (`pcp_…`), board keys (`pcp_board_…`) and CLI auth
  // tokens (`pcp_cli_auth_…`) share the prefix, so this covers all three.
  /\bpcp_[A-Za-z0-9_-]{8,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g,
];

function redactAssignmentValue(value: string): string {
  if (value === '""' || value === "''" || value === "") return value;
  // A variable reference or command substitution is not itself a secret.
  if (/^["']?\$/.test(value)) return value;
  if (value.startsWith('"')) return `"${REDACTED}"`;
  if (value.startsWith("'")) return `'${REDACTED}'`;
  return REDACTED;
}

export type KnownSecrets = readonly (string | null | undefined)[];

function toBase64(secret: string): string | null {
  try {
    if (typeof Buffer !== "undefined") return Buffer.from(secret, "utf8").toString("base64");
    if (typeof btoa !== "undefined") return btoa(unescape(encodeURIComponent(secret)));
  } catch {
    // fall through — encoding a weird value must never break redaction
  }
  return null;
}

function toHex(secret: string): string {
  let out = "";
  for (let i = 0; i < secret.length; i++) out += secret.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

/**
 * Alternate spellings of a known secret: the encodings a command would carry
 * (`echo $KEY | base64`, hex dumps, URL-encoded form bodies). Only forms
 * long enough that they cannot appear by accident are matched.
 */
function secretEncodedForms(secret: string): string[] {
  const forms: string[] = [];
  const b64 = toBase64(secret);
  if (b64 && b64.length >= 8 && b64 !== secret) forms.push(b64);
  if (b64) {
    const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (b64url.length >= 8 && b64url !== secret && b64url !== b64) forms.push(b64url);
  }
  const hex = toHex(secret);
  if (hex.length >= 16 && hex !== secret) forms.push(hex);
  const urlEncoded = encodeURIComponent(secret);
  if (urlEncoded.length >= 8 && urlEncoded !== secret) forms.push(urlEncoded);
  return forms;
}

/**
 * Windows of a known secret, so a key split across innocuous assignments
 * (`A=sk-proj-4f8a… B=…z9q2`) still hides each half. Only token-shaped
 * secrets get fragment matching — fragments of a spaced passphrase could be
 * ordinary words. A fragment needs 14 characters, so a 2-way split of a
 * 28+ character secret is caught on both sides.
 */
const SECRET_FRAGMENT_LENGTH = 14;

function secretFragments(secret: string): string[] {
  if (secret.length < 20 || /\s/.test(secret)) return [];
  const fragments = new Set<string>();
  for (let i = 0; i + SECRET_FRAGMENT_LENGTH <= secret.length; i++) {
    fragments.add(secret.slice(i, i + SECRET_FRAGMENT_LENGTH));
  }
  return [...fragments];
}

/**
 * Exact-match redaction for secrets the caller knows verbatim (configured
 * provider keys, resolved run-env secret values, injected run tokens), plus
 * their encoded forms and windows long enough to survive a split. Values
 * shorter than 6 characters are ignored — a tiny string would shred prose.
 */
function redactKnownSecrets(text: string, knownSecrets: KnownSecrets | undefined): string {
  if (!knownSecrets || knownSecrets.length === 0) return text;
  const secrets = [...new Set(knownSecrets)]
    .filter((secret): secret is string => typeof secret === "string" && secret.length >= 6)
    .sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return text;
  let out = text;
  const fragments: string[] = [];
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    for (const form of secretEncodedForms(secret)) {
      if (out.includes(form)) out = out.split(form).join(REDACTED);
    }
    fragments.push(...secretFragments(secret));
  }
  // Fragments run last and only where the full secret does not appear — a
  // whole key is one REDACTED marker, not one per window.
  for (const fragment of fragments) {
    if (out.includes(fragment)) out = out.split(fragment).join(REDACTED);
  }
  return out;
}

/**
 * Hide credentials in text. Idempotent.
 *
 * `knownSecrets` are replaced verbatim first, so a configured key that matches
 * no pattern is still hidden; the anchored pattern set then covers everything
 * key-shaped.
 */
export function redactSecrets(text: string, knownSecrets?: KnownSecrets): string {
  if (!text) return text;
  let out = normalizeForDetection(text);
  out = redactKnownSecrets(out, knownSecrets);
  out = out.replace(COOKIE_HEADER_RE, (_m, head: string) => `${head}${REDACTED}`);
  out = out.replace(AUTH_HEADER_RE, (match, name: string, sep: string, scheme: string | undefined, gap: string | undefined, value: string) => {
    if (value === REDACTED || value.startsWith("***")) return match;
    if (!scheme && !looksLikeCredential(value)) return match;
    return `${name}${sep}${scheme ? `${scheme}${gap}` : ""}${REDACTED}`;
  });
  out = out.replace(URL_USERINFO_RE, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
  out = out.replace(URL_BARE_USERINFO_RE, (match, scheme: string, user: string) =>
    looksLikeCredential(user) ? `${scheme}${REDACTED}@` : match);
  out = out.replace(CURL_USER_RE, (_m, flag: string, quote: string, user: string) => `${flag}${quote}${user}:${REDACTED}${quote}`);
  out = out.replace(CURL_COOKIE_RE, (_m, flag: string, value: string) => {
    const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
    return `${flag}${quote}${REDACTED}${quote}`;
  });
  out = out.replace(MYSQL_LINE_RE, (line) => line.replace(MYSQL_PASSWORD_RE, (_m, flag: string) => `${flag}${REDACTED}`));
  out = out.replace(CLI_SECRET_OPTION_RE, (_m, flag: string, quote: string) => `${flag}${quote}${REDACTED}${quote}`);
  out = out.replace(ASSIGNMENT_RE, (match, lead: string, name: string, value: string) => {
    if (!isSecretName(name)) return match;
    const redacted = redactAssignmentValue(value);
    return redacted === value ? match : `${lead}${name}=${redacted}`;
  });
  out = out.replace(JSON_SECRET_RE, (_m, head: string) => `${head}"${REDACTED}"`);
  out = out.replace(ESCAPED_JSON_SECRET_RE, (_m, head: string) => `${head}\\"${REDACTED}\\"`);
  out = out.replace(BEARER_RE, (_m, head: string) => `${head}${REDACTED}`);
  for (const shape of KEY_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/** True when `redactSecrets` would hide something in `text`. */
export function containsSecrets(text: string, knownSecrets?: KnownSecrets): boolean {
  return redactSecrets(text, knownSecrets) !== text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `redactSecrets` over every string in a tool input or result, plus any
 * object value under a credential-named key (`{ "apiKey": "…" }`), so the
 * value is redacted before it is pretty-printed. Non-plain objects (Date,
 * class instances) pass through untouched.
 */
export function redactSecretsInValue<T>(value: T, knownSecrets?: KnownSecrets): T {
  if (typeof value === "string") return redactSecrets(value, knownSecrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactSecretsInValue(item, knownSecrets)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] =
        typeof item === "string" && item && isSecretName(key) && !/^(?:id|key)$/i.test(key)
          ? REDACTED
          : redactSecretsInValue(item, knownSecrets);
    }
    return out as T;
  }
  return value;
}

/**
 * Redact output delivered in chunks. Emitted text only ever ends at a line
 * boundary, and no pattern spans a newline, so the stream result matches
 * redacting the joined text — a secret cut by a chunk boundary is still
 * caught. When a single line grows past `maxHold` it is emitted anyway so
 * memory stays bounded (the GH redactor upstream accepts the same bound).
 */
export function createSecretStreamRedactor(
  knownSecrets?: KnownSecrets,
  maxHold = 64 * 1024,
): { push(chunk: string): string; flush(): string } {
  let held = "";
  return {
    push(chunk: string): string {
      if (!chunk) return "";
      const text = held + chunk;
      const lastNewline = text.lastIndexOf("\n");
      const emitEnd = lastNewline >= 0 ? lastNewline + 1 : 0;
      if (emitEnd > 0 && text.length - emitEnd <= maxHold) {
        held = text.slice(emitEnd);
        return redactSecrets(text.slice(0, emitEnd), knownSecrets);
      }
      // Either no newline yet, or one line exceeds maxHold: hold when the
      // buffer is still small, otherwise emit it all so memory stays bounded.
      if (text.length <= maxHold) {
        held = text;
        return "";
      }
      held = "";
      return redactSecrets(text, knownSecrets);
    },
    flush(): string {
      const rest = held;
      held = "";
      return rest ? redactSecrets(rest, knownSecrets) : "";
    },
  };
}

/** Shown in Raw views, where redacted text could otherwise read as the real log. */
export const CREDENTIALS_HIDDEN_NOTE = "Credentials in this log are hidden.";
