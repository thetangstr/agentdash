// AgentDash (AGE-50 Phase 2): lifecycle service for goal-interview sessions.
//
// `startOrResume` is idempotent — if an open session already exists for the
// goal (no completedAt, no abandonedAt), it is returned unchanged so the UI
// renders "Resume interview" instead of kicking off a fresh session. When
// the CoS submits a plan via `submit_goal_interview`, the tool calls
// `markCompleted` to flip the session to `done`.

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { goalInterviewSessions } from "@agentdash/db";

export type GoalInterviewSessionRow = typeof goalInterviewSessions.$inferSelect;

export function goalInterviewSessionsService(db: Db) {
  async function findOpenForGoal(
    companyId: string,
    goalId: string,
  ): Promise<GoalInterviewSessionRow | null> {
    return db
      .select()
      .from(goalInterviewSessions)
      .where(
        and(
          eq(goalInterviewSessions.companyId, companyId),
          eq(goalInterviewSessions.goalId, goalId),
          isNull(goalInterviewSessions.completedAt),
          isNull(goalInterviewSessions.abandonedAt),
        ),
      )
      .orderBy(desc(goalInterviewSessions.startedAt))
      .then((rows) => rows[0] ?? null);
  }

  return {
    // Idempotent: returns an existing open session if one exists for the
    // goal, otherwise creates and returns a fresh row.
    startOrResume: async (
      companyId: string,
      goalId: string,
      startedByUserId: string | null,
    ): Promise<GoalInterviewSessionRow> => {
      const existing = await findOpenForGoal(companyId, goalId);
      if (existing) return existing;

      const now = new Date();
      return db
        .insert(goalInterviewSessions)
        .values({
          companyId,
          goalId,
          startedByUserId,
          startedAt: now,
          lastActivityAt: now,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    // Most recent session for a goal, regardless of status. Used by the
    // UI to decide whether to render "Start" or "Resume" CTA.
    latestForGoal: async (
      companyId: string,
      goalId: string,
    ): Promise<GoalInterviewSessionRow | null> => {
      return db
        .select()
        .from(goalInterviewSessions)
        .where(
          and(
            eq(goalInterviewSessions.companyId, companyId),
            eq(goalInterviewSessions.goalId, goalId),
          ),
        )
        .orderBy(desc(goalInterviewSessions.startedAt))
        .then((rows) => rows[0] ?? null);
    },

    findOpenForGoal,

    markCompleted: async (sessionId: string): Promise<GoalInterviewSessionRow | null> => {
      const now = new Date();
      return db
        .update(goalInterviewSessions)
        .set({ completedAt: now, lastActivityAt: now })
        .where(eq(goalInterviewSessions.id, sessionId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    attachConversation: async (
      sessionId: string,
      conversationId: string,
    ): Promise<GoalInterviewSessionRow | null> => {
      return db
        .update(goalInterviewSessions)
        .set({ conversationId, lastActivityAt: new Date() })
        .where(eq(goalInterviewSessions.id, sessionId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
