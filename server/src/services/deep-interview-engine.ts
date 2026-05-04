// AgentDash (Phase C): deep-interview engine — the Socratic loop orchestrator.
//
// One service entrypoint:
//   nextTurn(input) → { question, ambiguityScore, dimensions, round, status, ... }
//
// Per-turn responsibilities:
//   1. getOrCreate the deep_interview_states row keyed by (scope, scopeRefId).
//   2. If a userAnswer is present, append it to the cached transcript and
//      advance currentRound.
//   3. Compose a prompt via composePrompt(); dispatch via the injected LLM.
//   4. Parse the JSON trailer; update dimensionScores, ambiguityScore,
//      ontologySnapshots, challengeModesUsed.
//   5. Decide hard-stop (ambiguity ≤ threshold OR round ≥ 20 OR all dims ≥ 0.9):
//      flip status to 'ready_to_crystallize' and return a marker.
//   6. Otherwise return the next question for the UI to render.
//
// Cross-state-machine wiring (cos_onboarding_states.deep_interview_spec_id +
// CoS phase advance) is Phase F's `crystallizeAndAdvanceCos` helper. Phase C
// `crystallize()` only writes deep_interview_specs and flips
// deep_interview_states.status — it does NOT touch cos_onboarding_states.
//
// See docs/superpowers/plans/2026-05-04-onboarding-redesign-deep-interview-plan.md
// (Phase C) for the full design rationale.

import { and, eq, sql } from "drizzle-orm";
import {
  deepInterviewSpecs,
  deepInterviewStates,
  type Db,
} from "@paperclipai/db";
import type { AgentAdapterType } from "@paperclipai/shared";
import type {
  ChallengeMode,
  DeepInterviewScope,
  DimensionScores,
  OntologyEntity,
  OntologySnapshot,
  TranscriptTurn,
} from "@paperclipai/shared/deep-interview";
import { logger } from "../middleware/logger.js";
import {
  composePrompt,
  type DeepInterviewStateRow as PromptStateRow,
} from "./deep-interview-prompts.js";
import {
  parseJsonTrailer,
  type TrailerPayload,
} from "./deep-interview-parser.js";

// ---------------------------------------------------------------------------
// Tunables (kept explicit so they appear in tests + observability)
// ---------------------------------------------------------------------------

/** Crystallize when ambiguity drops to or below this. */
export const AMBIGUITY_THRESHOLD = 0.2;

/** Crystallize regardless of ambiguity once we hit this many rounds. */
export const HARD_ROUND_CAP = 20;

/** Crystallize when ALL dimension scores meet this. */
export const ALL_DIMS_DONE_AT = 0.9;

/** Round at which each challenge mode fires (used-once each). */
const CHALLENGE_ROUNDS: Record<number, ChallengeMode> = {
  4: "contrarian",
  6: "simplifier",
  8: "ontologist",
};

/** Brownfield weights — must sum to 1.0. */
const BROWNFIELD_WEIGHTS = {
  goal: 0.35,
  constraints: 0.25,
  criteria: 0.25,
  context: 0.15,
} as const;

