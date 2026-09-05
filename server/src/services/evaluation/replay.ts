import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, projects } from "@paperclipai/db";
import type { EvaluationMilestoneRef } from "@paperclipai/shared";
import { evaluationLedger, type EvaluationEventRow } from "./ledger.js";
import { cardHash, FORMULA_VERSION as SCORE_FORMULA_VERSION, scoreMilestone, selectMilestoneEvents } from "./scoring/card.js";
import type { ScoredCard } from "./scoring/types.js";

export { isRetrospective, MARKER_OPEN_MILESTONE, MARKER_RETROSPECTIVE } from "./scoring/state.js";
export { cardHash, selectMilestoneEvents } from "./scoring/card.js";
export type { ScoredCard as MilestoneCard } from "./scoring/types.js";

/**
 * AgentDash: Company Evaluator — deterministic projections (spec §11).
 *
 * Milestone 2: the card is the scored card (`scoring/card.ts`): metrics
 * O1–O5 and P1–P9, tiers, composites with guards, exceptions E1–E14 — a pure
 * function of the ledger window `seq <= throughSeq` plus the open flag. The
 * open flag comes from the milestone's own roster snapshot inside the window
 * when there is one; otherwise from the flag pinned in a stored card (verify)
 * or the live milestone row (a fresh snapshot). `retrospective` is always
 * derived from the window. Neither is ever accepted from a caller (§4.6).
 * `FORMULA_VERSION` changes whenever any formula, ordering or card shape does.
 */
export const FORMULA_VERSION = SCORE_FORMULA_VERSION;

export interface MilestoneState {
  open: boolean;
  retrospective: boolean;
  hasContract: boolean;
}

/** Compatibility wrapper: project a milestone from a window without a database. */
export function projectMilestone(window: EvaluationEventRow[], ref: EvaluationMilestoneRef, throughSeq: number, state: { open: boolean }, companyId?: string): ScoredCard {
  const company = companyId ?? window[0]?.companyId ?? "00000000-0000-4000-8000-000000000000";
  return scoreMilestone(window, ref, throughSeq, company, { fallbackOpen: state.open });
}

export function evaluationReplay(db: Db) {
  const ledger = evaluationLedger(db);

  async function milestoneOpen(companyId: string, ref: EvaluationMilestoneRef): Promise<boolean> {
    if (ref.kind === "project") {
      const [p] = await db.select({ status: projects.status, companyId: projects.companyId }).from(projects).where(eq(projects.id, ref.id));
      if (!p || p.companyId !== companyId) return true;
      return !["completed", "cancelled"].includes(p.status);
    }
    const [g] = await db.select({ status: goals.status, companyId: goals.companyId }).from(goals).where(eq(goals.id, ref.id));
    if (!g || g.companyId !== companyId) return true;
    return !["achieved", "cancelled"].includes(g.status);
  }

  return {
    /** The live fallback for the open flag (used only when the window carries no roster snapshot for the milestone). */
    milestoneOpen,

    /**
     * Rebuild a milestone card from the ledger alone. `throughSeq` defaults to
     * the current maximum, which is what a fresh snapshot stores. `pinned`
     * carries the `open` flag a stored card was built with (verify).
     */
    async replay(
      companyId: string,
      ref: EvaluationMilestoneRef,
      throughSeq?: number,
      pinned?: { open: boolean },
    ): Promise<{ card: ScoredCard; hash: string; state: MilestoneState; throughSeq: number }> {
      const cut = throughSeq ?? (await ledger.maxSeq(companyId));
      const window = await ledger.windowUpTo(companyId, cut);
      const fallbackOpen = pinned?.open ?? (await milestoneOpen(companyId, ref));
      const card = scoreMilestone(window, ref, cut, companyId, { fallbackOpen });
      const state: MilestoneState = { open: card.state.open, retrospective: card.state.retrospective, hasContract: card.contract.source === "declared" };
      return { card, hash: cardHash(card), state, throughSeq: cut };
    },
  };
}
