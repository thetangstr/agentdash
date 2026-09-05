import type { EvaluationMetricKey, EvaluationMilestoneRef } from "@paperclipai/shared";
import { hashCanonical, orderEvents, type EvaluationEventRow } from "../ledger.js";
import { composite } from "./composite.js";
import { resolveContract } from "./contract.js";
import { criterionDispositions, evidenceForItem, type CriterionDisposition, type ItemEvidence } from "./evidence.js";
import { mergeExceptions, standaloneExceptions } from "./exceptions.js";
import { isSyntheticUser } from "./independence.js";
import {
  actorsIn,
  companyRow,
  o1Acceptance,
  o2Deadline,
  o3DownstreamRisk,
  o4GoalProgress,
  o5EvidenceHygiene,
  p1Autonomy,
  p2Judgment,
  p3FactualAccuracy,
  p4HandoffQuality,
  p5Recovery,
  p6Authority,
  p7CycleTime,
  p8Cost,
  p9DuplicateRework,
  successorLinks,
  type MetricOutput,
  type ScoringContext,
} from "./metrics.js";
import {
  isRetrospective,
  MARKER_CONTRACT_EXCEPTION,
  MARKER_DERIVED_CONTRACT,
  MARKER_OPEN_MILESTONE,
  MARKER_RETROSPECTIVE,
  MARKER_SYNTHETIC_HUMANS,
} from "./state.js";
import { buildTimeline, doneAt, latestGoal, latestProject, membership, terminalAt, type Timeline } from "./timeline.js";
import type { ActorRow, ExceptionRecord, MetricResult, ScoredCard } from "./types.js";

/**
 * AgentDash: Company Evaluator — the scored card (Milestone 2). A pure
 * function of the ordered window `seq <= throughSeq` plus the open flag.
 * `FORMULA_VERSION` changes whenever any formula, rule, ordering or card shape
 * changes; `verify` refuses to compare across versions.
 */
export const FORMULA_VERSION = "m2-score/1";

export interface ScoreOptions {
  /** The open flag when the window carries no roster snapshot for the milestone (pinned by verify, live at snapshot time). */
  fallbackOpen: boolean;
}

/** Membership for the drill-down digest (Milestone 1 shape): events scoped to the milestone. */
export function selectMilestoneEvents(events: EvaluationEventRow[], ref: EvaluationMilestoneRef): EvaluationEventRow[] {
  return events.filter((e) => (ref.kind === "project" ? e.projectId === ref.id : e.goalId === ref.id && e.projectId === null));
}

/** The open flag from the ledger's own roster snapshots; null when the window has none for the milestone. */
export function openFromLedger(tl: Timeline, ref: EvaluationMilestoneRef): boolean | null {
  if (ref.kind === "project") {
    const p = latestProject(tl, ref.id);
    return p ? !(p.status === "completed" || p.status === "cancelled") : null;
  }
  const g = latestGoal(tl, ref.id);
  return g ? !(g.status === "achieved" || g.status === "cancelled") : null;
}

