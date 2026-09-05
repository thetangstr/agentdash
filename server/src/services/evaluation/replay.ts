import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, projects } from "@paperclipai/db";
import type { EvaluationMilestoneRef } from "@paperclipai/shared";
import { evaluationLedger, hashCanonical, orderEvents, type EvaluationEventRow } from "./ledger.js";

/**
 * AgentDash: Company Evaluator — deterministic projections (spec §11).
 *
 * Milestone 1 ships the projection machinery, not the scoring formulas
 * (Milestone 2). The M1 card is a structural digest of the ordered ledger for
 * one milestone: enough to prove byte-for-byte replay agreement and to give
 * drill-down its event set.
 *
 * Reproducibility: a card is a pure function of the ledger window
 * `seq <= throughSeq` (insertion order) plus the milestone's state flags,
 * which are derived from the milestone itself (spec §4.6), never accepted
 * from a caller. `FORMULA_VERSION` changes whenever the projection or the
 * ordering changes.
 */
export const FORMULA_VERSION = "m1-digest/2";

/** Spec §4.6 card markers — single source of truth for renderer and verifier. */
export const MARKER_OPEN_MILESTONE = "open milestone — denominators still moving";
export const MARKER_RETROSPECTIVE = "scored retrospectively — confidence capped";

/** A milestone whose first event predates the ledger's first ingest by more than this is retrospective. */
const RETROSPECTIVE_GAP_MS = 24 * 60 * 60 * 1000;

export interface MilestoneState {
  /** True while the project/goal has not reached a terminal status. */
  open: boolean;
  /** True when the milestone's records predate the evaluator (§4.6). */
  retrospective: boolean;
  /** Whether a `contract.declared` event exists for this milestone. */
  hasContract: boolean;
}

export interface MilestoneCard extends Record<string, unknown> {
  formulaVersion: string;
  milestoneRef: EvaluationMilestoneRef;
  throughSeq: number;
  throughEventId: string | null;
  eventCount: number;
  byType: Record<string, number>;
  byActorType: Record<string, number>;
  bySource: Record<string, number>;
  issueIds: string[];
  actors: string[];
  firstEventTime: string | null;
  lastEventTime: string | null;
  /** Spec §4.6 markers the renderer must show. */
  markers: string[];
}

/** Membership (spec §3): project events by projectId; goal-as-milestone by goalId with no projectId. */
export function selectMilestoneEvents(events: EvaluationEventRow[], ref: EvaluationMilestoneRef): EvaluationEventRow[] {
  return events.filter((e) =>
    ref.kind === "project" ? e.projectId === ref.id : e.goalId === ref.id && e.projectId === null,
  );
}

/**
 * Project one milestone from a replay window. `window` must be exactly the
 * events with `seq <= throughSeq`; the function orders them itself.
 */
export function projectMilestone(
  window: EvaluationEventRow[],
  ref: EvaluationMilestoneRef,
  throughSeq: number,
  state: Pick<MilestoneState, "open" | "retrospective">,
): MilestoneCard {
  const events = selectMilestoneEvents(orderEvents(window.filter((e) => Number(e.seq) <= throughSeq)), ref);
  const byType: Record<string, number> = {};
  const byActorType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const issueIds = new Set<string>();
  const actors = new Set<string>();
  for (const e of events) {
    byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
    byActorType[e.actorType] = (byActorType[e.actorType] ?? 0) + 1;
    bySource[e.sourceTable] = (bySource[e.sourceTable] ?? 0) + 1;
    const issueId = typeof e.payload?.issueId === "string" ? (e.payload.issueId as string) : null;
    if (issueId) issueIds.add(issueId);
    if (e.actorId) actors.add(`${e.actorType}:${e.actorId}`);
  }
  const markers: string[] = [];
  if (state.open) markers.push(MARKER_OPEN_MILESTONE);
  if (state.retrospective) markers.push(MARKER_RETROSPECTIVE);
  return {
    formulaVersion: FORMULA_VERSION,
    milestoneRef: ref,
    throughSeq,
    throughEventId: events.length > 0 ? events[events.length - 1]!.id : null,
    eventCount: events.length,
    byType: sortRecord(byType),
    byActorType: sortRecord(byActorType),
    bySource: sortRecord(bySource),
    issueIds: [...issueIds].sort(),
    actors: [...actors].sort(),
    firstEventTime: events.length > 0 ? events[0]!.eventTime.toISOString() : null,
    lastEventTime: events.length > 0 ? events[events.length - 1]!.eventTime.toISOString() : null,
    markers,
  };
}

function sortRecord(r: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function cardHash(card: MilestoneCard): string {
  return hashCanonical(card);
}

/** Retrospective if the milestone's earliest event predates the earliest ingest in the window by more than a day. */
export function isRetrospective(window: EvaluationEventRow[], milestoneEvents: EvaluationEventRow[]): boolean {
  if (window.length === 0 || milestoneEvents.length === 0) return false;
  const firstIngest = Math.min(...window.map((e) => e.ingestTime.getTime()));
  const firstEvent = Math.min(...milestoneEvents.map((e) => e.eventTime.getTime()));
  return firstIngest - firstEvent > RETROSPECTIVE_GAP_MS;
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
    /** Derive the §4.6 state flags from the milestone itself and the window. */
    async state(companyId: string, ref: EvaluationMilestoneRef, window: EvaluationEventRow[]): Promise<MilestoneState> {
      const [open, hasContract] = await Promise.all([milestoneOpen(companyId, ref), ledger.hasContract(companyId, ref)]);
      return { open, retrospective: isRetrospective(window, selectMilestoneEvents(window, ref)), hasContract };
    },

    /**
     * Rebuild a milestone card from the ledger alone. `throughSeq` defaults to
     * the current maximum, which is what a fresh snapshot stores.
     */
    async replay(
      companyId: string,
      ref: EvaluationMilestoneRef,
      throughSeq?: number,
    ): Promise<{ card: MilestoneCard; hash: string; state: MilestoneState; throughSeq: number }> {
      const cut = throughSeq ?? (await ledger.maxSeq(companyId));
      const window = await ledger.windowUpTo(companyId, cut);
      const state = await this.state(companyId, ref, window);
      const card = projectMilestone(window, ref, cut, state);
      return { card, hash: cardHash(card), state, throughSeq: cut };
    },
  };
}
