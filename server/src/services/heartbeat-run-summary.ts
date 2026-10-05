import { stripStatusLines } from "../lib/status-lines.js";

export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

function truncateSummaryText(value: unknown, maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// AgentDash (canary): a runtime status line is never the run summary. The
// Hermes adapter picks cleaned stdout as its response, so a leading "⚠ tirith
// security scanner enabled but not available" line became the persisted
// summary — and the same line reached `result` and `message`, which the run
// card falls back to. Strip the leading chatter from every summary-shaped
// input; a value that was only noise disappears instead of landing on the
// run card. The run's adapter decides how much counts as chatter — Hermes
// writes whole leading glyph runs, other adapters only ⚠/ℹ diagnostics.
function readSummaryText(value: unknown, adapterType?: string | null) {
  if (typeof value !== "string") return null;
  const cleaned = stripStatusLines(value, { adapterType });
  return cleaned.length > 0 ? cleaned : null;
}

// The displayable text fields a status line can land in. `error` is excluded
// on purpose: a real error is served verbatim.
const RESULT_TEXT_KEYS = ["summary", "result", "message"] as const;

function cleanResultTextFields(base: Record<string, unknown>, adapterType?: string | null): Record<string, unknown> {
  let cleaned: Record<string, unknown> | null = null;
  for (const key of RESULT_TEXT_KEYS) {
    if (typeof base[key] !== "string") continue;
    const value = readSummaryText(base[key], adapterType);
    if (value === base[key]) continue;
    cleaned ??= { ...base };
    if (value === null) delete cleaned[key];
    else cleaned[key] = value;
  }
  return cleaned ?? base;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
  adapterType?: string | null,
): Record<string, unknown> | null {
  const normalizedSummary = readSummaryText(summary, adapterType);
  let baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? cleanResultTextFields(resultJson, adapterType)
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  adapterType?: string | null,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};
  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    let value = truncateSummaryText(resultJson[key]);
    // Rows persisted before the merge-time strip can still carry a leading
    // status line as their summary — or their result, which the card falls
    // back to. `error` stays verbatim.
    if (key !== "error" && value !== null) {
      value = readSummaryText(value, adapterType);
    }
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
  adapterType?: string | null,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  return (
    readSummaryText(resultJson.summary, adapterType)
    ?? readSummaryText(resultJson.result, adapterType)
    ?? readSummaryText(resultJson.message, adapterType)
    ?? null
  );
}