function sortRecord(r: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function scoreMilestone(window: EvaluationEventRow[], ref: EvaluationMilestoneRef, throughSeq: number, companyId: string, opts: ScoreOptions): ScoredCard {
  const ordered = orderEvents(window.filter((e) => Number(e.seq) <= throughSeq));
  const tl = buildTimeline(ordered);
  const milestoneEvents = selectMilestoneEvents(ordered, ref);
  const mem = membership(tl, ref);
  const resolved = resolveContract(tl, ref, mem.members, companyId);
  const retrospective = isRetrospective(ordered, milestoneEvents);
  const open = openFromLedger(tl, ref) ?? opts.fallbackOpen;

  const evidence = new Map<string, ItemEvidence>();
  const dispositions = new Map<string, CriterionDisposition[]>();
  const ctx: ScoringContext = { tl, ref, companyId, members: mem.members, resolved, evidence, dispositions, retrospective };
  for (const it of mem.members) {
    const ev = evidenceForItem(it, tl, resolved);
    evidence.set(it.issueId, ev);
    if (doneAt(it)) dispositions.set(it.issueId, criterionDispositions(it, tl, resolved, ev));
  }

  const outcomeOutputs: MetricOutput[] = [o1Acceptance(ctx), o2Deadline(ctx), o3DownstreamRisk(ctx), o4GoalProgress(ctx), o5EvidenceHygiene(ctx)];
  const outcome: Partial<Record<EvaluationMetricKey, MetricResult>> = {};
  for (const o of outcomeOutputs) outcome[o.metric.key] = o.metric;
  const exceptionLists: ExceptionRecord[][] = outcomeOutputs.map((o) => o.exceptions);

  const successors = successorLinks(ctx);
  const o1SatisfiedByAgent = new Map<string, number>();
  for (const it of mem.members) {
    const d = doneAt(it);
    if (!d) continue;
    const ds = dispositions.get(it.issueId) ?? [];
    if (ds.length > 0 && ds.every((x) => x.state === "satisfied")) {
      const owner = terminalAt(it) ? tl.items.get(it.issueId) : null;
      const agent = owner ? (it.snapshots[it.snapshots.length - 1]?.assigneeAgentId ?? null) : null;
      if (agent) o1SatisfiedByAgent.set(agent, (o1SatisfiedByAgent.get(agent) ?? 0) + 1);
    }
  }
  const actors: ActorRow[] = [];
  for (const scope of actorsIn(ctx)) {
    const outputs: MetricOutput[] = [
      p1Autonomy(ctx, scope),
      p2Judgment(ctx, scope),
      p3FactualAccuracy(ctx, scope),
      p4HandoffQuality(ctx, scope),
      p5Recovery(ctx, scope),
      p6Authority(ctx, scope),
      p7CycleTime(ctx, scope),
      p8Cost(ctx, scope, o1SatisfiedByAgent.get(scope.agentId) ?? null),
      p9DuplicateRework(ctx, scope, successors),
    ];
    const metrics: Partial<Record<EvaluationMetricKey, MetricResult>> = {};
    for (const o of outputs) {
      metrics[o.metric.key] = o.metric;
      exceptionLists.push(o.exceptions);
    }
    const flags = flagsFrom(outputs.flatMap((o) => o.exceptions));
    actors.push({
      actorKey: `agent:${scope.agentId}`,
      actorType: "agent",
      actorId: scope.agentId,
      name: tl.agents.get(scope.agentId)?.name ?? null,
      metrics,
      composite: composite("operating", metrics, flags),
    });
  }
  const company = companyRow(ctx);
  actors.push({
    actorKey: `company:${companyId}`,
    actorType: "company",
    actorId: companyId,
    name: null,
    metrics: { P2: company.unansweredQuestions, P5: company.platformFailures, P7: p7CycleTime(ctx, null).metric },
    composite: null,
  });
  exceptionLists.push(company.exceptions, standaloneExceptions(ctx, ordered));

  const exceptions = mergeExceptions(exceptionLists);
  const flags = flagsFrom(exceptions);
  const outcomeComposite = composite("outcome", outcome, flags);
  const exceptionCounts: Record<string, number> = {};
  for (const e of exceptions) exceptionCounts[e.id] = (exceptionCounts[e.id] ?? 0) + 1;

  const markers: string[] = [];
  if (open) markers.push(MARKER_OPEN_MILESTONE);
  if (retrospective) markers.push(MARKER_RETROSPECTIVE);
  if (resolved.source === "derived") markers.push(MARKER_DERIVED_CONTRACT);
  if (resolved.summary.exceptions.some((x) => !x.startsWith("contract derived"))) markers.push(MARKER_CONTRACT_EXCEPTION);
  const humans = [...tl.humanActors];
  if (humans.length > 0 && humans.every((u) => isSyntheticUser(u))) markers.push(MARKER_SYNTHETIC_HUMANS);

  const excludedMetrics: ScoredCard["excludedMetrics"] = outcomeComposite.excluded.map((x) => ({ key: x.key, scope: "milestone", reason: x.reason }));
  for (const a of actors) for (const x of a.composite?.excluded ?? []) excludedMetrics.push({ key: x.key, scope: a.actorKey, reason: x.reason });

  const missingSources: string[] = [];
  if (!tl.sources.verdicts) missingSources.push("verdicts: none recorded");
  if (!tl.sources.regressionGates) missingSources.push("CI evidence: no structured regression gates and no GitHub check runs");
  if (!tl.sources.deliveryRefs) missingSources.push("delivery: no merge reports and no GitHub adapter (D4)");
  if (!tl.sources.costEvents) missingSources.push("cost: no cost events");
  if (!tl.sources.authzRefused) missingSources.push("authority refusals: authz.refused not emitted yet (AGE-91)");
  if (!tl.sources.rosterProjects && !tl.sources.rosterGoals) missingSources.push("roster: no project or goal snapshots in the window");

  // Milestone 1 digest for drill-down
  const byType: Record<string, number> = {};
  const byActorType: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const issueIds = new Set<string>();
  const actorKeys = new Set<string>();
  for (const e of milestoneEvents) {
    byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
    byActorType[e.actorType] = (byActorType[e.actorType] ?? 0) + 1;
    bySource[e.sourceTable] = (bySource[e.sourceTable] ?? 0) + 1;
    const issueId = typeof e.payload?.issueId === "string" ? (e.payload.issueId as string) : null;
    if (issueId) issueIds.add(issueId);
    if (e.actorId) actorKeys.add(`${e.actorType}:${e.actorId}`);
  }
  const milestoneName = ref.kind === "project" ? (latestProject(tl, ref.id)?.name ?? null) : (latestGoal(tl, ref.id)?.title ?? null);

  return {
    formulaVersion: FORMULA_VERSION,
    milestoneRef: ref,
    milestoneName,
    throughSeq,
    throughEventId: milestoneEvents.length > 0 ? milestoneEvents[milestoneEvents.length - 1]!.id : null,
    asOf: tl.asOf.toISOString(),
    markers,
    contract: resolved.summary,
    membership: {
      items: mem.members.length,
      done: mem.members.filter((m) => doneAt(m) !== null).length,
      cancelled: mem.members.filter((m) => terminalAt(m)?.status === "cancelled").length,
      open: mem.members.filter((m) => terminalAt(m) === null).length,
      excludedEvaluatorItems: mem.excludedEvaluatorItems,
      movedIn: mem.movedIn,
      movedOut: mem.movedOut,
    },
    outcome,
    outcomeComposite,
    actors,
    exceptions,
    exceptionCounts: sortRecord(exceptionCounts),
    flags,
    excludedMetrics,
    missingSources,
    maxIngestLagMs: tl.maxIngestLagMs,
    eventCount: milestoneEvents.length,
    byType: sortRecord(byType),
    byActorType: sortRecord(byActorType),
    bySource: sortRecord(bySource),
    issueIds: [...issueIds].sort(),
    actorKeys: [...actorKeys].sort(),
    firstEventTime: milestoneEvents.length > 0 ? milestoneEvents[0]!.eventTime.toISOString() : null,
    lastEventTime: milestoneEvents.length > 0 ? milestoneEvents[milestoneEvents.length - 1]!.eventTime.toISOString() : null,
    state: { open, retrospective },
  };
}

function flagsFrom(exceptions: ExceptionRecord[]): string[] {
  const flags = new Set<string>();
  for (const e of exceptions) if (e.id === "E3" || e.id === "E4") flags.add(`${e.id} present`);
  return [...flags].sort();
}

export function cardHash(card: ScoredCard): string {
  return hashCanonical(card);
}
