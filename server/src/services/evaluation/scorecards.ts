import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { evaluationScorecards } from "@paperclipai/db";
import { EVALUATION_CONTRACT_VERSION, type EvaluationMilestoneRef } from "@paperclipai/shared";
import { cardHash, evaluationReplay, FORMULA_VERSION, MARKER_OPEN_MILESTONE, MARKER_RETROSPECTIVE, type MilestoneCard } from "./replay.js";

/**
 * AgentDash: Company Evaluator — stored projections (decision D6).
 * One JSON card per version; `verify` proves replay agreement (spec §11).
 */
export function evaluationScorecardService(db: Db) {
  const replay = evaluationReplay(db);
  return {
    async latest(companyId: string, ref: EvaluationMilestoneRef) {
      const rows = await db
        .select()
        .from(evaluationScorecards)
        .where(
          and(
            eq(evaluationScorecards.companyId, companyId),
            eq(evaluationScorecards.milestoneKind, ref.kind),
            eq(evaluationScorecards.milestoneId, ref.id),
          ),
        )
        .orderBy(desc(evaluationScorecards.version))
        .limit(1);
      return rows[0] ?? null;
    },

    /** Compute the current projection and store it as the next version. */
    async snapshot(
      companyId: string,
      ref: EvaluationMilestoneRef,
      opts: { openMilestone?: boolean; retrospective?: boolean } = {},
    ) {
      const prev = await this.latest(companyId, ref);
      const { card, hash } = await replay.replay(companyId, ref, null, opts);
      const version = (prev?.version ?? 0) + 1;
      const [row] = await db
        .insert(evaluationScorecards)
        .values({
          companyId,
          milestoneKind: ref.kind,
          milestoneId: ref.id,
          version,
          contractVersion: EVALUATION_CONTRACT_VERSION,
          formulaVersion: FORMULA_VERSION,
          throughEventId: card.throughEventId,
          card,
          cardHash: hash,
        })
        .returning();
      return row!;
    },

    /** Rebuild the stored version from the ledger and compare hashes byte-for-byte. */
    async verify(companyId: string, ref: EvaluationMilestoneRef, version?: number) {
      const rows = await db
        .select()
        .from(evaluationScorecards)
        .where(
          and(
            eq(evaluationScorecards.companyId, companyId),
            eq(evaluationScorecards.milestoneKind, ref.kind),
            eq(evaluationScorecards.milestoneId, ref.id),
          ),
        )
        .orderBy(desc(evaluationScorecards.version));
      const stored = version == null ? rows[0] : rows.find((r) => r.version === version);
      if (!stored) return { ok: false as const, reason: "no stored card" };
      const storedCard = stored.card as MilestoneCard;
      const { card, hash } = await replay.replay(companyId, ref, stored.throughEventId, {
        openMilestone: storedCard.markers?.includes(MARKER_OPEN_MILESTONE) ?? false,
        retrospective: storedCard.markers?.includes(MARKER_RETROSPECTIVE) ?? false,
      });
      const agrees = hash === stored.cardHash && cardHash(card) === hash;
      return { ok: agrees, storedHash: stored.cardHash, replayHash: hash, version: stored.version };
    },
  };
}
