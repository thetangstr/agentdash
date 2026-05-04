// AgentDash (Phase F): single-transaction helper that stitches the
// deep-interview state machine to the CoS-onboarding state machine.
//
// Called from two callsites:
//   1. The deep-interview engine, when ambiguity drops below threshold (via
//      a `/assess` route helper that hands off to CoS).
//   2. The orchestrator, when CoS needs to advance past Phase 1 because a
//      spec was already crystallized in `/assess`.
//
// Idempotency contract (Critic hand-off condition #4): calling this twice
// with the same `stateId` must return the same `{ specId, conversationId }`
// without inserting duplicate rows. The early-return branch covers the
// "user double-clicks Finish" and "engine retries on transient failure"
// cases without leaving partially-written state behind.
//
// Single-transaction guarantee: deep_interview_specs INSERT,
// deep_interview_states UPDATE, and cos_onboarding_states UPDATE all happen
// in one Drizzle transaction. A DB error mid-helper rolls back all three.
//
// See docs/superpowers/plans/2026-05-04-onboarding-redesign-deep-interview-plan.md
// (Phase F) for the full design rationale.

import { eq, sql } from "drizzle-orm";
import {
  cosOnboardingStates,
  deepInterviewSpecs,
  deepInterviewStates,
  type Db,
} from "@paperclipai/db";
import type {
  DimensionScores,
  OntologySnapshot,
  TranscriptTurn,
} from "@paperclipai/shared/deep-interview";
import { logger } from "../middleware/logger.js";

export interface CrystallizeAndAdvanceResult {
  specId: string;
  conversationId: string;
}

export interface CrystallizeAndAdvanceDeps {
  db: Db;
}

/**
 * Crystallize a deep-interview state into a `deep_interview_specs` row, flip
 * the state to `crystallized`, and advance `cos_onboarding_states.phase` to
 * `plan` for the linked conversation — all in a single transaction.
 *
 * Idempotent: a second call with the same `stateId` returns the prior result
 * without writing.
 */
export function crystallizeAndAdvanceCos(deps: CrystallizeAndAdvanceDeps) {
  const { db } = deps;

  return async (stateId: string): Promise<CrystallizeAndAdvanceResult> => {
    return await db.transaction(async (tx) => {
      // 1. Lock the state row. SELECT … FOR UPDATE prevents concurrent
      //    crystallizers from racing past the idempotency check.
      const stateRows = await tx
        .select()
        .from(deepInterviewStates)
        .where(eq(deepInterviewStates.id, stateId))
        .for("update");

      if (stateRows.length === 0) {
        throw new Error(
          `[deep-interview-crystallize] state ${stateId} not found`,
        );
      }
      const state = stateRows[0]!;

      // 2. IDEMPOTENCY: if already crystallized, return the prior spec id
      //    (looked up via the linked deep_interview_specs row) and the
      //    conversation id without inserting again.
      if (state.status === "crystallized") {
        const priorSpecRows = await tx
          .select()
          .from(deepInterviewSpecs)
          .where(eq(deepInterviewSpecs.stateId, state.id))
          .limit(1);
        if (priorSpecRows.length === 0) {
          // Should never happen — state flipped to crystallized but no spec.
          // Treat as a hard inconsistency rather than silently re-crystallizing.
          throw new Error(
            `[deep-interview-crystallize] state ${stateId} status=crystallized but no spec row exists`,
          );
        }
        logger.info(
          { stateId, specId: priorSpecRows[0]!.id },
          "[deep-interview-crystallize] idempotent no-op",
        );
        return {
          specId: priorSpecRows[0]!.id,
          conversationId: state.scopeRefId,
        };
      }

      // 3. Build the spec payload from the state row.
      const dims = (state.dimensionScores as DimensionScores | null) ?? {
        goal: 0,
        constraints: 0,
        criteria: 0,
        context: 0,
      };
      const transcript = (state.transcript as TranscriptTurn[]) ?? [];
      const ontologySnapshots =
        (state.ontologySnapshots as OntologySnapshot[]) ?? [];
      const lastOntology =
        ontologySnapshots.length > 0
          ? ontologySnapshots[ontologySnapshots.length - 1]!.entities
          : [];

      const goalText =
        transcript.find((t) => t.targetDimension === "goal")?.answer ?? "";
      const constraints = transcript
        .filter((t) => t.targetDimension === "constraints")
        .map((t) => t.answer)
        .filter((s) => s.length > 0);
      const criteria = transcript
        .filter((t) => t.targetDimension === "criteria")
        .map((t) => t.answer)
        .filter((s) => s.length > 0);

      // 4. Insert the spec row.
      const inserted = await tx
        .insert(deepInterviewSpecs)
        .values({
          stateId: state.id,
          goal: goalText,
          constraints,
          criteria,
          nonGoals: [],
          ontology: lastOntology,
          transcript,
          finalAmbiguity: state.ambiguityScore ?? 0,
          dimensionScores: dims,
        })
        .returning();
      const specId = inserted[0]!.id;

      // 5. Flip the state's status. We do NOT also write
      //    deep_interview_specs.id back onto the state — the linkage flows
      //    the other direction (specs.state_id FK).
      await tx
        .update(deepInterviewStates)
        .set({ status: "crystallized", updatedAt: sql`now()` })
        .where(eq(deepInterviewStates.id, state.id));

      // 6. For cos_onboarding scope, advance the linked conversation's CoS
      //    phase to 'plan' and link the spec.
      if (state.scope === "cos_onboarding") {
        await tx
          .update(cosOnboardingStates)
          .set({
            deepInterviewSpecId: specId,
            phase: "plan",
            updatedAt: sql`now()`,
          })
          .where(eq(cosOnboardingStates.conversationId, state.scopeRefId));
      }

      logger.info(
        {
          stateId: state.id,
          specId,
          scope: state.scope,
          conversationId: state.scopeRefId,
        },
        "[deep-interview-crystallize] tx committed",
      );

      return { specId, conversationId: state.scopeRefId };
    });
  };
}
