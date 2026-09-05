import {
  EVALUATION_EXCEPTIONS,
  EVALUATION_METRIC_NAMES,
  type EvaluationContractV1,
  type EvaluationExceptionId,
  type EvaluationHandoffType,
  type EvaluationMetricKey,
  type EvaluationMilestoneRef,
  type EvaluationSourceTier,
} from "@paperclipai/shared";
import { labelFor, tierFor, minTier } from "./confidence.js";
import type { ResolvedContract } from "./contract.js";
import { gatesPass, type CriterionDisposition, type ItemEvidence } from "./evidence.js";
import { routeFor } from "./independence.js";
import {
  actorKey,
  assigneeAt,
  createdAt,
  doneAt,
  firstInReviewAt,
  labelsAt,
  latestGoal,
  latestProject,
  latestSnapshot,
  median,
  num,
  obj,
  percentile,
  round,
  snapshotAt,
  startedAt,
  statusAt,
  str,
  terminalAt,
  TERMINAL_STATUSES,
  type Handoff,
  type ItemTimeline,
  type Timeline,
} from "./timeline.js";
import type { ExceptionRecord, MetricBreakdown, MetricResult, UndecidableReason } from "./types.js";

/**
 * AgentDash: Company Evaluator — metric formulas (spec §5). Every function is
 * pure over the folded timeline and returns the metric plus the exceptions its
 * rule raised. Nothing is imputed; no volume is ever rewarded (rule 1).
 */

export const METRICS_FORMULA_VERSION = "metrics/1";
const MAX_REFS = 200;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export interface ScoringContext {
  tl: Timeline;
  ref: EvaluationMilestoneRef;
  companyId: string;
  members: ItemTimeline[];
  resolved: ResolvedContract;
  evidence: Map<string, ItemEvidence>;
  dispositions: Map<string, CriterionDisposition[]>;
  retrospective: boolean;
}

export interface MetricOutput {
  metric: MetricResult;
  exceptions: ExceptionRecord[];
}

// ---------------------------------------------------------------- helpers

interface Tally {
  satisfied: string[]; // item / event ids
  failed: string[];
  undecidable: Map<string, string[]>;
  refs: Set<string>;
  tiers: Set<EvaluationSourceTier>;
}

function tally(): Tally {
  return { satisfied: [], failed: [], undecidable: new Map(), refs: new Set(), tiers: new Set() };
}

function undecided(t: Tally, id: string, reason: string) {
  const list = t.undecidable.get(reason) ?? [];
  list.push(id);
  t.undecidable.set(reason, list);
}

