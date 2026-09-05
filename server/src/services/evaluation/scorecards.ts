import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { evaluationScorecards } from "@paperclipai/db";
import { EVALUATION_CONTRACT_VERSION, type EvaluationMilestoneRef } from "@paperclipai/shared";
import { withCompanyLock } from "./ingest.js";
import { evaluationLedger, hashCanonical, type EvaluationEventInput } from "./ledger.js";
import { evaluationReplay, FORMULA_VERSION, MARKER_OPEN_MILESTONE } from "./replay.js";
import type { ExceptionRecord, ScoredCard } from "./scoring/types.js";

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

    /**
     * Compute the current projection, store it as the next version and record
     * its exceptions as `evaluation.finding` events — under the company's
     * evaluator lock, so the cut (`maxSeq`) is read while no ingest pass is
     * mid-transaction and the findings' seqs follow it. State flags are
     * derived, never supplied.
     */
    async snapshot(companyId: string, ref: EvaluationMilestoneRef) {
      return withCompanyLock(db, companyId, async (tx) => {
        const rows = await versions(companyId, ref);
        const { card, hash, state, throughSeq } = await replay.replay(companyId, ref);
        const version = (rows[0]?.version ?? 0) + 1;
        const [row] = await tx
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
        const findings = await evaluationLedger(tx).append(findingEvents(companyId, ref, card, version));
        return { ...row!, findings: { inserted: findings.inserted, skipped: findings.skipped } };
      });
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

/**
 * Exceptions become ledger facts (rule 9: evaluator output is itself
 * replayable and appealable). The version is a hash of the finding's content,
 * so an unchanged exception on a later snapshot dedupes and a changed one is a
 * new fact. Findings carry the evaluator actor and never enter scored
 * populations (rule 12).
 */
export function findingEvents(companyId: string, ref: EvaluationMilestoneRef, card: ScoredCard, cardVersion: number): EvaluationEventInput[] {
  return card.exceptions.map((e: ExceptionRecord) => {
    const content = { id: e.id, severity: e.severity, subject: e.subject, routing: e.routing, note: e.note, evidenceRefs: e.evidenceRefs, raisedAt: e.raisedAt };
    return {
      companyId,
      projectId: ref.kind === "project" ? ref.id : null,
      goalId: ref.kind === "goal" ? ref.id : null,
      actorType: "evaluator",
      actorId: null,
      sourceTable: "evaluation",
      sourceId: e.key,
      sourceVersion: hashCanonical(content).slice(0, 32),
      eventType: "evaluation.finding",
      eventTime: new Date(e.raisedAt),
      payload: { ...content, title: e.title, routes: [...e.routes], markers: e.markers, milestoneRef: ref, cardVersion, formulaVersion: card.formulaVersion },
      correlationId: `finding:${e.key}`,
    };
  });
}
