// AgentDash (issue #174): materialize the goals captured by the CoS
// onboarding interview into actual rows in the `goals` table so the user
// sees them on /goals immediately after onboarding.
//
// Called from the `/api/onboarding/confirm-plan` route right before the
// phase advances to `materializing`. Idempotent on (conversationId,
// ownerAgentId): a second call with the same input returns the existing
// goal ids without creating duplicates.
//
// Single-transaction guarantee mirrors `crystallizeAndAdvanceCos`: the
// onboarding-state read, idempotency check, INSERTs, and activity-log
// writes all run in one Drizzle transaction so a mid-helper failure rolls
// back cleanly.

import { and, eq, or } from "drizzle-orm";
import {
  cosOnboardingStates,
  goals,
  type Db,
  type CosOnboardingGoals,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

export interface MaterializeOnboardingGoalsResult {
  longTermGoalId: string | null;
  shortTermGoalId: string | null;
  /** True when a previous call already created the rows; second call is a no-op. */
  alreadyMaterialized: boolean;
}

export interface MaterializeOnboardingGoalsDeps {
  db: Db;
}

export interface MaterializeOnboardingGoalsInput {
  conversationId: string;
  companyId: string;
  /** CoS agent id; the onboarding goals will be owned by CoS. */
  ownerAgentId: string;
}

export class OnboardingStateNotFoundError extends Error {
  readonly code = "ONBOARDING_STATE_NOT_FOUND" as const;
  constructor(public readonly conversationId: string) {
    super(`[materialize-onboarding-goals] cos_onboarding_states row not found for conversationId=${conversationId}`);
    this.name = "OnboardingStateNotFoundError";
  }
}

/**
 * Materialize the {shortTerm, longTerm} captured during CoS onboarding into
 * `goals` rows. Idempotent: a second call with the same input returns the
 * existing goal ids and `alreadyMaterialized: true`.
 *
 * Level convention:
 *  - longTerm is materialized as `level: "company"` (the highest tier in
 *    GOAL_LEVELS — the natural fit for a 6-12 month vision).
 *  - shortTerm is materialized as `level: "task"` and parented to the
 *    long-term goal when one was created; otherwise it's top-level.
 *
 * `metricDefinition` is intentionally null. The user's natural-language
 * goal in onboarding doesn't typically include a structured target/unit;
 * CoS can fill it later via the Edit Metric flow on the GoalDetail page.
 */
export function materializeOnboardingGoals(deps: MaterializeOnboardingGoalsDeps) {
  const { db } = deps;

  return async (
    input: MaterializeOnboardingGoalsInput,
  ): Promise<MaterializeOnboardingGoalsResult> => {
    return await db.transaction(async (tx) => {
      // 1. Load the onboarding state row.
      const stateRows = await tx
        .select()
        .from(cosOnboardingStates)
        .where(eq(cosOnboardingStates.conversationId, input.conversationId));
      if (stateRows.length === 0) {
        throw new OnboardingStateNotFoundError(input.conversationId);
      }
      const captured = (stateRows[0]!.goals ?? {}) as CosOnboardingGoals;
      const longTermText = captured.longTerm?.trim() ?? "";
      const shortTermText = captured.shortTerm?.trim() ?? "";

      // Both absent → nothing to materialize.
      if (!longTermText && !shortTermText) {
        return {
          longTermGoalId: null,
          shortTermGoalId: null,
          alreadyMaterialized: false,
        };
      }

      // 2. Idempotency: look up existing goals owned by this agent that
      //    match the captured titles. If both expected rows already exist,
      //    return them as-is.
      const existing = await tx
        .select()
        .from(goals)
        .where(
          and(
            eq(goals.companyId, input.companyId),
            eq(goals.ownerAgentId, input.ownerAgentId),
            or(
              longTermText ? eq(goals.title, longTermText) : undefined,
              shortTermText ? eq(goals.title, shortTermText) : undefined,
            )!,
          ),
        );
      const existingLong = longTermText
        ? existing.find((g) => g.title === longTermText) ?? null
        : null;
      const existingShort = shortTermText
        ? existing.find((g) => g.title === shortTermText) ?? null
        : null;

      const expectLong = Boolean(longTermText);
      const expectShort = Boolean(shortTermText);
      const haveAllExpected =
        (!expectLong || existingLong !== null) &&
        (!expectShort || existingShort !== null);
      if (haveAllExpected && (existingLong || existingShort)) {
        return {
          longTermGoalId: existingLong?.id ?? null,
          shortTermGoalId: existingShort?.id ?? null,
          alreadyMaterialized: true,
        };
      }

      // 3. Insert long-term goal first (so short-term can parent to it).
      let longTermGoalId: string | null = existingLong?.id ?? null;
      if (longTermText && !existingLong) {
        const [inserted] = await tx
          .insert(goals)
          .values({
            companyId: input.companyId,
            title: longTermText,
            level: "company",
            status: "planned",
            parentId: null,
            ownerAgentId: input.ownerAgentId,
            metricDefinition: null,
          })
          .returning();
        longTermGoalId = inserted!.id;
        await logActivity(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.ownerAgentId,
          action: "goal_created_from_onboarding",
          entityType: "goal",
          entityId: longTermGoalId,
          agentId: input.ownerAgentId,
          details: {
            conversationId: input.conversationId,
            source: "cos_onboarding",
            originalText: longTermText,
            horizon: "long_term",
          },
        });
      }

      // 4. Insert short-term goal, parenting to long-term when present.
      let shortTermGoalId: string | null = existingShort?.id ?? null;
      if (shortTermText && !existingShort) {
        const [inserted] = await tx
          .insert(goals)
          .values({
            companyId: input.companyId,
            title: shortTermText,
            level: "task",
            status: "planned",
            parentId: longTermGoalId,
            ownerAgentId: input.ownerAgentId,
            metricDefinition: null,
          })
          .returning();
        shortTermGoalId = inserted!.id;
        await logActivity(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.ownerAgentId,
          action: "goal_created_from_onboarding",
          entityType: "goal",
          entityId: shortTermGoalId,
          agentId: input.ownerAgentId,
          details: {
            conversationId: input.conversationId,
            source: "cos_onboarding",
            originalText: shortTermText,
            horizon: "short_term",
            parentGoalId: longTermGoalId,
          },
        });
      }

      return {
        longTermGoalId,
        shortTermGoalId,
        alreadyMaterialized: false,
      };
    });
  };
}

