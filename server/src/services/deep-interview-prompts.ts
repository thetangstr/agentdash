// AgentDash (Phase C): pure prompt-composition helpers for the deep-interview
// engine. Two responsibilities:
//
//   1. selectPromptDepth(adapter): picks "full" (claude_api only) vs "summary"
//      (everything else). Hard requirement — Phase C acceptance #7. Spawn-based
//      adapters have no prompt caching at the API level (verified at
//      dispatch-llm.ts:108-140), so shipping the 16.7k-token full SKILL.md
//      across 8+ rounds would burn ~133k uncached tokens per interview.
//
//   2. composePrompt(): concatenates the appropriate SKILL corpus + scope
//      framing + per-round challenge fragment + JSON-trailer schema contract
//      into a system prompt + messages array suitable for dispatchLLM.
//
// Pure functions only — no I/O. The engine (deep-interview-engine.ts) owns
// all DB writes and dispatch wiring.
//
// See docs/superpowers/plans/2026-05-04-onboarding-redesign-deep-interview-plan.md
// (Phase C) for the full design rationale.

import type { AgentAdapterType } from "@paperclipai/shared";
import {
  SKILL_MD_FULL,
  SKILL_MD_SUMMARY,
} from "@paperclipai/shared/deep-interview-skill";
import type {
  ChallengeMode,
  DimensionScores,
  OntologyEntity,
  OntologySnapshot,
  TranscriptTurn,
} from "@paperclipai/shared/deep-interview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromptPhase = "ask_question" | "score" | "crystallize";

/**
 * Subset of `deepInterviewStates` columns the prompt builder needs. We define
 * a structural type rather than importing the Drizzle row type to keep this
 * module pure / testable without a DB.
 */
export interface DeepInterviewStateRow {
  scope: string;
  scopeRefId: string;
  currentRound: number;
  ambiguityScore: number | null;
  dimensionScores: DimensionScores | null;
  ontologySnapshots: OntologySnapshot[];
  challengeModesUsed: string[];
  transcript: TranscriptTurn[];
  /**
   * Set true when prior-codebase context exists (brownfield). Drives the
   * 4-dimension weighting (35/25/25/15) vs greenfield (40/30/30, no context).
   */
  brownfield: boolean;
  /** Initial idea / seed prompt provided by the user. */
  initialIdea: string;
}

export interface ComposeInput {
  adapter: AgentAdapterType;
  phase: PromptPhase;
  state: DeepInterviewStateRow;
  /** When set, inject the matching challenge-mode fragment. */
  challengeMode?: ChallengeMode;
}

