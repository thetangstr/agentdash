// AgentDash (scan 4 lane O1): display hygiene for run transcripts. Agents run
// shell commands that carry credentials (curl headers, env assignments, DSNs,
// JSON bodies), and tools echo them back. Everything the transcript shows a
// person (collapsed rows, expanded input and output, Details, Raw mode, the
// issue chat) passes through `redactSecrets` first.
//
// This is display only: the stored run log is not changed here. Server-side
// log redaction is a separate follow-up.
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
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
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

/** Hide credentials in text shown to people. Idempotent. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(COOKIE_HEADER_RE, (_m, head: string) => `${head}${REDACTED}`);
  out = out.replace(AUTH_HEADER_RE, (match, name: string, sep: string, scheme: string | undefined, gap: string | undefined, value: string) => {
    if (value === REDACTED || value.startsWith("***")) return match;
    if (!scheme && !looksLikeCredential(value)) return match;
    return `${name}${sep}${scheme ? `${scheme}${gap}` : ""}${REDACTED}`;
  });
  out = out.replace(URL_USERINFO_RE, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
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
export function containsSecrets(text: string): boolean {
  return redactSecrets(text) !== text;
}

/**
 * `redactSecrets` over every string in a tool input or result, plus any
 * object value under a credential-named key (`{ "apiKey": "…" }`), so the
 * value is redacted before it is pretty-printed.
 */
export function redactSecretsInValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSecretsInValue(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        typeof item === "string" && item && isSecretName(key) && !/^(?:id|key)$/i.test(key)
          ? REDACTED
          : redactSecretsInValue(item);
    }
    return out as T;
  }
  return value;
}

/** Shown in Raw views, where redacted text could otherwise read as the real log. */
export const CREDENTIALS_HIDDEN_NOTE = "Credentials in this log are hidden.";