function breakdownOf(t: Tally): MetricBreakdown {
  const undecidable: UndecidableReason[] = [...t.undecidable.entries()]
    .map(([reason, ids]) => ({ reason, count: ids.length }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
  return { satisfied: t.satisfied.length, failed: t.failed.length, undecidable };
}

function refsOf(t: Tally): string[] {
  return [...t.refs].sort().slice(0, MAX_REFS);
}

function words(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function headlineRatio(t: Tally, popWord: string, okWord = "satisfied"): string {
  const n = t.satisfied.length + t.failed.length + [...t.undecidable.values()].reduce((s, l) => s + l.length, 0);
  const parts = [`${okWord} ${t.satisfied.length} of ${n} ${popWord}`];
  const und = breakdownOf(t).undecidable;
  const undTotal = und.reduce((s, u) => s + u.count, 0);
  if (undTotal > 0) parts.push(`${undTotal} undecidable (${und.slice(0, 2).map((u) => u.reason).join("; ")}${und.length > 2 ? "; …" : ""})`);
  if (t.failed.length > 0) parts.push(`${t.failed.length} failed`);
  return parts.join("; ");
}

interface Build {
  key: EvaluationMetricKey;
  unit: string;
  n: number;
  value: number | null;
  t: Tally;
  headline: string;
  lowerIsBetter?: boolean;
  displayOnly?: boolean;
  detail?: Record<string, unknown>;
  notes?: string[];
  byConstruction?: boolean;
  disagreement?: boolean;
  /** Force a ceiling (O4 status-only → Low). */
  cap?: "low" | "medium";
  ctx: ScoringContext;
  /** Coverage override for metrics whose decidable population is not the tally (display-only). */
  coverage?: number;
}

function build(b: Build): MetricResult {
  const decidable = b.t.satisfied.length + b.t.failed.length;
  const coverage = b.coverage ?? (b.n > 0 ? decidable / b.n : 0);
  const conf = tierFor({
    coverage,
    tiers: b.t.tiers,
    derivedContract: b.ctx.resolved.source === "derived",
    retrospective: b.ctx.retrospective,
    byConstruction: b.byConstruction,
    disagreement: b.disagreement,
    emptyPopulation: b.n === 0,
  });
  let tier = conf.tier;
  const notes = [...(b.notes ?? []), ...conf.reasons];
  if (b.cap && tier !== "insufficient") {
    const capped = minTier(tier, b.cap);
    if (capped !== tier) notes.push(`capped at ${labelFor(capped)}`);
    tier = capped;
  }
  const shown = tier !== "insufficient" && !b.displayOnly ? b.value : b.displayOnly ? b.value : null;
  return {
    key: b.key,
    name: EVALUATION_METRIC_NAMES[b.key],
    value: tier === "insufficient" ? null : shown,
    unit: b.unit,
    n: b.n,
    coverage: round(coverage),
    confidence: tier,
    confidenceLabel: labelFor(tier),
    breakdown: breakdownOf(b.t),
    headline: tier === "insufficient" ? `insufficient evidence — ${b.headline}` : b.headline,
    formulaVersion: METRICS_FORMULA_VERSION,
    evidenceRefs: refsOf(b.t),
    evidenceRefCount: b.t.refs.size,
    tiers: [...b.t.tiers].sort(),
    lowerIsBetter: b.lowerIsBetter ?? false,
    displayOnly: b.displayOnly ?? false,
    detail: b.detail ?? {},
    notes,
  };
}

export function exception(
  ctx: ScoringContext,
  id: EvaluationExceptionId,
  subject: ExceptionRecord["subject"],
  raisedAt: Date,
  refs: string[],
  note: string,
  agentForRouting: string | null,
  qualifier?: string,
): ExceptionRecord {
  const def = EVALUATION_EXCEPTIONS[id];
  const route = routeFor(agentForRouting, ctx.tl, ctx.resolved.contract.accountableUserId);
  const markers: string[] = [];
  if (ctx.retrospective && id === "E1") markers.push("scored retrospectively — confidence capped");
  return {
    id,
    title: def.title,
    severity: def.severity,
    routes: def.routes,
    key: `${id}:${subject.kind}:${subject.id}${qualifier ? `:${qualifier}` : ""}`,
    subject,
    routing: {
      accountableUserId: route.accountableUserId,
      managerAgentIds: route.managerAgentIds,
      founderView: def.routes.includes("founder_view"),
    },
    raisedAt: raisedAt.toISOString(),
    evidenceRefs: refs.slice(0, 50),
    note,
    markers,
  };
}

function subjectIssue(it: ItemTimeline): ExceptionRecord["subject"] {
  return { kind: "issue", id: it.issueId, identifier: it.identifier };
}

function ownerAgentAt(it: ItemTimeline, time: Date): string | null {
  return assigneeAt(it, time).agentId;
}

function done(ctx: ScoringContext): ItemTimeline[] {
  return ctx.members.filter((m) => doneAt(m) !== null);
}

// ---------------------------------------------------------------- outcome

/** O1 Acceptance satisfied: every applicable criterion has a satisfied disposition. */
export function o1Acceptance(ctx: ScoringContext): MetricOutput {
  const t = tally();
  const exceptions: ExceptionRecord[] = [];
  const items = done(ctx);
  const criteria = ctx.resolved.contract.acceptanceCriteria;
  for (const it of items) {
    if (criteria.length === 0) {
      undecided(t, it.issueId, ctx.resolved.source === "derived" ? "no acceptance criteria declared (derived contract)" : "contract declares no acceptance criteria");
      continue;
    }
    const ds = ctx.dispositions.get(it.issueId) ?? [];
    for (const d of ds) for (const r of d.refs) t.refs.add(r);
    const failed = ds.filter((d) => d.state === "failed");
    const und = ds.filter((d) => d.state === "undecidable");
    if (failed.length > 0) {
      t.failed.push(it.issueId);
      t.tiers.add("T0");
      exceptions.push(
        exception(ctx, "E1", subjectIssue(it), doneAt(it)!, failed.flatMap((f) => f.refs), `done with ${words(failed.length, "unsatisfied criterion", "unsatisfied criteria")}: ${failed.map((f) => `${f.criterionId} (${f.reason})`).join("; ")}`, ownerAgentAt(it, doneAt(it)!)),
      );
    } else if (und.length > 0) {
      undecided(t, it.issueId, und[0]!.reason);
    } else {
      t.satisfied.push(it.issueId);
      t.tiers.add("T0");
      if (ds.some((d) => d.refs.length > 0)) t.tiers.add("T2");
    }
  }
  const n = items.length;
  const value = n > 0 ? round(t.satisfied.length / n) : null;
  return {
    metric: build({
      ctx,
      key: "O1",
      unit: "share of done items",
      n,
      value,
      t,
      headline: headlineRatio(t, "done"),
      notes: criteria.length === 0 ? ["no criterion carries a check, so acceptance cannot be decided; the gap is the measurement (§5.1)"] : [],
    }),
    exceptions,
  };
}

/** O2 Deadline adherence: the milestone against its target date (issues carry none). */
export function o2Deadline(ctx: ScoringContext): MetricOutput {
  const t = tally();
  const target = ctx.resolved.contract.targetDate;
  if (!target) {
    return {
      metric: build({ ctx, key: "O2", unit: "share closed on time", n: 0, value: null, t, headline: "no target date on the milestone or its contract", notes: ["set projects.targetDate or the contract's targetDate to measure"] }),
      exceptions: [],
    };
  }
  const due = new Date(`${target}T23:59:59.999Z`);
  const project = ctx.ref.kind === "project" ? latestProject(ctx.tl, ctx.ref.id) : null;
  const goal = ctx.ref.kind === "goal" ? latestGoal(ctx.tl, ctx.ref.id) : null;
  const closedAt = project && (project.status === "completed" || project.status === "cancelled") ? project.time : goal && (goal.status === "achieved" || goal.status === "cancelled") ? goal.time : null;
  const id = ctx.ref.id;
  const ref = project?.eventId ?? goal?.eventId;
  if (ref) t.refs.add(ref);
  t.tiers.add("T0");
  if (closedAt) {
    if (closedAt <= due) t.satisfied.push(id);
    else t.failed.push(id);
  } else if (ctx.tl.asOf <= due) {
    undecided(t, id, "open and not yet due");
  } else {
    t.failed.push(id);
  }
  return {
    metric: build({ ctx, key: "O2", unit: "share closed on time", n: 1, value: t.satisfied.length, t, headline: closedAt ? `closed ${closedAt <= due ? "on or before" : "after"} ${target}` : ctx.tl.asOf <= due ? `open, due ${target}` : `open past its target ${target}`, detail: { targetDate: target, closedAt: closedAt?.toISOString() ?? null } }),
    exceptions: [],
  };
}

/** O3 Downstream risk index: consequences after close per delivered item (lower is better). */
export function o3DownstreamRisk(ctx: ScoringContext): MetricOutput {
  const t = tally();
  const exceptions: ExceptionRecord[] = [];
  const items = done(ctx);
  let reopens = 0;
  let blockersCiting = 0;
  let reverts = 0;
  let withDeliveryRef = 0;
  const shippedPr = new Map<string, number>(); // issueId → pr number
  for (const it of items) {
    const merged = it.handoffs.find((h) => h.type === "tpm_merge_report" && str(h.payload, "merge_result") === "shipped" && obj(h.payload, "pr"));
    const pr = merged ? num(obj(merged.payload, "pr")!, "number") : null;
    if (pr != null) shippedPr.set(it.issueId, pr);
  }
  const allReverts = ctx.members.flatMap((m) => m.handoffs.filter((h) => h.type === "tpm_merge_report" && str(h.payload, "merge_result") === "reverted"));
  for (const it of items) {
    const closed = doneAt(it)!;
    let consequences = 0;
    for (const tr of it.transitions) {
      if (tr.time > closed && tr.from === "done" && !TERMINAL_STATUSES.has(tr.to)) {
        consequences++;
        reopens++;
        t.refs.add(tr.eventId);
        const stillOpen = !TERMINAL_STATUSES.has(statusAt(it, ctx.tl.asOf) ?? "");
        if (stillOpen && ctx.tl.asOf.getTime() - tr.time.getTime() > 7 * DAY) {
          exceptions.push(exception(ctx, "E9", subjectIssue(it), tr.time, [tr.eventId], "reopened after close and still open seven days later", ownerAgentAt(it, closed)));
        }
      }
    }
    for (const other of ctx.tl.items.values()) {
      if (other.issueId === it.issueId) continue;
      for (const b of other.blockers) {
        if (b.time <= closed) continue;
        const before = new Set(b.previous ?? []);
        if (b.blockedByIssueIds.includes(it.issueId) && !before.has(it.issueId)) {
          consequences++;
          blockersCiting++;
          t.refs.add(b.eventId);
        }
      }
    }
    const pr = shippedPr.get(it.issueId);
    if (pr != null) {
      withDeliveryRef++;
      for (const rv of allReverts) {
        const rpr = num(obj(rv.payload, "pr") ?? {}, "number");
        if (rpr === pr && rv.time > closed) {
          consequences++;
          reverts++;
          t.refs.add(rv.eventId);
          t.tiers.add("T2");
        }
      }
    }
    t.tiers.add("T0");
    if (consequences > 0) t.failed.push(it.issueId);
    else t.satisfied.push(it.issueId);
  }
  const n = items.length;
  const total = reopens + blockersCiting + reverts;
  const value = n > 0 ? round(total / n) : null;
  return {
    metric: build({
      ctx,
      key: "O3",
      unit: "consequences per delivered item",
      n,
      value,
      t,
      lowerIsBetter: true,
      headline: n === 0 ? "no delivered items" : `${words(total, "consequence")} across ${words(n, "delivered item")}: ${reopens} reopened, ${blockersCiting} cited as blockers, ${reverts} reverted`,
      detail: {
        reopens,
        blockersCiting,
        revertTerm: { reverts, coverage: n > 0 ? round(withDeliveryRef / n) : 0, note: "counted only where T2 delivery evidence exists" },
        incidentTerm: "insufficient by construction: server_errors carries no company, agent, run or release link (F6)",
        recoveryIssueTerm: "not modelled: no record links a recovery issue to the item it recovers",
      },
      notes: ["index, lower is better; consequences are T0 facts (reopen, blocker citing the item) plus T2-conditional reverts"],
    }),
    exceptions,
  };
}

/** O4 Goal progress: status transitions, plus the outcome target when measurable. */
export function o4GoalProgress(ctx: ScoringContext): MetricOutput {
  const t = tally();
  const goalId = ctx.resolved.contract.goalId;
  const goal = goalId ? latestGoal(ctx.tl, goalId) : null;
  if (!goalId || !goal) {
    return { metric: build({ ctx, key: "O4", unit: "goal progress", n: 0, value: null, t, headline: goalId ? "goal has no roster snapshot in the window" : "milestone is linked to no goal" }), exceptions: [] };
  }
  t.refs.add(goal.eventId);
  t.tiers.add("T0");
  const statusValue: Record<string, number> = { planned: 0, active: 0.5, achieved: 1, cancelled: 0 };
  const v = statusValue[goal.status ?? ""] ?? 0;
  if (goal.status === "achieved") t.satisfied.push(goalId);
  else if (goal.status === "cancelled") t.failed.push(goalId);
  else t.satisfied.push(goalId); // status known: decidable; value carries the progress
  const target = ctx.resolved.contract.outcomeTarget;
  const notes: string[] = [];
  if (!target) notes.push("no outcome target: status only");
  else notes.push("outcome target declared but goal measurements are not recorded on this deployment: status only");
  return {
    metric: build({
      ctx,
      key: "O4",
      unit: "goal progress (status)",
      n: 1,
      value: v,
      t,
      headline: `goal ${goal.title ?? goalId} is ${goal.status ?? "unknown"}${target ? `; target ${target.target} ${target.unit} unmeasured` : ""}`,
      detail: { goalId, status: goal.status, outcomeTarget: target, statusTransitions: (ctx.tl.goals.get(goalId) ?? []).map((s) => ({ at: s.time.toISOString(), status: s.status })) },
      notes,
      cap: "low",
    }),
    exceptions: [],
  };
}

/** O5 Evidence hygiene: every required class present on each done item. */
export function o5EvidenceHygiene(ctx: ScoringContext): MetricOutput {
  const t = tally();
  const items = done(ctx);
  const required = ctx.resolved.contract.requiredEvidence;
  const perClass: Record<string, { satisfied: number; failed: number; undecidable: number }> = {};
  for (const it of items) {
    const ev = ctx.evidence.get(it.issueId);
    if (!ev) {
      undecided(t, it.issueId, "no evidence computed");
      continue;
    }
    let failed = false;
    let und: string | null = null;
    for (const cls of required) {
      const r = ev.classes[cls];
      const pc = (perClass[cls] ??= { satisfied: 0, failed: 0, undecidable: 0 });
      if (!r) {
        pc.undecidable++;
        und = und ?? `${cls}: not evaluated`;
        continue;
      }
      for (const ref of r.refs) t.refs.add(ref);
      for (const tier of r.tiers) t.tiers.add(tier);
      if (r.state === "satisfied") pc.satisfied++;
      else if (r.state === "failed") {
        pc.failed++;
        failed = true;
      } else {
        pc.undecidable++;
        und = und ?? `${cls}: ${r.reason}`;
      }
    }
    if (failed) t.failed.push(it.issueId);
    else if (und) undecided(t, it.issueId, und);
    else t.satisfied.push(it.issueId);
  }
  const n = items.length;
  return {
    metric: build({
      ctx,
      key: "O5",
      unit: "share of done items with every required class",
      n,
      value: n > 0 ? round(t.satisfied.length / n) : null,
      t,
      headline: headlineRatio(t, "done", "fully evidenced"),
      detail: { requiredEvidence: [...required], perClass },
    }),
    exceptions: [],
  };
}

// ---------------------------------------------------------------- operating (per agent)

export interface ActorScope {
  agentId: string;
  /** Member items this agent owned at any point. */
  items: ItemTimeline[];
}

export function actorsIn(ctx: ScoringContext): ActorScope[] {
  const map = new Map<string, Set<string>>();
  const add = (agentId: string | null, it: ItemTimeline) => {
    if (!agentId) return;
    const set = map.get(agentId) ?? new Set<string>();
    set.add(it.issueId);
    map.set(agentId, set);
  };
  for (const it of ctx.members) {
    for (const s of it.snapshots) add(s.assigneeAgentId, it);
    for (const a of it.assignments) {
      add(a.toAgentId, it);
      if (a.actorType === "agent") add(a.actorId, it);
    }
    for (const r of it.runs) add(r.agentId, it);
    for (const h of it.handoffs) if (h.actorType === "agent") add(h.actorId, it);
    for (const v of it.verdicts) add(v.reviewerAgentId, it);
    // an agent that only ever moved or commented on a member item is still an actor (P6 needs it)
    for (const t of it.transitions) if (t.actorType === "agent") add(t.actorId, it);
    for (const c of it.comments) if (c.actorType === "agent") add(c.actorId, it);
    for (const b of it.blockers) if (b.actorType === "agent") add(b.actorId, it);
  }
  // refusals name their agent even when no member item is involved
  const refused = new Set<string>();
  for (const r of ctx.tl.authzRefused) if (r.actorType === "agent" && r.actorId && !map.has(r.actorId)) refused.add(r.actorId);
  const scopes = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([agentId, ids]) => ({ agentId, items: ctx.members.filter((m) => ids.has(m.issueId)) }));
  for (const agentId of [...refused].sort()) scopes.push({ agentId, items: [] });
  return scopes.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
}

function humanActed(actorType: string): boolean {
  return actorType === "user";
}

/** Items this agent owned when they reached in_review or done. */
function ownedReaching(scope: ActorScope): Array<{ it: ItemTimeline; reachedAt: Date }> {
  const out: Array<{ it: ItemTimeline; reachedAt: Date }> = [];
  for (const it of scope.items) {
    const reach = it.transitions.find((t) => t.to === "in_review" || t.to === "done") ?? null;
    const reachedAt = reach?.time ?? doneAt(it) ?? null;
    if (!reachedAt) continue;
    if (assigneeAt(it, new Date(reachedAt.getTime() - 1)).agentId === scope.agentId || assigneeAt(it, reachedAt).agentId === scope.agentId) out.push({ it, reachedAt });
  }
  return out;
}

/** P1 Autonomy: agent-owned items reaching in_review/done with zero human interventions. */
export function p1Autonomy(ctx: ScoringContext, scope: ActorScope): MetricOutput {
  const t = tally();
  const exceptions: ExceptionRecord[] = [];
  const pop = ownedReaching(scope);
  let interventionsTotal = 0;
  const perItem: Record<string, number> = {};
  for (const { it, reachedAt } of pop) {
    let count = 0;
    let humanCompleted = false;
    const ownedFrom = it.assignments.find((a) => a.toAgentId === scope.agentId)?.time ?? it.snapshots[0]?.time ?? createdAt(it) ?? new Date(0);
    const during = (time: Date) => time >= ownedFrom && (assigneeAt(it, new Date(time.getTime() - 1)).agentId === scope.agentId || time <= reachedAt);
    for (const tr of it.transitions) {
      if (!humanActed(tr.actorType) || !during(tr.time)) continue;
      count++;
      t.refs.add(tr.eventId);
      if (tr.to === "done") humanCompleted = true;
    }
    for (const a of it.assignments) {
      if (!humanActed(a.actorType) || !during(a.time)) continue;
      if (a.toAgentId === scope.agentId && !a.fromAgentId) continue; // the initial hand to the agent is not an intervention
      count++;
      t.refs.add(a.eventId);
    }
    for (const b of it.blockers) {
      if (!humanActed(b.actorType) || !during(b.time)) continue;
      count++;
      t.refs.add(b.eventId);
    }
    for (const c of it.comments) {
      if (!humanActed(c.actorType) || !c.reopened || !during(c.time)) continue;
      count++;
      t.refs.add(c.eventId);
    }
    perItem[it.issueId] = count;
    interventionsTotal += count;
    t.tiers.add("T0");
    if (count === 0) t.satisfied.push(it.issueId);
    else t.failed.push(it.issueId);
    if (count >= 3 || humanCompleted) {
      exceptions.push(exception(ctx, "E8", subjectIssue(it), reachedAt, [...t.refs].slice(-count), humanCompleted ? "a human completed an agent-owned item" : `${count} human interventions on one item`, scope.agentId));
    }
  }
  const n = pop.length;
  return {
    metric: build({
      ctx,
      key: "P1",
      unit: "share of items with zero interventions",
      n,
      value: n > 0 ? round(t.satisfied.length / n) : null,
      t,
      headline: n === 0 ? "no agent-owned items reached review or done" : `${t.satisfied.length} of ${n} items reached review or done with no human intervention; ${words(interventionsTotal, "intervention")} in all`,
      detail: { interventions: interventionsTotal, perItem, caveat: ctx.tl.humanActors.size > 0 && [...ctx.tl.humanActors].every((u) => u.startsWith("local-") || u === "board") ? "synthetic human identities: interventions are countable, not attributable (§7)" : null },
    }),
    exceptions,
  };
}

/** P2 Judgment: escalation precision through the verdict-approval bridge; rubric dimensions shown. */
export function p2Judgment(ctx: ScoringContext, scope: ActorScope): MetricOutput {
  const t = tally();
  let raised = 0;
  let approved = 0;
  for (const it of ctx.members) {
    const escalations = it.verdicts.filter((v) => v.outcome === "escalated_to_human" && v.reviewerAgentId === scope.agentId);
    const requested = it.approvals.filter((a) => a.kind === "created" && a.actorType === "agent" && a.actorId === scope.agentId && (a.type === "request_board_approval" || a.type === "verdict_escalation"));
    for (const e of escalations) {
      raised++;
      t.refs.add(e.eventId);
      t.tiers.add("T0");
      const decided = it.approvals.find((a) => a.kind === "decided" && a.type === "verdict_escalation" && a.time >= e.time);
      if (!decided) undecided(t, e.eventId, "escalation not yet decided");
      else if (decided.decision === "approved") {
        approved++;
        t.satisfied.push(e.eventId);
        t.refs.add(decided.eventId);
      } else {
        t.failed.push(e.eventId);
        t.refs.add(decided.eventId);
      }
    }
    for (const r of requested) {
      if (r.type === "verdict_escalation" && escalations.length > 0) continue; // the verdict already counted it
      raised++;
      t.refs.add(r.eventId);
      t.tiers.add("T0");
      const decided = it.approvals.find((a) => a.kind === "decided" && a.approvalId === r.approvalId);
      if (!decided) undecided(t, r.eventId, "approval not yet decided");
      else if (decided.decision === "approved") {
        approved++;
        t.satisfied.push(r.eventId);
      } else t.failed.push(r.eventId);
    }
  }
  // rubric dimensions on the agent's own items (verdicts by others)
  const dims: Record<string, { sum: number; n: number }> = {};
  for (const it of scope.items) {
    for (const v of it.verdicts) {
      if (v.reviewerAgentId === scope.agentId || !v.rubricScores) continue;
      for (const [k, raw] of Object.entries(v.rubricScores)) {
        const score = typeof raw === "number" ? raw : raw && typeof raw === "object" ? num(raw as Record<string, unknown>, "score") : null;
        if (score == null) continue;
        const d = (dims[k] ??= { sum: 0, n: 0 });
        d.sum += score;
        d.n++;
      }
    }
  }
  const rubric = Object.fromEntries(Object.entries(dims).sort().map(([k, d]) => [k, { mean: round(d.sum / d.n, 2), n: d.n }]));
  const n = raised;
  return {
    metric: build({
      ctx,
      key: "P2",
      unit: "escalation precision",
      n,
      value: n > 0 && t.satisfied.length + t.failed.length > 0 ? round(approved / (t.satisfied.length + t.failed.length)) : null,
      t,
      headline: n === 0 ? "no escalations raised" : `${approved} of ${words(n, "escalation")} approved as raised`,
      detail: { raised, approved, rubricDimensions: rubric },
      notes: ["unanswered questions are charged to the company row, not the asking agent"],
    }),
    exceptions: [],
  };
}

/** P3 Factual accuracy: checkable claims only; a contradiction is E2. */
export function p3FactualAccuracy(ctx: ScoringContext, scope: ActorScope): MetricOutput {
  const t = tally();
  const exceptions: ExceptionRecord[] = [];
  let checkable = 0;
  let contradicted = 0;
  for (const it of ctx.members) {
    for (const h of it.handoffs) {
      if (h.actorType !== "agent" || h.actorId !== scope.agentId) continue;
      if (h.claimedTimestamp && !h.timestampClamped) {
        checkable++;
        t.refs.add(h.eventId);
        t.tiers.add("T2");
        t.tiers.add("T0");
        if (h.timestampSuspicious) {
          contradicted++;
          t.failed.push(h.eventId);
          exceptions.push(exception(ctx, "E2", subjectIssue(it), h.time, [h.eventId], `${h.type} payload claims a time earlier than its comment by more than the tolerance (rule 4)`, scope.agentId, h.eventId));
        } else t.satisfied.push(h.eventId);
      }
    }
  }
  const n = checkable;
  return {
    metric: build({
      ctx,
      key: "P3",
      unit: "share of checkable claims not contradicted",
      n,
      value: n > 0 ? round(1 - contradicted / n) : null,
      t,
      headline: n === 0 ? "no checkable claims: prose is neither credited nor penalised" : `${n - contradicted} of ${words(n, "checkable claim")} hold; ${contradicted} contradicted`,
      detail: { checkable, contradicted, counterpartsMissing: ["regression_gates vs CI (needs the GitHub adapter, D4)", "merge_result vs PR state (D4)", "run status claims (no structured run self-report field)"] },
      notes: ["only payload timestamps have a higher-tier counterpart today (the comment's arrival)"],
    }),
    exceptions,
  };
}

const REQUIRED_HANDOFF_KEYS: Record<EvaluationHandoffType, readonly string[]> = {
  pm_to_builder: ["issue", "epic", "size", "deployment_path", "acceptance_criteria", "timestamp"],
  builder_to_ci: ["issue", "size", "pr", "branch", "regression_gates", "labels_applied", "timestamp"],
  tester_to_reviewer: ["issue", "verdict", "regression_gates", "labels_applied", "timestamp"],
  reviewer_to_tpm: ["issue", "size", "deployment_path", "pr", "verification_method", "labels_applied", "timestamp"],
  tpm_merge_report: ["issue", "merge_result", "timestamp"],
};

function handoffWellFormed(h: Handoff): { ok: boolean; missing: string[] } {
  const present = new Set([...Object.keys(h.payload), ...h.droppedKeys, "handoff_type", "timestamp"]);
  const missing = REQUIRED_HANDOFF_KEYS[h.type].filter((k) => !present.has(k));
  return { ok: missing.length === 0, missing };
}

/** P4 Handoff quality: well-formed payload, derivable receiver, no bounce within 24 h. */
export function p4HandoffQuality(ctx: ScoringContext, scope: ActorScope): MetricOutput {
  const t = tally();
  let n = 0;
  const reasons: Record<string, number> = {};
  const fail = (id: string, why: string) => {
    t.failed.push(id);
    reasons[why] = (reasons[why] ?? 0) + 1;
  };
  for (const it of ctx.members) {
    for (const h of it.handoffs) {
      if (h.actorType !== "agent" || h.actorId !== scope.agentId) continue;
      n++;
      t.refs.add(h.eventId);
      t.tiers.add("T2");
      const wf = handoffWellFormed(h);
      const receiver = assigneeAt(it, h.time);
      const derivable = !!(receiver.agentId || receiver.userId);
      const bounce = it.transitions.some((tr) => tr.time > h.time && tr.time.getTime() - h.time.getTime() <= DAY && tr.from === "in_review" && tr.to === "in_progress");
      if (!wf.ok) fail(h.eventId, `payload missing ${wf.missing.join(", ")}`);
      else if (!derivable) fail(h.eventId, "no derivable receiver (item unassigned at comment time)");
      else if (bounce) fail(h.eventId, "bounced back within 24 h");
      else t.satisfied.push(h.eventId);
    }
    for (const a of it.assignments) {
      if (a.actorType !== "agent" || a.actorId !== scope.agentId || !(a.toAgentId || a.toUserId)) continue;
      n++;
      t.refs.add(a.eventId);
      t.tiers.add("T0");
      const snap = snapshotAt(it, a.time);
      const hasDod = (snap?.dodCriteria ?? 0) > 0 || it.dods.some((d) => d.time <= a.time && (d.criteriaCount ?? 0) > 0);
      const bounce = it.assignments.some((b) => b.time > a.time && b.time.getTime() - a.time.getTime() <= DAY && b.toAgentId === a.fromAgentId && b.toAgentId != null);
      if (!hasDod) fail(a.eventId, "assignment without a definition of done");
      else if (bounce) fail(a.eventId, "reassigned back within 24 h");
      else t.satisfied.push(a.eventId);
    }
  }
  return {
    metric: build({
      ctx,
      key: "P4",
      unit: "share of well-formed handoffs",
      n,
      value: n > 0 ? round(t.satisfied.length / n) : null,
      t,
      headline: n === 0 ? "no handoffs by this agent" : `${t.satisfied.length} of ${words(n, "handoff")} well-formed`,
      detail: { failures: reasons, note: "description presence is not in the ledger; assignments are judged on the definition of done" },
    }),
    exceptions: [],
  };
}

/** P5 Recovery: shown, never scored. */
export function p5Recovery(ctx: ScoringContext, scope: ActorScope): MetricOutput {
  const t = tally();
  const failedRuns: Array<{ it: ItemTimeline; time: Date; eventId: string; runId: string | null }> = [];
  for (const it of scope.items) {
    for (const r of it.runs) {
      if (r.agentId !== scope.agentId) continue;
      if (r.status === "failed" || r.status === "timed_out" || r.status === "cancelled") failedRuns.push({ it, time: r.time, eventId: r.eventId, runId: r.runId });
    }
  }
  const recoveryMs: number[] = [];
  let auto = 0;
  let explicit = 0;
  let human = 0;
  let unresolved = 0;
  for (const f of failedRuns) {
    t.refs.add(f.eventId);
    t.tiers.add("T0");
    const nextRun = f.it.runs.find((r) => r.startedAt && r.startedAt > f.time);
    const humanAct = [...f.it.transitions, ...f.it.assignments, ...f.it.comments].filter((x) => x.actorType === "user" && x.time > f.time).sort((a, b) => a.time.getTime() - b.time.getTime())[0];
    const recovery = f.it.transitions.find((x) => x.time > f.time && x.to === "blocked" && x.actorType === "system");
    const candidates = [nextRun?.startedAt ?? null, humanAct?.time ?? null, recovery?.time ?? null].filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime());
    const first = candidates[0];
    if (!first) {
      unresolved++;
      undecided(t, f.eventId, "no action path recorded after the failed run");
      continue;
    }
    recoveryMs.push(first.getTime() - f.time.getTime());
    t.satisfied.push(f.eventId);
    if (nextRun?.startedAt && nextRun.startedAt.getTime() === first.getTime() && (nextRun.retryOfRunId === f.runId || nextRun.agentId === scope.agentId)) auto++;
    else if (recovery && recovery.time.getTime() === first.getTime()) explicit++;
    else human++;
  }
  const exhausted = scope.items.reduce((s, it) => s + it.recoveryExhausted.length, 0);
  const n = failedRuns.length;
  return {
    metric: build({
      ctx,
      key: "P5",
      unit: "hours to a valid action path",
      n,
      value: median(recoveryMs) != null ? round(median(recoveryMs)! / HOUR, 2) : null,
      t,
      displayOnly: true,
      headline: n === 0 ? "no failed, timed-out or cancelled runs" : `${words(n, "failed run")}: median ${median(recoveryMs) != null ? round(median(recoveryMs)! / HOUR, 1) : "—"} h to an action path (p90 ${percentile(recoveryMs, 0.9) != null ? round(percentile(recoveryMs, 0.9)! / HOUR, 1) : "—"} h); ${auto} auto-recovered, ${explicit} explicit recovery, ${human} human, ${unresolved} unresolved`,
      detail: { failedRuns: n, medianHours: median(recoveryMs) != null ? round(median(recoveryMs)! / HOUR, 2) : null, p90Hours: percentile(recoveryMs, 0.9) != null ? round(percentile(recoveryMs, 0.9)! / HOUR, 2) : null, autoRecovered: auto, explicitRecovery: explicit, humanEscalation: human, unresolved, recoveryBudgetExhausted: exhausted },
      notes: ["shown, not scored, until its populations are stable (§5.3)"],
    }),
    exceptions: [],
  };
}

/** P6 Authority compliance: detected violations as a count with rules; every detection is E3 immediate. */
export function p6Authority(ctx: ScoringContext, scope: ActorScope): MetricOutput {
  const t = tally();
  const exceptions: ExceptionRecord[] = [];
  const rules: Record<string, number> = {};
  const hit = (rule: string, it: ItemTimeline | null, time: Date, ref: string, note: string) => {
    rules[rule] = (rules[rule] ?? 0) + 1;
    t.failed.push(ref);
    t.refs.add(ref);
    t.tiers.add("T0");
    exceptions.push(exception(ctx, "E3", it ? subjectIssue(it) : { kind: "agent", id: scope.agentId }, time, [ref], `${rule}: ${note}`, scope.agentId, ref));
  };
  const locks = new Set(ctx.resolved.contract.founderLocks);
  for (const it of ctx.members) {
    const ev = ctx.evidence.get(it.issueId);
    for (const v of ev?.violations ?? []) {
      if (v.actorType === "agent" && v.actorId === scope.agentId) hit("self_review", it, v.time, v.eventId, `${v.kind} by a contributor (${v.reason})`);
    }
    if (locks.has(it.issueId)) {
      for (const x of [...it.transitions, ...it.assignments, ...it.comments]) {
        if (x.actorType === "agent" && x.actorId === scope.agentId) hit("founder_lock", it, x.time, x.eventId, "agent acted on a founder-locked item");
      }
    }
    for (const tr of it.transitions) {
      if (tr.actorType !== "agent" || tr.actorId !== scope.agentId) continue;
      const owner = assigneeAt(it, new Date(tr.time.getTime() - 1)).agentId;
      if (owner && owner !== scope.agentId) hit("transition_not_assigned", it, tr.time, tr.eventId, `moved ${tr.from ?? "?"}→${tr.to} on an item assigned to another agent`);
    }
    for (const h of it.handoffs) {
      if (h.type !== "tpm_merge_report" || h.actorType !== "agent" || h.actorId !== scope.agentId || str(h.payload, "merge_result") !== "shipped") continue;
      const gates = it.handoffs.some((g) => g.time <= h.time && gatesPass(obj(g.payload, "regression_gates")) === true);
      if (!gates) hit("merge_without_gates", it, h.time, h.eventId, "merge reported with no passing regression gates on record");
    }
  }
  for (const r of ctx.tl.authzRefused) {
    if (r.actorType === "agent" && r.actorId === scope.agentId) {
      const it = r.issueId ? (ctx.tl.items.get(r.issueId) ?? null) : null;
      hit("authz_refused", it, r.time, r.eventId, `refused ${str(r.payload, "method") ?? ""} ${str(r.payload, "routePath") ?? ""} (${str(r.payload, "reasonCode") ?? "no reason code"})`.trim());
    }
  }
  const n = t.failed.length;
  return {
    metric: build({
      ctx,
      key: "P6",
      unit: "detected violations",
      n,
      value: n,
      t,
      displayOnly: true,
      coverage: 1,
      headline: n === 0 ? "no violations detected" : `${words(n, "violation")}: ${Object.entries(rules).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`,
      detail: { rules, refusalsLogged: ctx.tl.sources.authzRefused },
      notes: ["a count, not a ratio: refused actions leave a record only once authz.refused is emitted (AGE-91)"],
    }),
    exceptions,
  };
}

function sizeOf(it: ItemTimeline): string | null {
  for (const l of labelsAt(it, it.lastActivity ?? new Date(0))) {
    const m = /^size:\s*(xs|s|m|l|xl)$/i.exec(l);
    if (m) return m[1]!.toUpperCase();
  }
  const pm = it.handoffs.find((h) => h.type === "pm_to_builder" && typeof h.payload.size === "string");
  return pm ? (pm.payload.size as string).toUpperCase() : null;
}

/** P7 Cycle time: medians and p90 per phase, bucketed by size only where a size signal exists. Shown, never scored. */
export function p7CycleTime(ctx: ScoringContext, scope: ActorScope | null): MetricOutput {
  const t = tally();
  const items = (scope ? scope.items : ctx.members).filter((m) => doneAt(m) !== null);
  const phases = { queue: [] as number[], work: [] as number[], review: [] as number[], total: [] as number[] };
  const bySize: Record<string, number[]> = {};
  let sized = 0;
  for (const it of items) {
    const c = createdAt(it);
    const s = startedAt(it);
    const r = firstInReviewAt(it);
    const d = doneAt(it)!;
    t.tiers.add("T0");
    if (c) {
      phases.total.push(d.getTime() - c.getTime());
      t.satisfied.push(it.issueId);
      for (const id of it.eventIds.slice(0, 3)) t.refs.add(id);
    } else undecided(t, it.issueId, "creation time unknown");
    if (c && s) phases.queue.push(s.getTime() - c.getTime());
    if (s && r) phases.work.push(r.getTime() - s.getTime());
    if (r) phases.review.push(d.getTime() - r.getTime());
    const size = sizeOf(it);
    if (size && c) {
      sized++;
      (bySize[size] ??= []).push(d.getTime() - c.getTime());
    }
  }
  const stat = (xs: number[]) => ({ n: xs.length, medianHours: median(xs) != null ? round(median(xs)! / HOUR, 1) : null, p90Hours: percentile(xs, 0.9) != null ? round(percentile(xs, 0.9)! / HOUR, 1) : null });
  const n = items.length;
  return {
    metric: build({
      ctx,
      key: "P7",
      unit: "hours (median total)",
      n,
      value: median(phases.total) != null ? round(median(phases.total)! / HOUR, 1) : null,
      t,
      displayOnly: true,
      headline: n === 0 ? "no done items" : `median ${stat(phases.total).medianHours ?? "—"} h created→done over ${words(n, "item")} (p90 ${stat(phases.total).p90Hours ?? "—"} h); size known for ${sized} of ${n}`,
      detail: { phases: { queue: stat(phases.queue), work: stat(phases.work), review: stat(phases.review), total: stat(phases.total) }, bySize: Object.fromEntries(Object.entries(bySize).sort().map(([k, v]) => [k, stat(v)])), sizeCoverage: n > 0 ? round(sized / n) : 0 },
      notes: ["shown, never scored; an unbucketed median is not a normalised one"],
    }),
    exceptions: [],
  };
}

/** P8 Token and cost efficiency: cost_events only; usage_json shown as self-reported. Shown, never scored. */
export function p8Cost(ctx: ScoringContext, scope: ActorScope, o1SatisfiedForAgent: number | null): MetricOutput {
  const t = tally();
  const exceptions: ExceptionRecord[] = [];
  const runs = scope.items.flatMap((it) => it.runs.filter((r) => r.agentId === scope.agentId).map((r) => ({ it, r })));
  const costs = scope.items.flatMap((it) => it.costs.filter((c) => c.agentId === scope.agentId));
  const costByRun = new Map<string, number>();
  for (const c of costs) if (c.runId) costByRun.set(c.runId, (costByRun.get(c.runId) ?? 0) + (c.costCents ?? 0));
  let metered = 0;
  let selfReportedTokens = 0;
  const perRunCents: number[] = [];
  for (const { r } of runs) {
    t.tiers.add("T0");
    if (r.runId && costByRun.has(r.runId)) {
      metered++;
      t.satisfied.push(r.eventId);
      perRunCents.push(costByRun.get(r.runId)!);
    } else {
      undecided(t, r.eventId, r.usagePresent ? "usage self-reported by the adapter, no cost event" : "no metering");
      if (r.usagePresent) selfReportedTokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
    }
    t.refs.add(r.eventId);
  }
  const totalCents = perRunCents.reduce((s, x) => s + x, 0);
  const med = median(perRunCents);
  let anomalies = 0;
  if (med != null && med > 0) {
    for (const { it, r } of runs) {
      const c = r.runId ? costByRun.get(r.runId) : undefined;
      if (c != null && c > 3 * med) {
        anomalies++;
        exceptions.push(exception(ctx, "E7", subjectIssue(it), r.time, [r.eventId], `run cost ${c}¢ exceeds 3× the agent's median ${med}¢`, scope.agentId, r.eventId));
      }
    }
  }
  const n = runs.length;
  const meteringShare = n > 0 ? metered / n : 0;
  if (n >= 4 && meteringShare < 0.5) {
    exceptions.push(exception(ctx, "E7", { kind: "agent", id: scope.agentId }, ctx.tl.asOf, runs.slice(0, 5).map((x) => x.r.eventId), `metering absent on ${Math.round((1 - meteringShare) * 100)}% of ${n} runs`, scope.agentId, "metering"));
  }
  return {
    metric: build({
      ctx,
      key: "P8",
      unit: "cents per O1-satisfied item",
      n,
      value: o1SatisfiedForAgent != null && o1SatisfiedForAgent > 0 && metered > 0 ? round(totalCents / o1SatisfiedForAgent, 1) : null,
      t,
      displayOnly: true,
      headline: n === 0 ? "no runs" : `${metered} of ${words(n, "run")} metered (${Math.round(meteringShare * 100)}%); ${totalCents}¢ in all; ${anomalies} anomalies`,
      detail: { runs: n, metered, totalCents, medianRunCents: med, anomalies, selfReportedTokens, costPerSatisfiedItem: o1SatisfiedForAgent != null && o1SatisfiedForAgent > 0 && metered > 0 ? round(totalCents / o1SatisfiedForAgent, 1) : null },
      notes: ["shown, never scored; agent_runs is derived from cost_events and is not a second source"],
    }),
    exceptions,
  };
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Rule 18 successor links: cancelled item → new item within 14 days sharing lineage, parent or a fuzzy title. */
export function successorLinks(ctx: ScoringContext): Map<string, string> {
  const links = new Map<string, string>();
  const all = [...ctx.tl.items.values()];
  for (const it of ctx.members) {
    const term = terminalAt(it);
    if (!term || term.status !== "cancelled") continue;
    const s = latestSnapshot(it);
    for (const other of all) {
      if (other.issueId === it.issueId) continue;
      const oc = createdAt(other);
      if (!oc || oc < term.time || oc.getTime() - term.time.getTime() > 14 * DAY) continue;
      const os = latestSnapshot(other);
      const lineage = !!s && !!os && ((s.checkoutRunId && s.checkoutRunId === os.checkoutRunId) || (s.executionRunId && s.executionRunId === os.executionRunId));
      const parent = !!s && !!os && !!s.parentId && s.parentId === os.parentId;
      const fuzzy = !!s && !!os && jaccard(s.titleTokens, os.titleTokens) >= 0.6;
      if (lineage || parent || fuzzy) {
        links.set(it.issueId, other.issueId);
        break;
      }
    }
  }
  return links;
}

/** P9 Duplicate and rework rate over delivered items (lower is better). */
export function p9DuplicateRework(ctx: ScoringContext, scope: ActorScope, successors: Map<string, string>): MetricOutput {
  const t = tally();
  const exceptions: ExceptionRecord[] = [];
  const delivered = scope.items.filter((it) => doneAt(it) !== null);
  const owned = scope.items;
  let duplicates = 0;
  let rework = 0;
  const fingerprints = new Map<string, string[]>();
  for (const it of ctx.members) {
    const fp = latestSnapshot(it)?.originFingerprint;
    if (fp && fp !== "default") fingerprints.set(fp, [...(fingerprints.get(fp) ?? []), it.issueId]);
  }
  for (const it of owned) {
    const term = terminalAt(it);
    const s = latestSnapshot(it);
    let dup = false;
    if (term?.status === "cancelled" && labelsAt(it, term.time).has("duplicate")) dup = true;
    const fp = s?.originFingerprint;
    if (!dup && fp && fp !== "default" && (fingerprints.get(fp)?.length ?? 0) > 1 && fingerprints.get(fp)![0] !== it.issueId) dup = true;
    const c = createdAt(it);
    if (!dup && c && s && s.titleTokens.length > 0) {
      for (const other of ctx.members) {
        if (other.issueId === it.issueId) continue;
        const oc = createdAt(other);
        const os = latestSnapshot(other);
        if (!oc || !os || Math.abs(oc.getTime() - c.getTime()) > 15 * 60 * 1000 || oc > c) continue;
        if (os.titleTokens.length > 0 && os.titleTokens.join(" ") === s.titleTokens.join(" ") && !TERMINAL_STATUSES.has(statusAt(other, c) ?? "")) {
          dup = true;
          break;
        }
      }
    }
    if (dup) {
      duplicates++;
      t.failed.push(it.issueId);
      for (const id of it.eventIds.slice(0, 2)) t.refs.add(id);
      exceptions.push(exception(ctx, "E6", subjectIssue(it), term?.time ?? c ?? ctx.tl.asOf, it.eventIds.slice(0, 5), "duplicate by label, origin fingerprint or title within 15 minutes", scope.agentId));
    }
    let reworkHere = 0;
    const d = doneAt(it);
    if (d) reworkHere += it.transitions.filter((tr) => tr.time > d && tr.from === "done" && !TERMINAL_STATUSES.has(tr.to)).length;
    reworkHere += it.verdicts.filter((v) => v.outcome === "revision_requested").length;
    reworkHere += it.handoffs.filter((h) => (num(h.payload, "fix_attempt") ?? 0) > 1).length;
    if (successors.has(it.issueId)) reworkHere += 1;
    if (reworkHere > 0) {
      rework += reworkHere;
      if (!dup) t.failed.push(it.issueId);
      for (const id of it.eventIds.slice(0, 2)) t.refs.add(id);
    } else if (!dup && d) t.satisfied.push(it.issueId);
    t.tiers.add("T0");
    if (it.handoffs.length > 0) t.tiers.add("T2");
  }
  const n = delivered.length;
  return {
    metric: build({
      ctx,
      key: "P9",
      unit: "duplicates and rework per delivered item",
      n,
      value: n > 0 ? round((duplicates + rework) / n) : null,
      t,
      lowerIsBetter: true,
      coverage: n > 0 ? 1 : 0,
      headline: n === 0 ? "no delivered items" : `${words(duplicates, "duplicate")} and ${words(rework, "rework event")} across ${words(n, "delivered item")}`,
      detail: { duplicates, rework, successorLinks: [...successors.entries()].filter(([from]) => owned.some((o) => o.issueId === from)).map(([from, to]) => ({ cancelled: from, successor: to })) },
    }),
    exceptions,
  };
}

/** Company row: what is owed by the platform or the humans, not by an agent. */
export function companyRow(ctx: ScoringContext): { unansweredQuestions: MetricResult; platformFailures: MetricResult; exceptions: ExceptionRecord[] } {
  const t = tally();
  const ages: number[] = [];
  for (const it of ctx.members) {
    for (const i of it.interactions) {
      if (i.kind !== "ask_user_questions" || i.status !== "pending" || !i.createdAt) continue;
      const age = ctx.tl.asOf.getTime() - i.createdAt.getTime();
      t.refs.add(i.eventId);
      t.tiers.add("T0");
      if (age > 48 * HOUR) {
        t.failed.push(i.eventId);
        ages.push(age);
      } else t.satisfied.push(i.eventId);
    }
  }
  const n = t.satisfied.length + t.failed.length;
  const unanswered = build({
    ctx,
    key: "P2",
    unit: "questions unanswered past 48 h",
    n,
    value: t.failed.length,
    t,
    displayOnly: true,
    coverage: n > 0 ? 1 : 0,
    headline: n === 0 ? "no pending questions" : `${words(t.failed.length, "question")} unanswered past 48 h (median age ${median(ages) != null ? round(median(ages)! / HOUR, 1) : "—"} h) of ${n} pending`,
    detail: { pending: n, past48h: t.failed.length, medianAgeHours: median(ages) != null ? round(median(ages)! / HOUR, 1) : null },
    notes: ["charged to the company, not the asking agent"],
  });
  const t2 = tally();
  let hangs = 0;
  let exhausted = 0;
  for (const it of ctx.members) {
    for (const r of it.runs) {
      if (r.status === "timed_out" && (r.durationMs ?? 0) > 30 * 60 * 1000) {
        hangs++;
        t2.failed.push(r.eventId);
        t2.refs.add(r.eventId);
      }
    }
    for (const x of it.recoveryExhausted) {
      exhausted++;
      t2.failed.push(x.eventId);
      t2.refs.add(x.eventId);
    }
  }
  t2.tiers.add("T0");
  const platform = build({
    ctx,
    key: "P5",
    unit: "platform failures",
    n: t2.failed.length,
    value: t2.failed.length,
    t: t2,
    displayOnly: true,
    coverage: 1,
    headline: `${words(hangs, "zero-turn hang")}, ${words(exhausted, "recovery budget exhausted", "recovery budgets exhausted")}`,
    detail: { zeroTurnHangs: hangs, recoveryBudgetExhausted: exhausted },
  });
  return { unansweredQuestions: unanswered, platformFailures: platform, exceptions: [] };
}

export function contractOf(ctx: ScoringContext): EvaluationContractV1 {
  return ctx.resolved.contract;
}

export function keyOf(actorType: string, actorId: string | null): string {
  return actorKey(actorType, actorId);
}
