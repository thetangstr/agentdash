import { EVALUATION_REVIEW_LABEL, type EvaluationHandoffType, type EvaluationMilestoneRef } from "@paperclipai/shared";
import type { EvaluationEventRow } from "../ledger.js";

/**
 * AgentDash: Company Evaluator — the per-item timeline a replay window folds
 * into (spec §3 membership, §5 populations). Pure: the same ordered window
 * always yields the same timeline. Nothing here reads a live table; roster
 * facts arrive as `agent.snapshot` / `project.snapshot` / `goal.snapshot`
 * events (Milestone 2), so a card is a function of the ledger alone.
 *
 * Evaluator output (`evaluation.*`) and contracts never enter item timelines
 * (rules 9 and 12); contracts are read separately.
 */

export const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

export type Payload = Record<string, unknown>;

export function str(p: Payload, key: string): string | null {
  const v = p[key];
  return typeof v === "string" ? v : null;
}
export function num(p: Payload, key: string): number | null {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
export function bool(p: Payload, key: string): boolean {
  return p[key] === true;
}
export function date(p: Payload, key: string): Date | null {
  const v = p[key];
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function strList(p: Payload, key: string): string[] {
  const v = p[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
export function obj(p: Payload, key: string): Payload | null {
  const v = p[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : null;
}

export function actorKey(actorType: string, actorId: string | null): string {
  return `${actorType}:${actorId ?? ""}`;
}

export interface Ref {
  time: Date;
  eventId: string;
  actorType: string;
  actorId: string | null;
}

export interface Snapshot extends Ref {
  status: string;
  priority: string | null;
  projectId: string | null;
  inheritedProjectId: string | null;
  goalId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  labels: string[];
  titleTokens: string[];
  dodCriteria: number | null;
  dodCriteriaIds: string[] | null;
  dodCriteriaHashes: string[] | null;
  originFingerprint: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  createdAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  contentHash: string | null;
}

export interface Transition extends Ref {
  from: string | null;
  to: string;
  reopened: boolean;
  source: string | null;
}

export interface Assignment extends Ref {
  fromAgentId: string | null;
  toAgentId: string | null;
  fromUserId: string | null;
  toUserId: string | null;
  previousUnknown: boolean;
}

export interface BlockerChange extends Ref {
  blockedByIssueIds: string[];
  previous: string[] | null;
}

export interface DodChange extends Ref {
  criteriaCount: number | null;
  previousCriteriaCount: number | null;
  criteriaIds: string[] | null;
  criteriaHashes: string[] | null;
  previousCriteriaIds: string[] | null;
  previousCriteriaHashes: string[] | null;
  hasPrevious: boolean;
}

export interface Handoff extends Ref {
  type: EvaluationHandoffType;
  commentId: string | null;
  selfReported: boolean;
  timestampSuspicious: boolean;
  timestampClamped: boolean;
  claimedTimestamp: string | null;
  droppedKeys: string[];
  payload: Payload;
}

export interface Verdict extends Ref {
  verdictId: string | null;
  entityType: string | null;
  outcome: string | null;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  rubricScores: Payload | null;
}

export interface ApprovalEvent extends Ref {
  approvalId: string | null;
  type: string | null;
  kind: "created" | "decided";
  decision: string | null;
}

export interface Run extends Ref {
  runId: string | null;
  agentId: string | null;
  status: string | null;
  durationMs: number | null;
  retryOfRunId: string | null;
  startedAt: Date | null;
  usagePresent: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
  invocationSource: string | null;
}

export interface Cost extends Ref {
  runId: string | null;
  agentId: string | null;
  costCents: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface Interaction extends Ref {
  interactionId: string | null;
  kind: string | null;
  status: string | null;
  createdAt: Date | null;
  pendingMs: number | null;
  createdByAgentId: string | null;
}

export interface ItemTimeline {
  issueId: string;
  identifier: string | null;
  snapshots: Snapshot[];
  created: Ref | null;
  transitions: Transition[];
  assignments: Assignment[];
  blockers: BlockerChange[];
  comments: Array<Ref & { commentId: string | null; reopened: boolean }>;
  dods: DodChange[];
  handoffs: Handoff[];
  withdrawn: Array<Ref & { commentId: string | null }>;
  verdicts: Verdict[];
  approvals: ApprovalEvent[];
  runs: Run[];
  costs: Cost[];
  interactions: Interaction[];
  labelAdds: Array<Ref & { label: string }>;
  recoveryExhausted: Ref[];
  otherActivity: Array<Ref & { action: string | null }>;
  /** Every event id on the item, for drill-down. */
  eventIds: string[];
  /** Last event time on the item (activity of any kind). */
  lastActivity: Date | null;
}

export interface AgentFacts {
  agentId: string;
  name: string | null;
  role: string | null;
  status: string | null;
  reportsTo: string | null;
  accountableUserId: string | null;
  autonomy: string | null;
  asOf: Date;
}

export interface ProjectSnapshot extends Ref {
  status: string | null;
  name: string | null;
  goalId: string | null;
  leadAgentId: string | null;
  targetDate: string | null;
  dodCriteria: number | null;
  archivedAt: Date | null;
  createdAt: Date | null;
}

export interface GoalSnapshot extends Ref {
  status: string | null;
  title: string | null;
  level: string | null;
  parentId: string | null;
  ownerAgentId: string | null;
  hasMetricDefinition: boolean;
  metricDefinition: Payload | null;
}

export interface SourcePresence {
  verdicts: boolean;
  approvalsDecided: boolean;
  regressionGates: boolean;
  deliveryRefs: boolean;
  dod: boolean;
  costEvents: boolean;
  runs: boolean;
  interactions: boolean;
  handoffs: boolean;
  authzRefused: boolean;
  rosterAgents: boolean;
  rosterProjects: boolean;
  rosterGoals: boolean;
}

export interface Timeline {
  items: Map<string, ItemTimeline>;
  agents: Map<string, AgentFacts>;
  projects: Map<string, ProjectSnapshot[]>;
  goals: Map<string, GoalSnapshot[]>;
  /** Contract declarations in the window, oldest first. */
  contracts: EvaluationEventRow[];
  /** Human attestations and other evaluator-side dispositions (read, never scored). */
  dispositions: EvaluationEventRow[];
  authzRefused: Array<Ref & { payload: Payload; issueId: string | null }>;
  sources: SourcePresence;
  /** The deterministic "now": the latest event or ingest time the window knows about. */
  asOf: Date;
  /** Rule 13: the blind window — maximum ingest lag observed. */
  maxIngestLagMs: number;
  eventCount: number;
  /** Actor keys of every human actor seen; all-synthetic means the deployment-mode caveat (§7). */
  humanActors: Set<string>;
}

function ref(e: EvaluationEventRow): Ref {
  return { time: e.eventTime, eventId: e.id, actorType: e.actorType, actorId: e.actorId };
}

function item(tl: Timeline, issueId: string, identifier: string | null): ItemTimeline {
  let it = tl.items.get(issueId);
  if (!it) {
    it = {
      issueId,
      identifier,
      snapshots: [],
      created: null,
      transitions: [],
      assignments: [],
      blockers: [],
      comments: [],
      dods: [],
      handoffs: [],
      withdrawn: [],
      verdicts: [],
      approvals: [],
      runs: [],
      costs: [],
      interactions: [],
      labelAdds: [],
      recoveryExhausted: [],
      otherActivity: [],
      eventIds: [],
      lastActivity: null,
    };
    tl.items.set(issueId, it);
  } else if (!it.identifier && identifier) {
    it.identifier = identifier;
  }
  return it;
}

function touch(it: ItemTimeline, e: EvaluationEventRow) {
  it.eventIds.push(e.id);
  if (!it.lastActivity || e.eventTime > it.lastActivity) it.lastActivity = e.eventTime;
}

/** Fold an ordered window into timelines. The window must already be in replay order (`orderEvents`). */
export function buildTimeline(window: EvaluationEventRow[]): Timeline {
  const tl: Timeline = {
    items: new Map(),
    agents: new Map(),
    projects: new Map(),
    goals: new Map(),
    contracts: [],
    dispositions: [],
    authzRefused: [],
    sources: {
      verdicts: false,
      approvalsDecided: false,
      regressionGates: false,
      deliveryRefs: false,
      dod: false,
      costEvents: false,
      runs: false,
      interactions: false,
      handoffs: false,
      authzRefused: false,
      rosterAgents: false,
      rosterProjects: false,
      rosterGoals: false,
    },
    asOf: new Date(0),
    maxIngestLagMs: 0,
    eventCount: window.length,
    humanActors: new Set(),
  };
  for (const e of window) {
    const p = (e.payload ?? {}) as Payload;
    const t = e.eventTime;
    if (t > tl.asOf) tl.asOf = t;
    if (e.ingestTime > tl.asOf) tl.asOf = e.ingestTime;
    const lag = e.ingestTime.getTime() - t.getTime();
    if (lag > tl.maxIngestLagMs) tl.maxIngestLagMs = lag;
    if (e.actorType === "user" && e.actorId) tl.humanActors.add(e.actorId);
    const issueId = str(p, "issueId");
    const identifier = str(p, "identifier");
    switch (e.eventType) {
      case "contract.declared":
        tl.contracts.push(e);
        continue;
      case "evaluation.finding":
      case "evaluation.correction":
      case "evaluation.disposition":
        tl.dispositions.push(e);
        continue;
      case "agent.snapshot": {
        const id = str(p, "agentId") ?? e.sourceId;
        tl.sources.rosterAgents = true;
        tl.agents.set(id, {
          agentId: id,
          name: str(p, "name"),
          role: str(p, "role"),
          status: str(p, "status"),
          reportsTo: str(p, "reportsTo"),
          accountableUserId: str(p, "accountableUserId"),
          autonomy: str(p, "autonomy"),
          asOf: t,
        });
        continue;
      }
      case "project.snapshot": {
        const id = str(p, "projectId") ?? e.sourceId;
        tl.sources.rosterProjects = true;
        const list = tl.projects.get(id) ?? [];
        list.push({
          ...ref(e),
          status: str(p, "status"),
          name: str(p, "name"),
          goalId: str(p, "goalId"),
          leadAgentId: str(p, "leadAgentId"),
          targetDate: str(p, "targetDate"),
          dodCriteria: num(p, "dodCriteria"),
          archivedAt: date(p, "archivedAt"),
          createdAt: date(p, "createdAt"),
        });
        tl.projects.set(id, list);
        continue;
      }
      case "goal.snapshot": {
        const id = str(p, "goalId") ?? e.sourceId;
        tl.sources.rosterGoals = true;
        const list = tl.goals.get(id) ?? [];
        const md = obj(p, "metricDefinition");
        list.push({
          ...ref(e),
          status: str(p, "status"),
          title: str(p, "title"),
          level: str(p, "level"),
          parentId: str(p, "parentId"),
          ownerAgentId: str(p, "ownerAgentId"),
          hasMetricDefinition: !!md,
          metricDefinition: md,
        });
        tl.goals.set(id, list);
        continue;
      }
      case "authz.refused":
        tl.sources.authzRefused = true;
        tl.authzRefused.push({ ...ref(e), payload: p, issueId });
        if (issueId) touch(item(tl, issueId, identifier), e);
        continue;
      case "agent.lifecycle":
        continue;
      default:
        break;
    }
    if (!issueId) continue;
    const it = item(tl, issueId, identifier);
    touch(it, e);
    switch (e.eventType) {
      case "issue.created":
        it.created = ref(e);
        break;
      case "issue.transition":
        it.transitions.push({ ...ref(e), from: str(p, "from"), to: str(p, "to") ?? "", reopened: bool(p, "reopened"), source: str(p, "source") });
        break;
      case "issue.assignment_changed":
        it.assignments.push({
          ...ref(e),
          fromAgentId: str(p, "fromAgentId"),
          toAgentId: str(p, "toAgentId"),
          fromUserId: str(p, "fromUserId"),
          toUserId: str(p, "toUserId"),
          previousUnknown: bool(p, "previousUnknown"),
        });
        break;
      case "issue.blockers_updated":
        it.blockers.push({ ...ref(e), blockedByIssueIds: strList(p, "blockedByIssueIds"), previous: Array.isArray(p.previous) ? strList(p, "previous") : null });
        break;
      case "issue.comment_added":
        it.comments.push({ ...ref(e), commentId: str(p, "commentId"), reopened: bool(p, "reopened") });
        break;
      case "issue.dod_set":
        tl.sources.dod = true;
        it.dods.push({
          ...ref(e),
          criteriaCount: num(p, "criteriaCount"),
          previousCriteriaCount: num(p, "previousCriteriaCount"),
          criteriaIds: Array.isArray(p.criteriaIds) ? strList(p, "criteriaIds") : null,
          criteriaHashes: Array.isArray(p.criteriaHashes) ? strList(p, "criteriaHashes") : null,
          previousCriteriaIds: Array.isArray(p.previousCriteriaIds) ? strList(p, "previousCriteriaIds") : null,
          previousCriteriaHashes: Array.isArray(p.previousCriteriaHashes) ? strList(p, "previousCriteriaHashes") : null,
          hasPrevious: bool(p, "hasPrevious"),
        });
        break;
      case "issue.recovery_budget_exhausted":
        it.recoveryExhausted.push(ref(e));
        break;
      case "issue.snapshot": {
        const dodCriteria = num(p, "dodCriteria");
        if (dodCriteria != null && dodCriteria > 0) tl.sources.dod = true;
        it.snapshots.push({
          ...ref(e),
          status: str(p, "status") ?? "",
          priority: str(p, "priority"),
          projectId: str(p, "projectId"),
          inheritedProjectId: str(p, "inheritedProjectId"),
          goalId: str(p, "goalId"),
          parentId: str(p, "parentId"),
          assigneeAgentId: str(p, "assigneeAgentId"),
          assigneeUserId: str(p, "assigneeUserId"),
          createdByAgentId: str(p, "createdByAgentId"),
          createdByUserId: str(p, "createdByUserId"),
          labels: strList(p, "labels"),
          titleTokens: strList(p, "titleTokens"),
          dodCriteria,
          dodCriteriaIds: Array.isArray(p.dodCriteriaIds) ? strList(p, "dodCriteriaIds") : null,
          dodCriteriaHashes: Array.isArray(p.dodCriteriaHashes) ? strList(p, "dodCriteriaHashes") : null,
          originFingerprint: str(p, "originFingerprint"),
          checkoutRunId: str(p, "checkoutRunId"),
          executionRunId: str(p, "executionRunId"),
          createdAt: date(p, "createdAt"),
          startedAt: date(p, "startedAt"),
          completedAt: date(p, "completedAt"),
          cancelledAt: date(p, "cancelledAt"),
          contentHash: str(p, "contentHash"),
        });
        break;
      }
      case "issue.label_added":
        it.labelAdds.push({ ...ref(e), label: str(p, "label") ?? "" });
        break;
      case "run.finished":
        tl.sources.runs = true;
        it.runs.push({
          ...ref(e),
          runId: str(p, "runId"),
          agentId: str(p, "agentId"),
          status: str(p, "status"),
          durationMs: num(p, "durationMs"),
          retryOfRunId: str(p, "retryOfRunId"),
          startedAt: date(p, "startedAt"),
          usagePresent: bool(p, "usagePresent"),
          inputTokens: num(p, "inputTokens"),
          outputTokens: num(p, "outputTokens"),
          errorCode: str(p, "errorCode"),
          invocationSource: str(p, "invocationSource"),
        });
        break;
      case "verdict.recorded":
        tl.sources.verdicts = true;
        it.verdicts.push({
          ...ref(e),
          verdictId: str(p, "verdictId"),
          entityType: str(p, "entityType"),
          outcome: str(p, "outcome"),
          reviewerAgentId: str(p, "reviewerAgentId"),
          reviewerUserId: str(p, "reviewerUserId"),
          rubricScores: obj(p, "rubricScores"),
        });
        break;
      case "approval.created":
        it.approvals.push({ ...ref(e), approvalId: str(p, "approvalId"), type: str(p, "type"), kind: "created", decision: null });
        break;
      case "approval.decided":
        tl.sources.approvalsDecided = true;
        it.approvals.push({ ...ref(e), approvalId: str(p, "approvalId"), type: str(p, "type"), kind: "decided", decision: str(p, "decision") });
        break;
      case "interaction.changed":
        tl.sources.interactions = true;
        it.interactions.push({
          ...ref(e),
          interactionId: str(p, "interactionId"),
          kind: str(p, "kind"),
          status: str(p, "status"),
          createdAt: date(p, "createdAt"),
          pendingMs: num(p, "pendingMs"),
          createdByAgentId: e.actorType === "agent" ? e.actorId : null,
        });
        break;
      case "cost.recorded":
        tl.sources.costEvents = true;
        it.costs.push({
          ...ref(e),
          runId: str(p, "heartbeatRunId"),
          agentId: str(p, "agentId"),
          costCents: num(p, "costCents"),
          inputTokens: num(p, "inputTokens"),
          outputTokens: num(p, "outputTokens"),
        });
        break;
      case "evidence.withdrawn":
        it.withdrawn.push({ ...ref(e), commentId: str(p, "commentId") });
        break;
      case "handoff.pm_to_builder":
      case "handoff.builder_to_ci":
      case "handoff.tester_to_reviewer":
      case "handoff.reviewer_to_tpm":
      case "handoff.tpm_merge_report": {
        tl.sources.handoffs = true;
        const kept = obj(p, "payload") ?? {};
        if (obj(kept, "regression_gates")) tl.sources.regressionGates = true;
        if (obj(kept, "pr") || str(kept, "merge_result")) tl.sources.deliveryRefs = true;
        it.handoffs.push({
          ...ref(e),
          type: e.eventType.slice("handoff.".length) as EvaluationHandoffType,
          commentId: str(p, "commentId"),
          selfReported: bool(p, "selfReported"),
          timestampSuspicious: bool(p, "timestampSuspicious"),
          timestampClamped: bool(p, "timestampClamped"),
          claimedTimestamp: str(p, "claimedTimestamp"),
          droppedKeys: strList(p, "droppedKeys"),
          payload: kept,
        });
        break;
      }
      case "activity.other":
        it.otherActivity.push({ ...ref(e), action: str(p, "action") });
        break;
      default:
        break;
    }
  }
  return tl;
}

// ---------- accessors (all deterministic over the folded timeline) ----------

export function latestSnapshot(it: ItemTimeline): Snapshot | null {
  return it.snapshots[it.snapshots.length - 1] ?? null;
}

export function snapshotAt(it: ItemTimeline, time: Date): Snapshot | null {
  let found: Snapshot | null = null;
  for (const s of it.snapshots) {
    if (s.time <= time) found = s;
    else break;
  }
  return found ?? it.snapshots[0] ?? null;
}

/** The project an item belonged to at `time` (own or inherited), from the snapshot in force then. */
export function projectAt(it: ItemTimeline, time: Date): string | null {
  const s = snapshotAt(it, time);
  return s ? (s.projectId ?? s.inheritedProjectId) : null;
}

export function statusAt(it: ItemTimeline, time: Date): string | null {
  let status: string | null = null;
  for (const t of it.transitions) {
    if (t.time <= time) status = t.to;
    else break;
  }
  if (status) return status;
  const s = snapshotAt(it, time);
  return s?.status ?? null;
}

export function currentStatus(it: ItemTimeline): string | null {
  const s = latestSnapshot(it);
  const lastT = it.transitions[it.transitions.length - 1];
  if (s && lastT) return lastT.time > s.time ? lastT.to : s.status;
  return s?.status ?? lastT?.to ?? null;
}

/** The last transition into a terminal status that was not reopened afterwards. */
export function terminalAt(it: ItemTimeline): { time: Date; status: string; eventId: string | null } | null {
  let result: { time: Date; status: string; eventId: string | null } | null = null;
  for (const t of it.transitions) {
    if (TERMINAL_STATUSES.has(t.to)) result = { time: t.time, status: t.to, eventId: t.eventId };
    else result = null;
  }
  if (result) return result;
  const s = latestSnapshot(it);
  if (s && TERMINAL_STATUSES.has(s.status)) {
    const time = s.status === "done" ? (s.completedAt ?? s.time) : (s.cancelledAt ?? s.time);
    return { time, status: s.status, eventId: null };
  }
  return null;
}

export function doneAt(it: ItemTimeline): Date | null {
  const t = terminalAt(it);
  return t && t.status === "done" ? t.time : null;
}

/** When work started: first transition into in_progress, else the snapshot's startedAt. */
export function startedAt(it: ItemTimeline): Date | null {
  const t = it.transitions.find((x) => x.to === "in_progress");
  if (t) return t.time;
  return latestSnapshot(it)?.startedAt ?? null;
}

export function createdAt(it: ItemTimeline): Date | null {
  return latestSnapshot(it)?.createdAt ?? it.created?.time ?? it.snapshots[0]?.time ?? null;
}

export function firstInReviewAt(it: ItemTimeline): Date | null {
  return it.transitions.find((x) => x.to === "in_review")?.time ?? null;
}

/** Assignee at `time`: the latest assignment change before it, else the snapshot in force. */
export function assigneeAt(it: ItemTimeline, time: Date): { agentId: string | null; userId: string | null } {
  let a: Assignment | null = null;
  for (const x of it.assignments) {
    if (x.time <= time) a = x;
    else break;
  }
  const s = snapshotAt(it, time);
  if (a && (!s || a.time >= s.time)) return { agentId: a.toAgentId, userId: a.toUserId };
  if (s) return { agentId: s.assigneeAgentId, userId: s.assigneeUserId };
  return a ? { agentId: a.toAgentId, userId: a.toUserId } : { agentId: null, userId: null };
}

export function labelsAt(it: ItemTimeline, time: Date): Set<string> {
  const out = new Set<string>(snapshotAt(it, time)?.labels ?? []);
  for (const l of it.labelAdds) if (l.time <= time && l.label) out.add(l.label);
  return out;
}

export function everLabelled(it: ItemTimeline, label: string): boolean {
  return it.snapshots.some((s) => s.labels.includes(label)) || it.labelAdds.some((l) => l.label === label);
}

/** Rule 12: the evaluator's own review items never enter a scored population. */
export function isEvaluatorOutput(it: ItemTimeline): boolean {
  return everLabelled(it, EVALUATION_REVIEW_LABEL);
}

export function projectStatusAt(tl: Timeline, projectId: string, time: Date): string | null {
  const list = tl.projects.get(projectId) ?? [];
  let status: string | null = null;
  for (const s of list) {
    if (s.time <= time) status = s.status;
    else break;
  }
  return status ?? list[0]?.status ?? null;
}

export function latestProject(tl: Timeline, projectId: string): ProjectSnapshot | null {
  const list = tl.projects.get(projectId) ?? [];
  return list[list.length - 1] ?? null;
}

export function latestGoal(tl: Timeline, goalId: string): GoalSnapshot | null {
  const list = tl.goals.get(goalId) ?? [];
  return list[list.length - 1] ?? null;
}

export interface Membership {
  members: ItemTimeline[];
  excludedEvaluatorItems: number;
  movedIn: number;
  movedOut: number;
}

/**
 * Spec §3 membership, with mid-milestone moves: an item counts in the
 * milestone it belonged to when it reached its terminal status; an open item
 * counts where it is now. Goal-as-milestone: goal set and no project.
 */
export function membership(tl: Timeline, ref: EvaluationMilestoneRef): Membership {
  const members: ItemTimeline[] = [];
  let excluded = 0;
  let movedIn = 0;
  let movedOut = 0;
  const ids = [...tl.items.keys()].sort();
  for (const id of ids) {
    const it = tl.items.get(id)!;
    const terminal = terminalAt(it);
    const at = terminal?.time ?? tl.asOf;
    let memberNow: boolean;
    if (ref.kind === "project") {
      memberNow = projectAt(it, at) === ref.id;
      const everMember = it.snapshots.some((s) => (s.projectId ?? s.inheritedProjectId) === ref.id);
      if (!memberNow && everMember) movedOut++;
      if (memberNow && it.snapshots.length > 0 && (it.snapshots[0]!.projectId ?? it.snapshots[0]!.inheritedProjectId) !== ref.id) movedIn++;
    } else {
      const s = snapshotAt(it, at);
      memberNow = !!s && s.goalId === ref.id && !s.projectId && !s.inheritedProjectId;
    }
    if (!memberNow) continue;
    if (isEvaluatorOutput(it)) {
      excluded++;
      continue;
    }
    members.push(it);
  }
  return { members, excludedEvaluatorItems: excluded, movedIn, movedOut };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
}

export function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
