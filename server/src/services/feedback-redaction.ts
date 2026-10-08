import type { AsyncRedactionOptions } from "@paperclipai/shared";
import { createHash } from "node:crypto";
import { redactCurrentUserText } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { redactRunLogText, redactRunLogTextAsync } from "./run-log-redaction.js";

export type FeedbackRedactionState = {
  redactedFields: Set<string>;
  truncatedFields: Set<string>;
  omittedFields: Set<string>;
  notes: Set<string>;
  counts: Map<string, number>;
};

type PatternReplacement = string | ((match: string, ...args: string[]) => string);

type RedactionPattern = {
  kind: string;
  regex: RegExp;
  replacement: PatternReplacement;
};

const SECRET_ASSIGNMENT_RE =
  /\b(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)\s*[:=]\s*([^\s,;]+)/gi;

const FREE_TEXT_PATTERNS: RedactionPattern[] = [
  {
    kind: "pem_block",
    regex: /-----BEGIN [^-]+-----[\s\S]+?-----END [^-]+-----/g,
    replacement: "[REDACTED_PEM_BLOCK]",
  },
  {
    kind: "secret_assignment",
    regex: SECRET_ASSIGNMENT_RE,
    replacement: (_match, key: string) => `${key}=[REDACTED]`,
  },
  {
    kind: "bearer_token",
    regex: /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    kind: "github_token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    kind: "provider_api_key",
    regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{12,}\b/g,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    kind: "jwt",
    regex: /\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    kind: "dsn",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|kafka|nats|mssql):\/\/[^\s<>'")]+/gi,
    replacement: "[REDACTED_CONNECTION_STRING]",
  },
  {
    kind: "email",
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    kind: "phone",
    regex: /(?<!\w)(?:\+?\d[\d ()-]{7,}\d)(?!\w)/g,
    replacement: "[REDACTED_PHONE]",
  },
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function increment(state: FeedbackRedactionState, kind: string, count: number) {
  if (count <= 0) return;
  state.counts.set(kind, (state.counts.get(kind) ?? 0) + count);
}

function recordField(state: FeedbackRedactionState, fieldPath: string) {
  if (fieldPath.trim().length === 0) return;
  state.redactedFields.add(fieldPath);
}

function applyPattern(input: string, pattern: RedactionPattern) {
  const matches = Array.from(input.matchAll(pattern.regex)).length;
  if (matches === 0) {
    pattern.regex.lastIndex = 0;
    return { output: input, matches: 0 };
  }
  const output = input.replace(pattern.regex, pattern.replacement as never);
  pattern.regex.lastIndex = 0;
  return { output, matches };
}

export function createFeedbackRedactionState(): FeedbackRedactionState {
  return {
    redactedFields: new Set<string>(),
    truncatedFields: new Set<string>(),
    omittedFields: new Set<string>(),
    notes: new Set<string>(),
    counts: new Map<string, number>(),
  };
}

export function sanitizeFeedbackText(
  input: string,
  state: FeedbackRedactionState,
  fieldPath: string,
  maxLength: number,
) {
  let output = redactCurrentUserText(input);
  if (output !== input) {
    recordField(state, fieldPath);
    increment(state, "current_user", 1);
  }

  // AgentDash (GH #992): the shared pattern set plus this instance's known
  // keys — the bundle leaves the box, so pcp_/xai-/provider keys and the
  // configured Hermes key must be gone before it does.
  const secretResult = redactRunLogText(output);
  if (secretResult !== output) {
    output = secretResult;
    recordField(state, fieldPath);
    increment(state, "shared_secret", 1);
  }

  for (const pattern of FREE_TEXT_PATTERNS) {
    const result = applyPattern(output, pattern);
    if (result.matches > 0) {
      output = result.output;
      recordField(state, fieldPath);
      increment(state, pattern.kind, result.matches);
    }
  }

  if (output.length > maxLength) {
    output = `${output.slice(0, Math.max(0, maxLength - 1))}...`;
    state.truncatedFields.add(fieldPath);
  }

  return output;
}

// AgentDash: keep whole-input regex context (PEM, quoted multiline values and
// whitespace-separated labels). Checkpoints never split a credential match.
function mergeState(target: FeedbackRedactionState, source: FeedbackRedactionState) {
  for (const key of ["redactedFields", "truncatedFields", "omittedFields", "notes"] as const) {
    for (const value of source[key]) target[key].add(value);
  }
  for (const [kind, count] of source.counts) increment(target, kind, count);
}

function feedbackCheckpoint(opts?: AsyncRedactionOptions) {
  let started = performance.now();
  return async () => {
    opts?.signal?.throwIfAborted();
    if (performance.now() - started < (opts?.sliceMs ?? 8)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    opts?.signal?.throwIfAborted();
    started = performance.now();
  };
}

export async function sanitizeFeedbackTextAsync(
  input: string,
  state: FeedbackRedactionState,
  fieldPath: string,
  maxLength: number,
  opts?: AsyncRedactionOptions,
): Promise<string> {
  opts?.signal?.throwIfAborted();
  const pending = createFeedbackRedactionState();
  const checkpoint = feedbackCheckpoint(opts);
  let output = redactCurrentUserText(input);
  if (output !== input) {
    recordField(pending, fieldPath);
    increment(pending, "current_user", 1);
  }
  await checkpoint();
  const secretResult = await redactRunLogTextAsync(output, undefined, opts);
  if (secretResult !== output) {
    output = secretResult;
    recordField(pending, fieldPath);
    increment(pending, "shared_secret", 1);
  }
  for (const pattern of FREE_TEXT_PATTERNS) {
    await checkpoint();
    // matchAll owns its regex cursor; no shared lastIndex survives an await.
    const parts: string[] = [];
    let cursor = 0;
    let count = 0;
    for (const match of output.matchAll(pattern.regex)) {
      parts.push(output.slice(cursor, match.index));
      parts.push(typeof pattern.replacement === "string"
        ? pattern.replacement
        : pattern.replacement(match[0], ...match.slice(1)));
      cursor = match.index + match[0].length;
      if (++count % 128 === 0) await checkpoint();
    }
    if (count > 0) {
      parts.push(output.slice(cursor));
      output = parts.join("");
      recordField(pending, fieldPath);
      increment(pending, pattern.kind, count);
    }
  }
  if (output.length > maxLength) {
    output = `${output.slice(0, Math.max(0, maxLength - 1))}...`;
    pending.truncatedFields.add(fieldPath);
  }
  opts?.signal?.throwIfAborted();
  mergeState(state, pending);
  return output;
}

/** Same structured-key policy as sanitizeFeedbackValue, yielding between values. */
export async function sanitizeFeedbackValueAsync(
  value: unknown,
  state: FeedbackRedactionState,
  fieldPath: string,
  maxStringLength: number,
  opts?: AsyncRedactionOptions & { sanitizeKeys?: boolean; sanitizeNumbers?: boolean },
): Promise<unknown> {
  if (typeof value === "string") return sanitizeFeedbackTextAsync(value, state, fieldPath, maxStringLength, opts);
  // NDJSON formerly passed its serialized numeric primitives through the text
  // policy too. Retain ordinary number types, but encode a detected value as a
  // safe string marker. Other structured-value callers keep their old policy.
  if (typeof value === "number" && opts?.sanitizeNumbers) {
    const serialized = JSON.stringify(value);
    const safe = await sanitizeFeedbackTextAsync(serialized, state, fieldPath, Infinity, opts);
    return safe === serialized ? value : safe;
  }
  const checkpoint = feedbackCheckpoint(opts);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      await checkpoint();
      output.push(await sanitizeFeedbackValueAsync(value[i], state, `${fieldPath}[${i}]`, maxStringLength, opts));
    }
    return output;
  }
  if (!isPlainRecord(value)) return value;
  const structurallySanitized = sanitizeRecord(value);
  if (stableStringify(structurallySanitized) !== stableStringify(value)) {
    recordField(state, fieldPath);
    increment(state, "structured_secret", 1);
  }
  const entries: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(structurallySanitized)) {
    await checkpoint();
    const safeKey = opts?.sanitizeKeys
      ? await sanitizeFeedbackTextAsync(key, state, fieldPath, Infinity, opts)
      : key;
    entries.push([safeKey, entry]);
  }
  // Reserve every safe base before choosing suffixes, including literal marker
  // names appearing later. Collisions retain each value under a deterministic
  // name; neither the suffix nor the summary path contains the original key.
  const reservedKeys = new Set(entries.map(([key]) => key));
  const assignedKeys = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const output: Record<string, unknown> = {};
  for (const [baseKey, entry] of entries) {
    await checkpoint();
    let safeKey = baseKey;
    if (assignedKeys.has(safeKey)) {
      let suffix = nextSuffix.get(baseKey) ?? 2;
      do {
        safeKey = `${baseKey}__${suffix++}`;
      } while (reservedKeys.has(safeKey) || assignedKeys.has(safeKey));
      nextSuffix.set(baseKey, suffix);
    }
    assignedKeys.add(safeKey);
    output[safeKey] = await sanitizeFeedbackValueAsync(entry, state, `${fieldPath}.${safeKey}`, maxStringLength, opts);
  }
  return output;
}

