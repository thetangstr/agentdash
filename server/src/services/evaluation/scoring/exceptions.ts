import type { EvaluationEventRow } from "../ledger.js";
import { leftBacklogAt } from "./evidence.js";
import { contributors } from "./independence.js";
import { exception, type ScoringContext } from "./metrics.js";
import { assigneeAt, currentStatus, latestSnapshot, snapshotAt, TERMINAL_STATUSES, type ItemTimeline } from "./timeline.js";
import type { ExceptionRecord } from "./types.js";

/**
 * AgentDash: Company Evaluator — exception rules not produced inside a metric
 * (spec §9.1): E2 hash-change-without-activity, E4 self-review, E5 stale work,
 * E10 missing DoD at start, E11 emission drop, E12 DoD narrowed, E13 evidence
 * withdrawn, E14 reviewer concentration. E1/E3/E6/E7/E8/E9 and the timestamp
 * form of E2 are raised by the metrics that observe them.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const ACTIVITY_TOLERANCE_MS = 5 * 60 * 1000;

function issueSubject(it: ItemTimeline): ExceptionRecord["subject"] {
  return { kind: "issue", id: it.issueId, identifier: it.identifier };
}

function activityTimes(it: ItemTimeline): Date[] {
  const times: Date[] = [];
  if (it.created) times.push(it.created.time);
  for (const list of [it.transitions, it.assignments, it.blockers, it.comments, it.dods, it.labelAdds, it.otherActivity, it.handoffs, it.interactions, it.recoveryExhausted] as Array<Array<{ time: Date }>>) {
    for (const x of list) times.push(x.time);
  }
  return times;
}

/** Rule 13: a content change the control plane did not explain. */
export function e2HashChangeWithoutActivity(ctx: ScoringContext): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  for (const it of ctx.members) {
    if (it.snapshots.length < 2) continue;
    const acts = activityTimes(it).map((d) => d.getTime());
    for (const s of it.snapshots.slice(1)) {
      const t = s.time.getTime();
      const explained = acts.some((a) => Math.abs(a - t) <= ACTIVITY_TOLERANCE_MS);
      if (explained) continue;
      out.push(exception(ctx, "E2", issueSubject(it), s.time, [s.eventId], "content hash changed with no control-plane activity within five minutes (rule 13)", assigneeAt(it, s.time).agentId, s.eventId));
    }
  }
  return out;
}

/** §4.2: every non-independent review-class event is E4, immediate. */
export function e4SelfReview(ctx: ScoringContext): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  for (const it of ctx.members) {
    const ev = ctx.evidence.get(it.issueId);
    for (const v of ev?.violations ?? []) {
      out.push(exception(ctx, "E4", issueSubject(it), v.time, [v.eventId], `${v.kind} by a non-independent actor (${v.reason})${v.sharedAccountability ? "; shared accountability" : ""}`, v.actorType === "agent" ? v.actorId : null, v.eventId));
    }
  }
  return out;
}

/** E5: a non-terminal item with no valid action path for more than 48 hours (execution-semantics §7, approximated on the ledger). */
export function e5StaleWork(ctx: ScoringContext): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  const asOf = ctx.tl.asOf.getTime();
  for (const it of ctx.members) {
    const status = currentStatus(it);
    if (!status || TERMINAL_STATUSES.has(status) || status === "backlog") continue;
    const last = it.lastActivity?.getTime() ?? 0;
    if (asOf - last <= 48 * HOUR) continue;
    const pendingInteraction = it.interactions.some((i) => i.status === "pending");
    const decidedIds = new Set(it.approvals.filter((a) => a.kind === "decided").map((a) => a.approvalId));
    const pendingApproval = it.approvals.some((a) => a.kind === "created" && !decidedIds.has(a.approvalId));
    const owner = assigneeAt(it, ctx.tl.asOf);
    if (pendingInteraction || pendingApproval || owner.userId) continue;
    out.push(exception(ctx, "E5", issueSubject(it), new Date(last + 48 * HOUR), it.eventIds.slice(-3), `${status} with no activity, pending question, approval or human owner for ${Math.floor((asOf - last) / DAY)} days`, owner.agentId));
  }
  return out;
}

