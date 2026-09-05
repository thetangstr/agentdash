import type { Db } from "@paperclipai/db";
import type { EvaluationMilestoneRef } from "@paperclipai/shared";
import { evaluationLedger, hashCanonical, orderEvents, type EvaluationEventRow } from "./ledger.js";

/**
 * AgentDash: Company Evaluator — deterministic projections (spec §11).
 *
 * Milestone 1 ships the projection machinery, not the scoring formulas
 * (Milestone 2). The M1 card is a structural digest of the ordered ledger for
 * one milestone: enough to prove byte-for-byte replay agreement and to give
 * drill-down its event set. `FORMULA_VERSION` changes whenever the projection
 * or the ordering changes.
 */
export const FORMULA_VERSION = "m1-digest/1";

/** Spec §4.6 card markers — single source of truth for renderer and verifier. */
export const MARKER_OPEN_MILESTONE = "open milestone — denominators still moving";
export const MARKER_RETROSPECTIVE = "scored retrospectively — confidence capped";

export interface MilestoneCard extends Record<string, unknown> {
  formulaVersion: string;
  milestoneRef: EvaluationMilestoneRef;
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

export function projectMilestone(
  allEvents: EvaluationEventRow[],
  ref: EvaluationMilestoneRef,
  throughEventId: string | null,
  opts: { openMilestone?: boolean; retrospective?: boolean } = {},
): MilestoneCard {
  const ordered = orderEvents(allEvents);
  const cut = throughEventId ? ordered.findIndex((e) => e.id === throughEventId) : ordered.length - 1;
  const window = cut >= 0 ? ordered.slice(0, cut + 1) : ordered;
  const events = selectMilestoneEvents(window, ref);
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
  if (opts.openMilestone) markers.push(MARKER_OPEN_MILESTONE);
  if (opts.retrospective) markers.push(MARKER_RETROSPECTIVE);
  return {
    formulaVersion: FORMULA_VERSION,
    milestoneRef: ref,
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

export function evaluationReplay(db: Db) {
  const ledger = evaluationLedger(db);
  return {
    /** Rebuild a milestone card from the ledger alone. */
    async replay(
      companyId: string,
      ref: EvaluationMilestoneRef,
      throughEventId: string | null = null,
      opts: { openMilestone?: boolean; retrospective?: boolean } = {},
    ): Promise<{ card: MilestoneCard; hash: string }> {
      const events = await ledger.list(companyId, { limit: 20000 });
      const card = projectMilestone(events, ref, throughEventId, opts);
      return { card, hash: cardHash(card) };
    },
  };
}
