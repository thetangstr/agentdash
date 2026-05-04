// AgentDash (Phase C): JSON-trailer parser for deep-interview LLM responses.
//
// LLM output contract (see deep-interview-prompts.ts TRAILER_CONTRACT):
//   <visible body in plain English>
//   ```json
//   { "ambiguity_score": ..., "dimensions": {...}, ... }
//   ```
//
// Tolerant by design: missing fence, unterminated string, or non-object payload
// all return { visibleBody: <raw>, trailer: null } and log a warning. The
// engine treats a null trailer as "no signal this turn" and falls back to
// previous round scores rather than crashing.
//
// See docs/superpowers/plans/2026-05-04-onboarding-redesign-deep-interview-plan.md
// (Phase C, Pre-mortem #1) for the design rationale.

import { logger } from "../middleware/logger.js";
import type {
  DimensionScores,
  OntologyEntity,
} from "@paperclipai/shared/deep-interview";

export interface TrailerPayload {
  ambiguity_score: number;
  dimensions: DimensionScores;
  ontology_delta: OntologyEntity[];
  next_phase:
    | "continue"
    | "crystallize"
    | "challenge:contrarian"
    | "challenge:simplifier"
    | "challenge:ontologist";
  action?: "ask_next" | "force_crystallize";
}

export interface ParseResult {
  /** The LLM's prose, stripped of the fenced JSON block. */
  visibleBody: string;
  /** Parsed + validated trailer, or null on any failure. */
  trailer: TrailerPayload | null;
}

// Match all fenced JSON blocks; we always pick the LAST one. The trailer
// contract says the JSON block is the final element of the response, but the
// prose body may contain other fenced blocks (rare).
const FENCED_JSON_RE = /```json\s*([\s\S]*?)```/gi;

function isDimensionScores(value: unknown): value is DimensionScores {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.goal === "number" &&
    typeof v.constraints === "number" &&
    typeof v.criteria === "number" &&
    typeof v.context === "number"
  );
}

function isOntologyEntity(value: unknown): value is OntologyEntity {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string") return false;
  if (
    v.type !== "core_domain" &&
    v.type !== "supporting" &&
    v.type !== "external_system"
  ) {
    return false;
  }
  if (
    v.fields !== undefined &&
    !(Array.isArray(v.fields) && v.fields.every((f) => typeof f === "string"))
  ) {
    return false;
  }
  if (
    v.relationships !== undefined &&
    !(
      Array.isArray(v.relationships) &&
      v.relationships.every((r) => typeof r === "string")
    )
  ) {
    return false;
  }
  return true;
}

const ALLOWED_PHASES = new Set([
  "continue",
  "crystallize",
  "challenge:contrarian",
  "challenge:simplifier",
  "challenge:ontologist",
]);

function isTrailerPayload(value: unknown): value is TrailerPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.ambiguity_score !== "number") return false;
  if (!Number.isFinite(v.ambiguity_score)) return false;
  if (!isDimensionScores(v.dimensions)) return false;
  if (!Array.isArray(v.ontology_delta)) return false;
  if (!v.ontology_delta.every(isOntologyEntity)) return false;
  if (typeof v.next_phase !== "string" || !ALLOWED_PHASES.has(v.next_phase)) {
    return false;
  }
  if (
    v.action !== undefined &&
    v.action !== "ask_next" &&
    v.action !== "force_crystallize"
  ) {
    return false;
  }
  return true;
}

/**
 * Parse an LLM response into { visibleBody, trailer }.
 *
 * Tolerant of malformed input:
 *   - missing fence       → { visibleBody: text.trimEnd(), trailer: null }
 *   - JSON.parse failure  → { visibleBody: text.trimEnd(), trailer: null }
 *   - shape mismatch      → { visibleBody: text-with-fence-stripped, trailer: null }
 *
 * Logs a warning on every failure so adapter-quality dashboards can spot
 * regressions.
 */
export function parseJsonTrailer(text: string): ParseResult {
  const matches = Array.from(text.matchAll(FENCED_JSON_RE));
  if (matches.length === 0) {
    logger.warn(
      { rawFirst200: text.slice(0, 200) },
      "[deep-interview-parser] no fenced JSON trailer found",
    );
    return { visibleBody: text.trimEnd(), trailer: null };
  }

  const match = matches[matches.length - 1]!;
  // Reject if there is non-whitespace content after the last fenced block —
  // the contract says the trailer is the final element of the response.
  const tail = text.slice((match.index ?? 0) + match[0].length);
  if (tail.trim().length > 0) {
    logger.warn(
      { tailFirst200: tail.slice(0, 200) },
      "[deep-interview-parser] content after trailer; treating as malformed",
    );
    return { visibleBody: text.trimEnd(), trailer: null };
  }

  const body = text.slice(0, match.index).trimEnd();
  const jsonRaw = match[1] ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonRaw.trim());
  } catch (err) {
    logger.warn(
      { err, rawFirst200: jsonRaw.slice(0, 200) },
      "[deep-interview-parser] JSON.parse failed",
    );
    return { visibleBody: body, trailer: null };
  }

  if (!isTrailerPayload(parsed)) {
    logger.warn(
      { rawFirst200: jsonRaw.slice(0, 200) },
      "[deep-interview-parser] trailer shape mismatch",
    );
    return { visibleBody: body, trailer: null };
  }

  return { visibleBody: body, trailer: parsed };
}