/** E10: an agent-owned item entered in_progress with no definition of done in force. */
export function e10MissingDodAtStart(ctx: ScoringContext): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  for (const it of ctx.members) {
    const start = it.transitions.find((t) => t.to === "in_progress");
    if (!start) continue;
    const owner = assigneeAt(it, start.time);
    if (!owner.agentId) continue;
    const dodBefore = it.dods.some((d) => d.time <= start.time && (d.criteriaCount ?? 0) > 0);
    if (dodBefore) continue;
    const snap = snapshotAt(it, start.time);
    // Only decide when a snapshot at or before the start shows no DoD; a later snapshot cannot say what was in force.
    if (!snap || snap.time > start.time) continue;
    if ((snap.dodCriteria ?? 0) > 0) continue;
    out.push(exception(ctx, "E10", issueSubject(it), start.time, [start.eventId, snap.eventId], "entered in_progress with no definition of done", owner.agentId));
  }
  return out;
}

/** Rule 10 / E11: an agent's evidence-emission rate falls below half its trailing four-week baseline. */
export function e11EmissionDrop(ctx: ScoringContext, window: EvaluationEventRow[]): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  const asOf = ctx.tl.asOf.getTime();
  const perAgent = new Map<string, number[]>(); // 5 buckets: [last week, -1, -2, -3, -4]
  const firstSeen = new Map<string, number>();
  for (const e of window) {
    if (e.actorType !== "agent" || !e.actorId) continue;
    if (e.eventType.startsWith("evaluation.") || e.eventType === "agent.snapshot") continue;
    const age = asOf - e.eventTime.getTime();
    const t = e.eventTime.getTime();
    firstSeen.set(e.actorId, Math.min(firstSeen.get(e.actorId) ?? t, t));
    if (age < 0 || age >= 5 * WEEK) continue;
    const bucket = Math.floor(age / WEEK);
    const arr = perAgent.get(e.actorId) ?? [0, 0, 0, 0, 0];
    arr[bucket]!++;
    perAgent.set(e.actorId, arr);
  }
  for (const [agentId, arr] of [...perAgent.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const first = firstSeen.get(agentId) ?? asOf;
    if (asOf - first < 5 * WEEK) continue; // no full baseline yet
    const baseline = (arr[1]! + arr[2]! + arr[3]! + arr[4]!) / 4;
    if (baseline < 4) continue; // too quiet to call a drop
    if (arr[0]! < 0.5 * baseline) {
      out.push(exception(ctx, "E11", { kind: "agent", id: agentId, identifier: ctx.tl.agents.get(agentId)?.name ?? null }, ctx.tl.asOf, [], `${arr[0]} events in the last week against a four-week baseline of ${baseline.toFixed(1)} per week`, agentId));
    }
  }
  return out;
}

/** Rule 11 / E12: criteria removed or the count reduced after the item left backlog. */
export function e12DodNarrowed(ctx: ScoringContext): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  for (const it of ctx.members) {
    const boundary = leftBacklogAt(it);
    for (const d of it.dods) {
      if (!d.hasPrevious) continue;
      if (boundary && d.time < boundary) continue;
      const countDown = d.previousCriteriaCount != null && d.criteriaCount != null && d.criteriaCount < d.previousCriteriaCount;
      const removed = d.previousCriteriaIds && d.criteriaIds ? d.previousCriteriaIds.filter((id) => id && !d.criteriaIds!.includes(id)) : [];
      if (!countDown && removed.length === 0) continue;
      out.push(exception(ctx, "E12", issueSubject(it), d.time, [d.eventId], countDown ? `criteria reduced from ${d.previousCriteriaCount} to ${d.criteriaCount} after work started` : `criteria removed after work started: ${removed.join(", ")}`, d.actorType === "agent" ? d.actorId : assigneeAt(it, d.time).agentId, d.eventId));
    }
  }
  return out;
}