/**
 * Sanitize decoded records before encoding: feedback patterns must not consume
 * JSON delimiters or leave an escaped quote behind. Legacy partial lines keep
 * the whole-text fallback. Truncation retains complete NDJSON records.
 */
export async function sanitizeFeedbackNdjsonAsync(
  input: string,
  state: FeedbackRedactionState,
  fieldPath: string,
  maxLength: number,
  opts?: AsyncRedactionOptions,
): Promise<string> {
  const pending = createFeedbackRedactionState();
  const checkpoint = feedbackCheckpoint(opts);
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  for (const line of input.split("\n")) {
    await checkpoint();
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // One malformed record means the input is not safely separable NDJSON:
      // a PEM or quoted/known secret may span its physical lines. Discard the
      // unpublished per-record counts and preserve the old whole-text policy.
      if (line.trim()) return sanitizeFeedbackTextAsync(input, state, fieldPath, maxLength, opts);
    }
    const safe = parsed === undefined
      ? line
      : JSON.stringify(await sanitizeFeedbackValueAsync(parsed, pending, fieldPath, Infinity, { ...opts, sanitizeKeys: true, sanitizeNumbers: true }));
    const nextLength = length + (lines.length > 0 ? 1 : 0) + safe.length;
    if (nextLength > maxLength) truncated = true;
    if (!truncated) {
      lines.push(safe);
      length = nextLength;
    }
  }
  if (truncated) pending.truncatedFields.add(fieldPath);
  opts?.signal?.throwIfAborted();
  mergeState(state, pending);
  return lines.join("\n");
}