/** Greenfield weights — must sum to 1.0 across the three present dims. */
const GREENFIELD_WEIGHTS = {
  goal: 0.4,
  constraints: 0.3,
  criteria: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EngineLLMDispatch = (input: {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}) => Promise<string>;

export interface NextTurnInput {
  scope: DeepInterviewScope;
  scopeRefId: string;
  userId: string;
  companyId: string;
  initialIdea: string;
  adapter: AgentAdapterType;
  /** Set true on a brownfield idea (prior codebase context exists). */
  brownfield?: boolean;
  /** The user's answer to the previous turn. Omit on the very first call. */
  userAnswer?: string;
}

export type NextTurnResult =
  | {
      kind: "question";
      stateId: string;
      round: number;
      question: string;
      ambiguityScore: number;
      dimensions: DimensionScores;
      challengeMode: ChallengeMode | null;
      ontologyStability: number | null;
    }
  | {
      kind: "ready_to_crystallize";
      stateId: string;
      round: number;
      ambiguityScore: number;
      dimensions: DimensionScores;
    };

export interface CrystallizeResult {
  specId: string;
  stateId: string;
}

export interface DeepInterviewEngine {
  nextTurn(input: NextTurnInput): Promise<NextTurnResult>;
  crystallize(stateId: string): Promise<CrystallizeResult>;
  getInProgress(
    scope: DeepInterviewScope,
    scopeRefId: string,
  ): Promise<DeepInterviewStateRow | null>;
}

export interface EngineDeps {
  db: Db;
  /**
   * LLM dispatcher. Production wiring uses dispatchLLM from
   * server/src/services/dispatch-llm.ts; tests inject a stub.
   */
  dispatchLLM: EngineLLMDispatch;
}

// Internal row shape — narrower than the Drizzle row type so the engine and
// prompt builder share a structural contract.
interface DeepInterviewStateRow {
  id: string;
  scope: DeepInterviewScope;
  scopeRefId: string;
  status: "in_progress" | "ready_to_crystallize" | "crystallized" | "abandoned";
  currentRound: number;
  ambiguityScore: number | null;
  dimensionScores: DimensionScores | null;
  ontologySnapshots: OntologySnapshot[];
  challengeModesUsed: ChallengeMode[];
  transcript: TranscriptTurn[];
  initialIdea: string;
  brownfield: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function computeWeightedAmbiguity(
  dims: DimensionScores,
  brownfield: boolean,
): number {
  const g = clamp01(dims.goal);
  const c = clamp01(dims.constraints);
  const cr = clamp01(dims.criteria);
  if (brownfield) {
    const ctx = clamp01(dims.context);
    const clarity =
      g * BROWNFIELD_WEIGHTS.goal +
      c * BROWNFIELD_WEIGHTS.constraints +
      cr * BROWNFIELD_WEIGHTS.criteria +
      ctx * BROWNFIELD_WEIGHTS.context;
    return clamp01(1 - clarity);
  }
  const clarity =
    g * GREENFIELD_WEIGHTS.goal +
    c * GREENFIELD_WEIGHTS.constraints +
    cr * GREENFIELD_WEIGHTS.criteria;
  return clamp01(1 - clarity);
}

function targetWeakestDimension(
  dims: DimensionScores | null,
  brownfield: boolean,
): keyof DimensionScores {
  if (!dims) return "goal";
  const candidates: Array<[keyof DimensionScores, number]> = [
    ["goal", dims.goal],
    ["constraints", dims.constraints],
    ["criteria", dims.criteria],
  ];
  if (brownfield) candidates.push(["context", dims.context]);
  candidates.sort((a, b) => a[1] - b[1]);
  return candidates[0]![0];
}

function allDimensionsDone(
  dims: DimensionScores | null,
  brownfield: boolean,
): boolean {
  if (!dims) return false;
  if (
    dims.goal < ALL_DIMS_DONE_AT ||
    dims.constraints < ALL_DIMS_DONE_AT ||
    dims.criteria < ALL_DIMS_DONE_AT
  ) {
    return false;
  }
  if (brownfield && dims.context < ALL_DIMS_DONE_AT) return false;
  return true;
}

function pickChallengeMode(
  round: number,
  used: ChallengeMode[],
  ambiguity: number | null,
): ChallengeMode | null {
  const candidate = CHALLENGE_ROUNDS[round];
  if (!candidate) return null;
  if (used.includes(candidate)) return null;
  // Ontologist only fires when ambiguity is still meaningfully above threshold.
  if (candidate === "ontologist" && (ambiguity ?? 1) <= 0.3) return null;
  return candidate;
}

function mergeOntology(
  prev: OntologyEntity[],
  delta: OntologyEntity[],
): { merged: OntologyEntity[]; newCount: number; changedCount: number; stableCount: number } {
  const byName = new Map<string, OntologyEntity>();
  for (const e of prev) byName.set(e.name, e);
  let newCount = 0;
  let changedCount = 0;
  for (const e of delta) {
    const existing = byName.get(e.name);
    if (!existing) {
      newCount += 1;
      byName.set(e.name, e);
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(e)) {
      changedCount += 1;
    }
    byName.set(e.name, e);
  }
  const merged = Array.from(byName.values());
  const stableCount = merged.length - newCount - changedCount;
  return { merged, newCount, changedCount, stableCount: Math.max(0, stableCount) };
}

function nextOntologySnapshot(
  prev: OntologySnapshot[],
  delta: OntologyEntity[],
  round: number,
): OntologySnapshot {
  const lastEntities = prev.length > 0 ? prev[prev.length - 1]!.entities : [];
  const { merged, newCount, changedCount, stableCount } = mergeOntology(
    lastEntities,
    delta,
  );
  // Stability ratio: stable / total. Null on first snapshot (no prior round).
  const total = merged.length;
  const stabilityRatio = prev.length === 0 || total === 0 ? null : stableCount / total;
  return {
    round,
    entities: merged,
    newCount,
    changedCount,
    stableCount,
    stabilityRatio,
  };
}

function rowToInternal(row: typeof deepInterviewStates.$inferSelect, fallbackInitialIdea: string, brownfield: boolean): DeepInterviewStateRow {
  return {
    id: row.id,
    scope: row.scope as DeepInterviewScope,
    scopeRefId: row.scopeRefId,
    status: (row.status as DeepInterviewStateRow["status"]) ?? "in_progress",
    currentRound: row.currentRound,
    ambiguityScore: row.ambiguityScore,
    dimensionScores: (row.dimensionScores as DimensionScores | null) ?? null,
    ontologySnapshots: (row.ontologySnapshots as OntologySnapshot[]) ?? [],
    challengeModesUsed: (row.challengeModesUsed as ChallengeMode[]) ?? [],
    transcript: (row.transcript as TranscriptTurn[]) ?? [],
    initialIdea: fallbackInitialIdea,
    brownfield,
  };
}

function toPromptRow(row: DeepInterviewStateRow): PromptStateRow {
  return {
    scope: row.scope,
    scopeRefId: row.scopeRefId,
    currentRound: row.currentRound,
    ambiguityScore: row.ambiguityScore,
    dimensionScores: row.dimensionScores,
    ontologySnapshots: row.ontologySnapshots,
    challengeModesUsed: row.challengeModesUsed,
    transcript: row.transcript,
    brownfield: row.brownfield,
    initialIdea: row.initialIdea,
  };
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export function deepInterviewEngine(deps: EngineDeps): DeepInterviewEngine {
  const { db, dispatchLLM } = deps;

  async function getOrCreateRow(
    input: NextTurnInput,
  ): Promise<DeepInterviewStateRow> {
    const existing = await db
      .select()
      .from(deepInterviewStates)
      .where(
        and(
          eq(deepInterviewStates.scope, input.scope),
          eq(deepInterviewStates.scopeRefId, input.scopeRefId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return rowToInternal(existing[0]!, input.initialIdea, input.brownfield ?? false);
    }

    const inserted = await db
      .insert(deepInterviewStates)
      .values({
        scope: input.scope,
        scopeRefId: input.scopeRefId,
        status: "in_progress",
        currentRound: 0,
        ambiguityScore: null,
        dimensionScores: null,
        ontologySnapshots: [],
        challengeModesUsed: [],
        transcript: [],
      })
      .returning();

    return rowToInternal(inserted[0]!, input.initialIdea, input.brownfield ?? false);
  }

  async function persistTurn(
    stateId: string,
    patch: Partial<typeof deepInterviewStates.$inferInsert>,
  ): Promise<void> {
    await db
      .update(deepInterviewStates)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(deepInterviewStates.id, stateId));
  }

  async function nextTurn(input: NextTurnInput): Promise<NextTurnResult> {
    const row = await getOrCreateRow(input);

    if (row.status !== "in_progress") {
      // Idempotent on already-finished interviews.
      logger.info(
        { stateId: row.id, status: row.status },
        "[deep-interview-engine] nextTurn called on non-in_progress row",
      );
      return {
        kind: "ready_to_crystallize",
        stateId: row.id,
        round: row.currentRound,
        ambiguityScore: row.ambiguityScore ?? 0,
        dimensions:
          row.dimensionScores ?? { goal: 1, constraints: 1, criteria: 1, context: 1 },
      };
    }

    // 1. If we have an answer, append to transcript so the next prompt sees it.
    let transcript = row.transcript;
    let nextRound = row.currentRound;
    if (typeof input.userAnswer === "string" && input.userAnswer.length > 0) {
      const lastQuestion =
        transcript.length > 0 ? transcript[transcript.length - 1]!.question : "";
      const targetDimension = targetWeakestDimension(row.dimensionScores, row.brownfield);
      // The most recent transcript turn was created with question only; we now
      // append the answer + a fresh ambiguityAfter (tentative until the LLM
      // re-scores below).
      const tentativeTurn: TranscriptTurn = {
        round: nextRound,
        question: lastQuestion,
        targetDimension,
        answer: input.userAnswer,
        ambiguityAfter: row.ambiguityScore ?? 1,
      };
      transcript = [...transcript.slice(0, -1), tentativeTurn];
      nextRound = row.currentRound + 1;
    }

    // 2. Compose + dispatch.
    const challengeMode = pickChallengeMode(
      nextRound,
      row.challengeModesUsed,
      row.ambiguityScore,
    );
    const promptInput = toPromptRow({
      ...row,
      currentRound: nextRound,
      transcript,
    });
    const composed = composePrompt({
      adapter: input.adapter,
      phase: "ask_question",
      state: promptInput,
      challengeMode: challengeMode ?? undefined,
    });

    const raw = await dispatchLLM({
      system: composed.system,
      messages: composed.messages,
    });

    const { visibleBody, trailer } = parseJsonTrailer(raw);

    // 3. Update state from trailer (or fall through with previous values).
    const dims: DimensionScores =
      trailer?.dimensions ??
      row.dimensionScores ?? { goal: 0, constraints: 0, criteria: 0, context: 0 };
    const ambiguity =
      trailer?.ambiguity_score !== undefined
        ? clamp01(trailer.ambiguity_score)
        : computeWeightedAmbiguity(dims, row.brownfield);

    const ontologySnapshot = nextOntologySnapshot(
      row.ontologySnapshots,
      trailer?.ontology_delta ?? [],
      nextRound,
    );
    const ontologySnapshots = [...row.ontologySnapshots, ontologySnapshot];

    const modesUsed = challengeMode
      ? [...row.challengeModesUsed, challengeMode]
      : row.challengeModesUsed;

    // The LLM's visible body becomes the next turn's question.
    const newTurn: TranscriptTurn = {
      round: nextRound,
      question: visibleBody,
      targetDimension: targetWeakestDimension(dims, row.brownfield),
      answer: "",
      ambiguityAfter: ambiguity,
      ...(challengeMode ? { challengeMode } : {}),
    };
    const nextTranscript = [...transcript, newTurn];

    // 4. Decide hard-stop.
    const reachedCap = nextRound >= HARD_ROUND_CAP;
    const reachedAmbiguity = ambiguity <= AMBIGUITY_THRESHOLD;
    const reachedDims = allDimensionsDone(dims, row.brownfield);
    const stop = reachedCap || reachedAmbiguity || reachedDims;
    const newStatus: DeepInterviewStateRow["status"] = stop
      ? "ready_to_crystallize"
      : "in_progress";

    await persistTurn(row.id, {
      currentRound: nextRound,
      ambiguityScore: ambiguity,
      dimensionScores: dims,
      ontologySnapshots,
      challengeModesUsed: modesUsed,
      transcript: nextTranscript,
      status: newStatus,
    });

    logger.info(
      {
        stateId: row.id,
        round: nextRound,
        scope: row.scope,
        adapter: input.adapter,
        ambiguity,
        dims,
        challengeMode,
        stop,
        reason: reachedCap ? "round_cap" : reachedAmbiguity ? "ambiguity" : reachedDims ? "dims" : null,
      },
      "[deep-interview-engine] turn dispatched",
    );

    if (stop) {
      return {
        kind: "ready_to_crystallize",
        stateId: row.id,
        round: nextRound,
        ambiguityScore: ambiguity,
        dimensions: dims,
      };
    }

    return {
      kind: "question",
      stateId: row.id,
      round: nextRound,
      question: visibleBody,
      ambiguityScore: ambiguity,
      dimensions: dims,
      challengeMode: challengeMode ?? null,
      ontologyStability: ontologySnapshot.stabilityRatio,
    };
  }

  async function crystallize(stateId: string): Promise<CrystallizeResult> {
    const rows = await db
      .select()
      .from(deepInterviewStates)
      .where(eq(deepInterviewStates.id, stateId))
      .limit(1);
    if (rows.length === 0) {
      throw new Error(`[deep-interview-engine] state ${stateId} not found`);
    }
    const row = rows[0]!;

    const dims = (row.dimensionScores as DimensionScores | null) ?? {
      goal: 0,
      constraints: 0,
      criteria: 0,
      context: 0,
    };
    const transcript = (row.transcript as TranscriptTurn[]) ?? [];
    const ontologySnapshots = (row.ontologySnapshots as OntologySnapshot[]) ?? [];
    const lastOntology =
      ontologySnapshots.length > 0
        ? ontologySnapshots[ontologySnapshots.length - 1]!.entities
        : [];

    const goalText = transcript.find((t) => t.targetDimension === "goal")?.answer ?? "";
    const constraints = transcript
      .filter((t) => t.targetDimension === "constraints")
      .map((t) => t.answer)
      .filter((s) => s.length > 0);
    const criteria = transcript
      .filter((t) => t.targetDimension === "criteria")
      .map((t) => t.answer)
      .filter((s) => s.length > 0);

    const inserted = await db
      .insert(deepInterviewSpecs)
      .values({
        stateId: row.id,
        goal: goalText,
        constraints,
        criteria,
        nonGoals: [],
        ontology: lastOntology,
        transcript,
        finalAmbiguity: row.ambiguityScore ?? 0,
        dimensionScores: dims,
      })
      .returning();

    await db
      .update(deepInterviewStates)
      .set({ status: "crystallized", updatedAt: sql`now()` })
      .where(eq(deepInterviewStates.id, row.id));

    logger.info(
      { stateId: row.id, specId: inserted[0]!.id, finalAmbiguity: row.ambiguityScore },
      "[deep-interview-engine] crystallized",
    );

    return { specId: inserted[0]!.id, stateId: row.id };
  }

  async function getInProgress(
    scope: DeepInterviewScope,
    scopeRefId: string,
  ): Promise<DeepInterviewStateRow | null> {
    const rows = await db
      .select()
      .from(deepInterviewStates)
      .where(
        and(
          eq(deepInterviewStates.scope, scope),
          eq(deepInterviewStates.scopeRefId, scopeRefId),
        ),
      )
      .limit(1);
    if (rows.length === 0) return null;
    return rowToInternal(rows[0]!, "", false);
  }

  return { nextTurn, crystallize, getInProgress };
}

// Re-export for convenience.
export { computeWeightedAmbiguity, pickChallengeMode, targetWeakestDimension, allDimensionsDone, nextOntologySnapshot };
