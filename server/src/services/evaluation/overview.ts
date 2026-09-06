import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, evaluationScorecards, goals, projects } from "@paperclipai/db";
import {
  EVALUATION_REVIEW_PROJECT_NAME,
  EVALUATOR_AGENT_ROLE,
  type EvaluationMilestoneRef,
  type EvaluationMilestoneSummary,
  type EvaluationOverview,
  type EvaluationScorecardVersionSummary,
  type ScoredCard,
} from "@paperclipai/shared";
import { evaluationLedger } from "./ledger.js";

/**
 * AgentDash: Company Evaluator — Milestone 4 read models. Everything here is a
 * projection of stored cards and roster rows; nothing is computed that the
 * card does not already carry, and agents are never ordered by score.
 */

type StoredCardRow = typeof evaluationScorecards.$inferSelect;

function outcomeOf(card: ScoredCard) {
  const c = card.outcomeComposite;
  return { score: c?.score ?? null, confidence: c?.confidence ?? null, coverage: c?.coverage ?? null, reason: c?.guard?.reason ?? null };
}

function numberAt(detail: Record<string, unknown> | undefined, key: string): number | null {
  const v = detail?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

type LatestSummary = NonNullable<EvaluationMilestoneSummary["latest"]>;

/** P1 across the card's actors: the raw count, the population it was counted over, and the card's own caveat. */
function interventionsOf(card: ScoredCard): LatestSummary["interventions"] {
  let count = 0;
  let population = 0;
  let caveat: string | null = null;
  let seen = false;
  for (const a of card.actors ?? []) {
    const m = a.metrics?.P1;
    if (!m) continue;
    const n = numberAt(m.detail, "interventions");
    if (n === null) continue;
    seen = true;
    count += n;
    population += m.n ?? 0;
    const c = m.detail?.caveat;
    if (caveat === null && typeof c === "string" && c.length > 0) caveat = c;
  }
  if (!seen) return null;
  return { count, population, caveat };
}

/** P8 across the card's actors: metered cents and how many of the runs were metered at all. */
function costOf(card: ScoredCard): LatestSummary["cost"] {
  let cents = 0;
  let metered = 0;
  let runs = 0;
  let seen = false;
  for (const a of card.actors ?? []) {
    const d = a.metrics?.P8?.detail;
    const total = numberAt(d, "totalCents");
    if (total === null) continue;
    seen = true;
    cents += total;
    metered += numberAt(d, "metered") ?? 0;
    runs += numberAt(d, "runs") ?? 0;
  }
  return seen ? { cents, meteredRuns: metered, runs } : null;
}

export function versionSummary(row: StoredCardRow): EvaluationScorecardVersionSummary {
  const card = row.card as ScoredCard;
  return {
    version: row.version,
    storedAt: row.createdAt.toISOString(),
    formulaVersion: row.formulaVersion,
    contractVersion: row.contractVersion,
    throughSeq: Number(row.throughSeq),
    cardHash: row.cardHash,
    outcome: { score: card.outcomeComposite?.score ?? null, confidence: card.outcomeComposite?.confidence ?? null },
    exceptionsTotal: card.exceptionsTotal ?? card.exceptions?.length ?? 0,
  };
}

export function milestoneSummary(ref: EvaluationMilestoneRef, name: string, status: string | null, versions: StoredCardRow[]): EvaluationMilestoneSummary {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const latestRow = sorted[sorted.length - 1];
  if (!latestRow) return { ref, name, status, latest: null };
  const card = latestRow.card as ScoredCard;
  const exceptions = card.exceptions ?? [];
  const count = (severity: string) => exceptions.filter((e) => e.severity === severity).length;
  return {
    ref,
    name,
    status,
    latest: {
      version: latestRow.version,
      storedAt: latestRow.createdAt.toISOString(),
      formulaVersion: latestRow.formulaVersion,
      throughSeq: Number(latestRow.throughSeq),
      outcome: outcomeOf(card),
      operatingActors: (card.actors ?? []).filter((a) => a.actorType === "agent" && a.composite?.score != null).length,
      exceptions: { total: card.exceptionsTotal ?? exceptions.length, immediate: count("immediate"), material: count("material"), routine: count("routine") },
      markers: card.markers ?? [],
      missingSources: (card.missingSources ?? []).length,
      interventions: interventionsOf(card),
      cost: costOf(card),
      trend: sorted.slice(-12).map((r) => ({ version: r.version, score: (r.card as ScoredCard).outcomeComposite?.score ?? null, storedAt: r.createdAt.toISOString() })),
    },
  };
}

export function evaluationOverview(db: Db) {
  const ledger = evaluationLedger(db);

  async function versionsFor(companyId: string, ref: EvaluationMilestoneRef): Promise<StoredCardRow[]> {
    return db
      .select()
      .from(evaluationScorecards)
      .where(and(eq(evaluationScorecards.companyId, companyId), eq(evaluationScorecards.milestoneKind, ref.kind), eq(evaluationScorecards.milestoneId, ref.id)))
      .orderBy(desc(evaluationScorecards.version));
  }

  return {
    /** Every project and goal of the company (the review-items project excepted) with what its latest card says. */
    async get(companyId: string): Promise<EvaluationOverview> {
      const [projectRows, goalRows, cardRows, evaluator, maxSeq] = await Promise.all([
        db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects).where(eq(projects.companyId, companyId)),
        db.select({ id: goals.id, title: goals.title, status: goals.status }).from(goals).where(eq(goals.companyId, companyId)),
        db.select().from(evaluationScorecards).where(eq(evaluationScorecards.companyId, companyId)).orderBy(desc(evaluationScorecards.version)),
        db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), eq(agents.role, EVALUATOR_AGENT_ROLE), ne(agents.status, "terminated")))
          .then((rows) => rows[0] ?? null),
        ledger.maxSeq(companyId),
      ]);
      const byMilestone = new Map<string, StoredCardRow[]>();
      for (const row of cardRows) {
        const k = `${row.milestoneKind}:${row.milestoneId}`;
        byMilestone.set(k, [...(byMilestone.get(k) ?? []), row]);
      }
      const reviewProject = projectRows.find((p) => p.name === EVALUATION_REVIEW_PROJECT_NAME) ?? null;
      const milestones: EvaluationMilestoneSummary[] = [];
      for (const p of projectRows) {
        if (p.id === reviewProject?.id) continue; // rule 12: the evaluator's own project is never a milestone
        milestones.push(milestoneSummary({ kind: "project", id: p.id }, p.name, p.status ?? null, byMilestone.get(`project:${p.id}`) ?? []));
      }
      for (const g of goalRows) milestones.push(milestoneSummary({ kind: "goal", id: g.id }, g.title, g.status ?? null, byMilestone.get(`goal:${g.id}`) ?? []));
      // milestones with a card first (newest card first), then the rest by name — never by score
      milestones.sort((a, b) => {
        if (a.latest && b.latest) return a.latest.storedAt < b.latest.storedAt ? 1 : a.latest.storedAt > b.latest.storedAt ? -1 : a.name.localeCompare(b.name);
        if (a.latest) return -1;
        if (b.latest) return 1;
        return a.name.localeCompare(b.name);
      });
      return {
        milestones,
        reviewProjectId: reviewProject?.id ?? null,
        principal: { provisioned: evaluator !== null, agentId: evaluator?.id ?? null },
        ledger: { maxSeq: Number(maxSeq ?? 0) },
      };
    },

    /** Every stored version of one milestone, oldest first, without the card bodies. */
    async versions(companyId: string, ref: EvaluationMilestoneRef): Promise<EvaluationScorecardVersionSummary[]> {
      const rows = await versionsFor(companyId, ref);
      return rows.map(versionSummary).sort((a, b) => a.version - b.version);
    },
  };
}
