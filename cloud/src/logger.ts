// AgentDash: the control plane's only logger. It redacts by key and by value
// before anything reaches stdout (spec §3.3 "Secret rules"):
//   keys:   *SECRET*, *KEY*, *TOKEN*, *CODE*, password (case-insensitive)
//   values: AGD-…, sk_…, rk_…, re_…, whsec_… anywhere inside a string
// A Secret instance always prints as [REDACTED]. Error objects keep their
// message and stack, both scrubbed.
import { REDACTED, Secret } from "./secret.js";

const SECRET_KEY_RE = /secret|key|token|code|password|authorization|cookie/i;
// Value patterns: the prefix at a token boundary followed by token characters.
const SECRET_VALUE_RE = /(?<![A-Za-z0-9])(AGD-|sk_|rk_|re_|whsec_)[A-Za-z0-9_\-]+/g;
// Bearer credentials in free text.
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/\-]+=*/gi;
// Credentials inside URLs (postgres://user:pass@host).
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi;

export function redactString(value: string): string {
  return value
    .replace(SECRET_VALUE_RE, (_m, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER_RE, (_m, word: string) => `${word} ${REDACTED}`)
    .replace(URL_CREDENTIALS_RE, (_m, head: string) => `${head}:${REDACTED}@`);
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
