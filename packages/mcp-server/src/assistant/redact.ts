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
  { pattern: /Bearer\s+\S+/gi, replacement: "[redacted-token]" },
];

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key.replace(/[^a-z]/gi, "").toLowerCase());
}

function scrubString(value: string): string {
  let out = value;
  for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Deep-clone `value` with forbidden object keys removed and secret-looking
 * strings scrubbed. Unknown shapes pass through — the tools own field
 * selection; this removes what must never survive.
 */
export function redactAssistantValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactAssistantValue(item)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isForbiddenKey(key)) continue;
      out[key] = redactAssistantValue(item);
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
export function findForbiddenPaths(value: unknown, path = ""): string[] {
  const found: string[] = [];
  if (value === null || value === undefined) return found;
  if (typeof value === "string") {
    for (const { pattern } of SECRET_VALUE_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) found.push(path || "(value)");
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...findForbiddenPaths(item, `${path}[${index}]`));
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
      found.push(...findForbiddenPaths(item, next));
    }
  }
  return found;
}
