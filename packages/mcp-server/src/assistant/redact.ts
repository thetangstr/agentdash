/**
 * AgentDash assistant MCP (M1, GH #676, spec §5 redaction): the last line of
 * defence between AgentDash internals and a personal assistant's context.
 *
 * The tools already build their outputs field-by-field; this module exists
 * because "already careful" is not a guarantee. Anything serialized for the
 * assistant passes through `redactAssistantValue`, and `findForbiddenPaths`
 * gives the test the same wire-bytes pin `steward-webhooks.test.ts` uses.
 *
 * Forbidden in output, per spec: adapter config, env maps, keys, secrets,
 * raw `contextSnapshot` (only the #654 summarized projection may pass), run
 * logs, connector credentials, budgets, ceilings, mandates, directives, and
 * other people's inbox material.
 */

/** Key names that must never reach the assistant, matched case-insensitively. */
const FORBIDDEN_KEYS = new Set([
  "adapterconfig",
  "adapterconfigjson",
  "env",
  "environment",
  "environmentlease",
  "apikey",
  "apikeys",
  "apikeyhash",
  "token",
  "tokens",
  "secret",
  "secrets",
  "contextsnapshot",
  "stdoutexcerpt",
  "stderrexcerpt",
  "stdout",
  "stderr",
  "logbytes",
  "logs",
  "budget",
  "budgets",
  "ceiling",
  "ceilings",
  "mandate",
  "mandates",
  "directive",
  "directives",
  "agentdirectives",
  "instructionsbundle",
  "instructions",
  "authconfig",
  "authconfigjson",
  "connectorsecret",
  "connectorsecrets",
  "credentials",
  "privatekey",
  "refreshtoken",
  "accesstoken",
]);

/** String shapes that are secrets wherever they appear inside a value. */
const SECRET_VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bpcp_[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted-key]" },
  // M2 assistant OAuth tokens (access + refresh) — same treatment as pcp_ keys.
  { pattern: /\bpcp[ar]_[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted-key]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted-key]" },
  { pattern: /\bghp_[A-Za-z0-9]{8,}\b/g, replacement: "[redacted-key]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, replacement: "[redacted-key]" },
  { pattern: /\bxox[bpoars]-[A-Za-z0-9-]{8,}\b/g, replacement: "[redacted-key]" },
  { pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, replacement: "[redacted-key]" },
  { pattern: /Bearer\s+\S+/gi, replacement: "[redacted-token]" },
];

/** Email addresses are personal data — only the caller's own may pass. */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export interface RedactOptions {
  /** Emails that may appear unredacted — the caller's own, per spec. */
  allowEmails?: readonly string[];
}

function isAllowedEmail(email: string, opts?: RedactOptions): boolean {
  const allowed = opts?.allowEmails;
  if (!allowed || allowed.length === 0) return false;
  const needle = email.toLowerCase();
  return allowed.some((entry) => entry.toLowerCase() === needle);
}

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key.replace(/[^a-z]/gi, "").toLowerCase());
}

function scrubString(value: string, opts?: RedactOptions): string {
  let out = value;
  for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(EMAIL_PATTERN, (match) =>
    isAllowedEmail(match, opts) ? match : "[redacted-email]",
  );
}

/**
 * Deep-clone `value` with forbidden object keys removed and secret-looking
 * strings scrubbed. Unknown shapes pass through — the tools own field
 * selection; this removes what must never survive.
 */
export function redactAssistantValue<T>(value: T, opts?: RedactOptions): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value, opts) as T;
  if (Array.isArray(value)) return value.map((item) => redactAssistantValue(item, opts)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenKey(key)) continue;
      out[key] = redactAssistantValue(item, opts);
    }
    return out as T;
  }
  return value;
}

/**
 * Every path in `value` that carries a forbidden key or a secret-looking
 * string — the assertion surface for the wire-bytes test. Empty array means
 * the output is clean.
 */
export function findForbiddenPaths(value: unknown, opts?: RedactOptions, path = ""): string[] {
  const found: string[] = [];
  if (value === null || value === undefined) return found;
  if (typeof value === "string") {
    for (const { pattern } of SECRET_VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) found.push(path || "(value)");
    }
    EMAIL_PATTERN.lastIndex = 0;
    for (const match of value.matchAll(EMAIL_PATTERN)) {
      if (!isAllowedEmail(match[0], opts)) found.push(path || "(value)");
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...findForbiddenPaths(item, opts, `${path}[${index}]`));
    });
    return found;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key;
      if (isForbiddenKey(key)) {
        found.push(next);
        continue;
      }
      found.push(...findForbiddenPaths(item, opts, next));
    }
  }
  return found;
}