export function sanitizeFeedbackValue(
  value: unknown,
  state: FeedbackRedactionState,
  fieldPath: string,
  maxStringLength: number,
): unknown {
  if (typeof value === "string") {
    return sanitizeFeedbackText(value, state, fieldPath, maxStringLength);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      sanitizeFeedbackValue(entry, state, `${fieldPath}[${index}]`, maxStringLength));
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const structurallySanitized = sanitizeRecord(value);
  if (stableStringify(structurallySanitized) !== stableStringify(value)) {
    recordField(state, fieldPath);
    increment(state, "structured_secret", 1);
  }

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(structurallySanitized)) {
    output[key] = sanitizeFeedbackValue(entry, state, `${fieldPath}.${key}`, maxStringLength);
  }
  return output;
}

export function finalizeFeedbackRedactionSummary(state: FeedbackRedactionState) {
  return {
    strategy: "deterministic_feedback_v2",
    redactedFields: Array.from(state.redactedFields).sort(),
    truncatedFields: Array.from(state.truncatedFields).sort(),
    omittedFields: Array.from(state.omittedFields).sort(),
    notes: Array.from(state.notes).sort(),
    counts: Object.fromEntries(Array.from(state.counts.entries()).sort(([left], [right]) => left.localeCompare(right))),
  } satisfies Record<string, unknown>;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
  return `{${entries.join(",")}}`;
}

export function sha256Digest(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
