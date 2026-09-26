// AgentDash: the control plane's only logger. It redacts by key and by value
// before anything reaches stdout (spec §3.3 "Secret rules"):
//   keys:   *SECRET*, *KEY*, *TOKEN*, *CODE*, password (case-insensitive)
//   values: AGD-… (any case), sk_…, rk_…, re_…, whsec_… anywhere inside a
//           string; Bearer/Basic credentials (with a space, ':' or '=');
//           URL passwords; `token=…`-style pairs in free text; a UUID after a
//           token word on the same line; email addresses, plain or
//           %40-encoded (hashed)
// A Secret instance always prints as [REDACTED]. Error objects keep their
// message and stack, both scrubbed.
import { createHash } from "node:crypto";
import { REDACTED, Secret } from "./secret.js";

const SECRET_KEY_RE = /secret|key|token|code|password|authorization|cookie/i;
// Value patterns: the prefix at a token boundary followed by token characters.
// Case-insensitive: a lowercased claim code (`agd-…`) is still a claim code
// (GH #763).
const SECRET_VALUE_RE = /(?<![A-Za-z0-9])(AGD-|sk_|rk_|re_|whsec_)[A-Za-z0-9_\-]+/gi;
// Bearer and Basic credentials in free text: everything up to whitespace
// (GH #778), so a token with unusual characters is not half-printed.
// `bearer:<token>` and `bearer=<token>` with no space are caught too (GH #763).
const AUTH_SCHEME_RE = /\b(Bearer|Basic)(?:\s+|\s*[:=]\s*)[^\s"'`,;]+/gi;
// Credentials inside URLs (postgres://user:pass@host).
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi;
// `name=value` and `"name": "value"` pairs in free text whose NAME is
// credential-like: `token=abc123`, `?api_key=…&`, `"secret":"…"` (GH #763).
// The same key words the structured redaction uses, so free text and fields
// agree.
const KV_SECRET_RE =
  /(["']?)\b([A-Za-z0-9_.\-]*(?:secret|token|key|code|password|passwd|credential|auth)[A-Za-z0-9_.\-]*)\1(\s*[:=]\s*)(["']?)(?!\[REDACTED\]|(?:Bearer|Basic)\b)[^\s"'&,;}\]]+/gi;
// A bare UUID near token context: Railway workspace and project tokens are
// UUIDs, so "token 3f0c…", "RAILWAY_API_TOKEN=3f0c…" and
// {"token":"3f0c…"} must not print it (GH #778). Anywhere later on the same
// line counts (GH #763: the old 24-character window let a longer gap
// through). A UUID with no such word before it on its line (a box or job id)
// is left alone.
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const CONTEXT_UUID_RE = new RegExp(
  `(token|secret|password|passwd|credential|api[_-]?key|authorization|auth|bearer)([^\\n]*?)(?<![0-9A-Fa-f-])${UUID}(?![0-9A-Fa-f])`,
  "gi",
);
// Email addresses are personal data: replace each with a short hash so log
// lines about the same person still correlate (GH #778).
const EMAIL_RE = /(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}/g;
// The same address URL-encoded (`founder%40example.com`, GH #763). Hashed as
// the decoded address so it correlates with the plain form.
const ENCODED_EMAIL_RE = /(?<![A-Za-z0-9._+\-])([A-Za-z0-9._+\-]+)%40([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})/gi;

export function hashEmail(email: string): string {
  return `[email:${createHash("sha256").update(email.toLowerCase(), "utf8").digest("hex").slice(0, 12)}]`;
}

export function redactString(value: string): string {
  return value
    .replace(SECRET_VALUE_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(AUTH_SCHEME_RE, (_m, word: string) => `${word} ${REDACTED}`)
    .replace(URL_CREDENTIALS_RE, (_m, head: string) => `${head}:${REDACTED}@`)
    .replace(CONTEXT_UUID_RE, (_m, word: string, gap: string) => `${word}${gap}${REDACTED}`)
    .replace(KV_SECRET_RE, (_m, q: string, name: string, sep: string, vq: string) => `${q}${name}${q}${sep}${vq}${REDACTED}`)
    .replace(ENCODED_EMAIL_RE, (_m, local: string, domain: string) => hashEmail(`${local}@${domain}`))
    .replace(EMAIL_RE, (m) => hashEmail(m));
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value instanceof Secret) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) && v !== null && v !== undefined && v !== "" ? REDACTED : redact(v, seen);
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(opts: {
  level?: LogLevel;
  write?: (line: string) => void;
  base?: Record<string, unknown>;
} = {}): Logger {
  const min = LEVELS[opts.level ?? "info"];
  const write = opts.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const base = opts.base ?? {};
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < min) return;
    const record = redact({ ...base, ...(fields ?? {}) }) as Record<string, unknown>;
    write(JSON.stringify({ time: new Date().toISOString(), level, msg: redactString(msg), ...record }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}