export interface ComposedPrompt {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

// ---------------------------------------------------------------------------
// Prompt-depth selection (Phase C acceptance #7)
// ---------------------------------------------------------------------------

/**
 * Pick which SKILL corpus to ship for a given adapter.
 *
 * Hard contract:
 *   - "claude_api" → "full" (cached via cache_control: ephemeral in
 *      anthropic-llm.ts; the 16.7k tokens are paid once per cache window).
 *   - everything else → "summary" (~150-line distillation, ~3-4k tokens,
 *      bounded for argv-flattened spawn adapters).
 *
 * Unknown adapter strings default to "summary" — safer to ship less context.
 */
export function selectPromptDepth(
  adapter: AgentAdapterType,
): "full" | "summary" {
  return adapter === "claude_api" ? "full" : "summary";
}

// ---------------------------------------------------------------------------
// Challenge-mode fragments
// ---------------------------------------------------------------------------

const CHALLENGE_FRAGMENTS: Record<ChallengeMode, string> = {
  contrarian: `\n\n[CHALLENGE — Contrarian]\nYour next question MUST adopt a contrarian stance. Pick the user's strongest stated assumption and ask why it might be wrong, or propose the literal opposite of their goal as a candidate framing. The point is to expose hidden premises, not to be hostile. One sharp question only.`,
  simplifier: `\n\n[CHALLENGE — Simplifier]\nYour next question MUST aggressively simplify. Identify the single most load-bearing requirement; ask whether the entire problem could be reframed without it. Propose the smallest possible MVP that still solves the user's core pain. One sharp question only.`,
  ontologist: `\n\n[CHALLENGE — Ontologist]\nYour next question MUST stress-test the ontology. Pick the most ambiguous entity in the user's model and ask for explicit fields, relationships, and lifecycle. If two entities have overlapping responsibilities, ask which one is canonical. One sharp question only.`,
};

// ---------------------------------------------------------------------------
// Trailer-contract fragment
// ---------------------------------------------------------------------------

const TRAILER_CONTRACT = `

[Response contract]
Reply in plain English to the user. Then, on a new line, emit a fenced JSON block carrying structured data the engine consumes. The block MUST be the LAST thing in your response, and MUST parse as JSON.

\`\`\`json
{
  "ambiguity_score": 0.42,
  "dimensions": { "goal": 0.7, "constraints": 0.5, "criteria": 0.4, "context": 0.6 },
  "ontology_delta": [
    { "name": "Customer", "type": "core_domain", "fields": ["id","email"], "relationships": ["Order"] }
  ],
  "next_phase": "continue",
  "action": "ask_next"
}
\`\`\`

Allowed values:
- ambiguity_score: 0.0 (fully clear) .. 1.0 (entirely unclear).
- dimensions: numbers 0..1 for { goal, constraints, criteria, context }.
- ontology_delta: array of OntologyEntity ({ name, type: "core_domain"|"supporting"|"external_system", fields?, relationships? }).
- next_phase: "continue" | "crystallize" | "challenge:contrarian" | "challenge:simplifier" | "challenge:ontologist".
- action: "ask_next" | "force_crystallize" (optional; default ask_next).`;

// ---------------------------------------------------------------------------
// Scope framing
// ---------------------------------------------------------------------------

function scopeFraming(state: DeepInterviewStateRow): string {
  const parts: string[] = [];
  parts.push(`\n\n[Scope]\n${state.scope}`);
  if (state.brownfield) {
    parts.push(
      `\n[Mode] Brownfield — weight ambiguity as goal*0.35 + constraints*0.25 + criteria*0.25 + context*0.15.`,
    );
  } else {
    parts.push(
      `\n[Mode] Greenfield — weight ambiguity as goal*0.40 + constraints*0.30 + criteria*0.30. No prior-codebase context dimension.`,
    );
  }
  parts.push(`\n[Round] ${state.currentRound}`);
  if (state.ambiguityScore !== null) {
    parts.push(`\n[Last ambiguity] ${state.ambiguityScore.toFixed(3)}`);
  }
  if (state.challengeModesUsed.length > 0) {
    parts.push(`\n[Modes already used] ${state.challengeModesUsed.join(", ")}`);
  }
  return parts.join("");
}

function transcriptToMessages(
  state: DeepInterviewStateRow,
): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  // Seed: the user's initial idea is the first user message.
  out.push({ role: "user", content: state.initialIdea });
  for (const turn of state.transcript) {
    out.push({ role: "assistant", content: turn.question });
    out.push({ role: "user", content: turn.answer });
  }
  return out;
}

// ---------------------------------------------------------------------------
// composePrompt
// ---------------------------------------------------------------------------

/**
 * Compose the system prompt + messages array for a given engine phase.
 *
 * - claude_api ships SKILL_MD_FULL; every other adapter ships SKILL_MD_SUMMARY.
 * - Challenge-mode fragments are appended in `ask_question` phase only.
 * - JSON-trailer contract is appended in `ask_question` and `score` phases
 *   (the LLM emits the trailer; the engine parses it).
 */
export function composePrompt(input: ComposeInput): ComposedPrompt {
  const depth = selectPromptDepth(input.adapter);
  const skill = depth === "full" ? SKILL_MD_FULL : SKILL_MD_SUMMARY;

  const parts: string[] = [skill];
  parts.push(scopeFraming(input.state));

  if (input.phase === "ask_question") {
    parts.push(
      `\n\n[Task]\nAsk ONE question that targets the weakest dimension. Be specific. Reference the user's prior answers when useful. Do not ask compound questions.`,
    );
    if (input.challengeMode) {
      parts.push(CHALLENGE_FRAGMENTS[input.challengeMode]);
    }
    parts.push(TRAILER_CONTRACT);
  } else if (input.phase === "score") {
    parts.push(
      `\n\n[Task]\nScore the user's most recent answer against the four dimensions. Update ambiguity. Do not ask another question — just emit the trailer.`,
    );
    parts.push(TRAILER_CONTRACT);
  } else {
    parts.push(
      `\n\n[Task]\nThe interview has converged. Emit the final crystallized spec as a JSON object with keys: goal (string), constraints (string[]), criteria (string[]), non_goals (string[]), ontology (OntologyEntity[]). No prose.`,
    );
  }

  return {
    system: parts.join(""),
    messages: transcriptToMessages(input.state),
  };
}