/** Rule 13 / E13: a structured self-report disappeared. */
export function e13EvidenceWithdrawn(ctx: ScoringContext): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  for (const it of ctx.members) {
    for (const w of it.withdrawn) {
      out.push(exception(ctx, "E13", { kind: "comment", id: w.commentId ?? w.eventId, identifier: it.identifier }, w.time, [w.eventId], `handoff comment ${w.commentId ?? ""} on ${it.identifier ?? it.issueId} no longer exists`.trim(), assigneeAt(it, w.time).agentId, w.eventId));
    }
  }
  return out;
}

/** Rule 19 / E14: a pair whose reviews of each other exceed 80 % of either's reviews. */
export function e14ReviewerConcentration(ctx: ScoringContext): ExceptionRecord[] {
  const out: ExceptionRecord[] = [];
  const reviewsBy = new Map<string, Map<string, number>>(); // reviewer → reviewed contributor → count
  const total = new Map<string, number>();
  const bump = (reviewer: string, reviewed: string) => {
    const m = reviewsBy.get(reviewer) ?? new Map<string, number>();
    m.set(reviewed, (m.get(reviewed) ?? 0) + 1);
    reviewsBy.set(reviewer, m);
    total.set(reviewer, (total.get(reviewer) ?? 0) + 1);
  };
  for (const it of ctx.members) {
    const cs = [...contributors(it)].filter((k) => k.startsWith("agent:")).map((k) => k.slice(6));
    const reviewers = [
      ...it.verdicts.filter((v) => v.reviewerAgentId).map((v) => v.reviewerAgentId!),
      ...it.handoffs.filter((h) => h.type === "tester_to_reviewer" && h.actorType === "agent" && h.actorId).map((h) => h.actorId!),
    ];
    for (const r of reviewers) for (const c of cs) if (c !== r) bump(r, c);
  }
  const seen = new Set<string>();
  for (const [a, m] of [...reviewsBy.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    for (const [b, ab] of m) {
      const pair = [a, b].sort().join("|");
      if (seen.has(pair)) continue;
      const ba = reviewsBy.get(b)?.get(a) ?? 0;
      const ta = total.get(a) ?? 0;
      const tb = total.get(b) ?? 0;
      if (ab < 3 || ba < 3) continue;
      if (ab / ta > 0.8 || ba / tb > 0.8) {
        seen.add(pair);
        out.push(exception(ctx, "E14", { kind: "pair", id: pair, identifier: `${ctx.tl.agents.get(a)?.name ?? a} ↔ ${ctx.tl.agents.get(b)?.name ?? b}` }, ctx.tl.asOf, [], `${ab} of ${ta} reviews by the first are of the second, ${ba} of ${tb} the other way; these reviews weigh as limited evidence for independent_review`, a));
      }
    }
  }
  return out;
}

export function standaloneExceptions(ctx: ScoringContext, window: EvaluationEventRow[]): ExceptionRecord[] {
  return [
    ...e2HashChangeWithoutActivity(ctx),
    ...e4SelfReview(ctx),
    ...e5StaleWork(ctx),
    ...e10MissingDodAtStart(ctx),
    ...e11EmissionDrop(ctx, window),
    ...e12DodNarrowed(ctx),
    ...e13EvidenceWithdrawn(ctx),
    ...e14ReviewerConcentration(ctx),
  ];
}

const SEVERITY_RANK = { immediate: 0, material: 1, routine: 2 } as const;

/** One record per key (first raised wins), immediate first, then by time, then key — a deterministic order. */
export function mergeExceptions(lists: ExceptionRecord[][]): ExceptionRecord[] {
  const byKey = new Map<string, ExceptionRecord>();
  for (const list of lists) for (const e of list) if (!byKey.has(e.key)) byKey.set(e.key, e);
  return [...byKey.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.raisedAt < b.raisedAt ? -1 : a.raisedAt > b.raisedAt ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function latestSnapshotOf(it: ItemTimeline) {
  return latestSnapshot(it);
}
