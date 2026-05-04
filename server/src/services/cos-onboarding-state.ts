// AgentDash: per-conversation cos_onboarding_state service.
//
// Tracks the phase + captured goals for the CoS-led onboarding flow described
// in docs/superpowers/specs/2026-05-04-cos-onboarding-conversation-design.md
// (Phases B/C/D — goals capture, plan presentation, materialization).
import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  cosOnboardingStates,
  type CosOnboardingGoals,
  type CosOnboardingPhase,
} from "@paperclipai/db";

export interface CosOnboardingStateRow {
  conversationId: string;
  phase: CosOnboardingPhase;
  goals: CosOnboardingGoals;
  proposalMessageId: string | null;
  turnsInPhase: number;
  updatedAt: Date;
}

export interface AdvancePhaseOptions {
  proposalMessageId?: string | null;
}

function mergeGoals(
  current: CosOnboardingGoals,
  patch: CosOnboardingGoals,
): CosOnboardingGoals {
  const next: CosOnboardingGoals = { ...current };
  if (patch.shortTerm !== undefined) next.shortTerm = patch.shortTerm;
  if (patch.longTerm !== undefined) next.longTerm = patch.longTerm;
  if (patch.constraints !== undefined) {
    next.constraints = {
      ...(current.constraints ?? {}),
      ...(patch.constraints ?? {}),
    };
  }
  return next;
}

function normalizeRow(row: typeof cosOnboardingStates.$inferSelect): CosOnboardingStateRow {
  return {
    conversationId: row.conversationId,
    phase: row.phase as CosOnboardingPhase,
    goals: (row.goals ?? {}) as CosOnboardingGoals,
    proposalMessageId: row.proposalMessageId,
    turnsInPhase: row.turnsInPhase,
    updatedAt: row.updatedAt,
  };
}

export function cosOnboardingStateService(db: Db) {
  async function getOrCreate(conversationId: string): Promise<CosOnboardingStateRow> {
    const existing = await db
      .select()
      .from(cosOnboardingStates)
      .where(eq(cosOnboardingStates.conversationId, conversationId));
    if (existing[0]) return normalizeRow(existing[0]);

    const inserted = await db
      .insert(cosOnboardingStates)
      .values({
        conversationId,
        phase: "goals",
        goals: {},
        turnsInPhase: 0,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return normalizeRow(inserted[0]);

    // Lost the race; re-read.
    const reread = await db
      .select()
      .from(cosOnboardingStates)
      .where(eq(cosOnboardingStates.conversationId, conversationId));
    return normalizeRow(reread[0]!);
  }

  async function get(conversationId: string): Promise<CosOnboardingStateRow | null> {
    const rows = await db
      .select()
      .from(cosOnboardingStates)
      .where(eq(cosOnboardingStates.conversationId, conversationId));
    return rows[0] ? normalizeRow(rows[0]) : null;
  }

  async function recordTurn(conversationId: string): Promise<CosOnboardingStateRow | null> {
    const updated = await db
      .update(cosOnboardingStates)
      .set({
        turnsInPhase: sql`${cosOnboardingStates.turnsInPhase} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(cosOnboardingStates.conversationId, conversationId))
      .returning();
    return updated[0] ? normalizeRow(updated[0]) : null;
  }

  async function setGoals(
    conversationId: string,
    goalsPatch: CosOnboardingGoals,
  ): Promise<CosOnboardingStateRow | null> {
    const current = await get(conversationId);
    if (!current) return null;
    const merged = mergeGoals(current.goals, goalsPatch);
    const updated = await db
      .update(cosOnboardingStates)
      .set({ goals: merged, updatedAt: new Date() })
      .where(eq(cosOnboardingStates.conversationId, conversationId))
      .returning();
    return updated[0] ? normalizeRow(updated[0]) : null;
  }

  async function advancePhase(
    conversationId: string,
    nextPhase: CosOnboardingPhase,
    opts: AdvancePhaseOptions = {},
  ): Promise<CosOnboardingStateRow | null> {
    const patch: Partial<typeof cosOnboardingStates.$inferInsert> = {
      phase: nextPhase,
      turnsInPhase: 0,
      updatedAt: new Date(),
    };
    if (opts.proposalMessageId !== undefined) {
      patch.proposalMessageId = opts.proposalMessageId;
    }
    const updated = await db
      .update(cosOnboardingStates)
      .set(patch)
      .where(eq(cosOnboardingStates.conversationId, conversationId))
      .returning();
    return updated[0] ? normalizeRow(updated[0]) : null;
  }

  return { getOrCreate, get, recordTurn, setGoals, advancePhase };
}

// Exported for tests.
export const __test = { mergeGoals };
