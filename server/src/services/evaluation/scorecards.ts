import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { evaluationScorecards } from "@paperclipai/db";
import { EVALUATION_CONTRACT_VERSION, type EvaluationMilestoneRef } from "@paperclipai/shared";
import { evaluationReplay, FORMULA_VERSION, MARKER_OPEN_MILESTONE } from "./replay.js";

/**
 * AgentDash: Company Evaluator — stored projections (decision D6).
 *
 * One JSON card per version. Each version records the replay window it was
 * built from (`throughSeq`) and pins the `open` flag inside the card;
 * `verify` rebuilds from exactly that window under that flag and compares
 * hashes, so agreement is independent of anything ingested later and of the
 * milestone closing later.
 * `contractVersion` is `none` until a `contract.declared` event exists for
 * the milestone — a card never claims a contract that was not declared.
 */
export function evaluationScorecardService(db: Db) {
  const replay = evaluationReplay(db);

  async function versions(companyId: string, ref: EvaluationMilestoneRef) {
    return db
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
  }

  return {
    async latest(companyId: string, ref: EvaluationMilestoneRef) {
      const rows = await versions(companyId, ref);
      return rows[0] ?? null;
    },

    /** Compute the current projection and store it as the next version. State flags are derived, never supplied. */
    async snapshot(companyId: string, ref: EvaluationMilestoneRef) {
      const rows = await versions(companyId, ref);
      const { card, hash, state, throughSeq } = await replay.replay(companyId, ref);
      const version = (rows[0]?.version ?? 0) + 1;
      const [row] = await db
        .insert(evaluationScorecards)
        .values({
          companyId,
          milestoneKind: ref.kind,
          milestoneId: ref.id,
          version,
          contractVersion: state.hasContract ? EVALUATION_CONTRACT_VERSION : "none",
          formulaVersion: FORMULA_VERSION,
          throughSeq,
          throughEventId: card.throughEventId,
          card,
          cardHash: hash,
        })
        .returning();
      return row!;
    },

    /** Rebuild the stored version from its own window and compare hashes byte-for-byte. */
    async verify(companyId: string, ref: EvaluationMilestoneRef, version?: number) {
      const rows = await versions(companyId, ref);
      const stored = version == null ? rows[0] : rows.find((r) => r.version === version);
      if (!stored) return { ok: false as const, reason: "no stored card" };
      if (stored.formulaVersion !== FORMULA_VERSION) {
        return { ok: false as const, reason: `formula changed (${stored.formulaVersion} → ${FORMULA_VERSION})`, version: stored.version };
      }
      const storedCard = stored.card as { state?: { open?: boolean }; markers?: string[] };
      const pinnedOpen =
        typeof storedCard.state?.open === "boolean" ? storedCard.state.open : (storedCard.markers ?? []).includes(MARKER_OPEN_MILESTONE);
      const { hash } = await replay.replay(companyId, ref, Number(stored.throughSeq), { open: pinnedOpen });
      return { ok: hash === stored.cardHash, storedHash: stored.cardHash, replayHash: hash, version: stored.version, throughSeq: Number(stored.throughSeq), pinnedOpen };
    },
  };
}
