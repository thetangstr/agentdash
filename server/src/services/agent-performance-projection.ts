import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentCorrections,
  agents,
  approvals,
  costEvents,
  evaluationEvents,
  evaluationScorecards,
  goals,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  projects,
  routineRuns,
  verdicts,
} from "@paperclipai/db";
import type {
  AgentPerformanceProjection,
  AgentProjectionAccountableResult,
  AgentProjectionCount,
  AgentProjectionRoutineObligation,
} from "@paperclipai/shared";
import { parseCron } from "./cron.js";
import { isSyntheticUser } from "./evaluation/scoring/independence.js";
import { loadAssignedRoutines, type AssignedRoutineRow } from "./agent-profile-derived.js";
import { UNRESTRICTED_PROJECT_SCOPE, type ViewerProjectScope } from "./agent-performance-authz.js";

/**
 * AgentDash: Agent Performance Management gate 1 — the side-effect-free
 * performance projection (evaluation LLD §6.2, §11).
 *
 * Answers the six questions of overview LLD §1 from live tables at request
 * time. It stores nothing, appends no evaluator finding, creates no review
 * item and writes no activity row: the loader only selects, and
 * `buildAgentPerformanceProjection` is pure. Unknown is null with a note,
 * never 0, and there is no composite score.
 *
 * Gate 1 limits, stated in the output rather than hidden:
 * - owed work is computed from the CURRENT routine definitions (history unknown);
 * - verdicts and routines are attributed to the agent CURRENTLY assigned.
 */

export const PROJECTION_WINDOW_DAYS_DEFAULT = 30;
export const PROJECTION_WINDOW_DAYS_MAX = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Interaction kinds that put a question to a person and wait for them. */
export const QUESTION_INTERACTION_KINDS = ["ask_user_questions", "request_confirmation"] as const;
/** Terminal interaction states that mean a person responded. */
const ANSWERED_INTERACTION_STATUSES = new Set(["answered", "accepted", "rejected"]);
/**
 * Activity actions that record a refused attempt by the agent. `authz.refused`
 * is grouped by its `reasonCode`; a connector send refused at execution keeps
 * its action name. Host refusals (`agent.ssh_run_refused`) are platform
 * configuration, not the agent's attempt, and are not counted.
 */
export const REFUSAL_ACTIONS = ["authz.refused", "connector_send.refused"] as const;
/** Corrections recorded by the paired-harness slice; not a person's correction. */
const HARNESS_CORRECTION_KIND = "harness_evaluation";

/** Added whenever the restricted-project rule can hide work from this viewer. Never carries a count. */
export const PROJECTS_WITHHELD_ENTRY = {
  section: "work in projects you can't see",
  reason: "Issues, verdicts, runs, spend and questions in restricted projects you can't read are left out of every count",
} as const;

export interface AgentRefusalCount {
  action: string;
  reasonCode: string | null;
  n: number;
}

/**
 * Refused attempts grouped by code — the one rule shared by the projection's
 * Q5 and the access inventory's `refusalsByCode`. `authz.refused` is keyed by
 * its `reasonCode`; any other refusal action by its action name.
 */
export function tallyRefusals(rows: AgentRefusalCount[]): { refusedAttempts: number; byCode: Record<string, number> } {
  const byCode: Record<string, number> = {};
  let refusedAttempts = 0;
  for (const row of rows) {
    const code = row.action === "authz.refused" ? row.reasonCode ?? "UNSPECIFIED" : row.action;
    byCode[code] = (byCode[code] ?? 0) + row.n;
    refusedAttempts += row.n;
  }
  return { refusedAttempts, byCode };
}

/** The agent's refused attempts in the window (`REFUSAL_ACTIONS`), grouped for `tallyRefusals`. Selects only. */
export async function loadAgentRefusalCounts(
  db: Db,
  companyId: string,
  agentId: string,
  window: { from: Date; to: Date },
): Promise<AgentRefusalCount[]> {
  return db
    .select({
      action: activityLog.action,
      reasonCode: sql<string | null>`${activityLog.details} ->> 'reasonCode'`,
      n: sql<number>`count(*)::int`,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        inArray(activityLog.action, [...REFUSAL_ACTIONS]),
        or(
          // An agent's own refusal is charged to its company with it as the actor (activity-log.ts logAuthzRefusal).
          and(eq(activityLog.action, "authz.refused"), eq(activityLog.actorType, "agent"), eq(activityLog.actorId, agentId)),
          // A connector send the agent requested, refused at execution (connector-send-execution.ts).
          and(eq(activityLog.action, "connector_send.refused"), eq(activityLog.agentId, agentId)),
        ),
        gte(activityLog.createdAt, window.from),
        lte(activityLog.createdAt, window.to),
      ),
    )
    .groupBy(activityLog.action, sql`2`);
}

// ---------------------------------------------------------------------------
// Owed fire times (the routines scheduler's semantics, counted efficiently)
// ---------------------------------------------------------------------------

/** The same Intl options the routines scheduler uses (`routines.ts` getZonedMinuteParts). */
function zonedFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function zonedParts(formatter: Intl.DateTimeFormat, at: number): ZonedParts {
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(at))) map[part.type] = part.value;
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) throw new Error(`Unable to resolve weekday for ${formatter.resolvedOptions().timeZone}`);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday,
  };
}

/**
 * How many times a schedule trigger fires in `[from, to]` under its CURRENT
 * cron expression and timezone.
 *
 * Same semantics as the routines scheduler (`nextCronTickInTimeZone`): every
 * whole UTC minute whose wall-clock time in `timeZone` matches all five cron
 * fields fires once, so a skipped spring-forward minute never fires and a
 * repeated fall-back minute fires twice. The scheduler checks one minute at a
 * time with a fresh formatter, which is too slow for a 365-day window; this
 * resolves the zone once per 15-minute UTC block (every zone offset in use is a
 * multiple of 15 minutes) and drops to per-minute checks for any block whose
 * offset changes inside it. Throws on an invalid expression or timezone.
 */
export function countCronFiresInWindow(expression: string, timeZone: string, from: Date, to: Date): number {
  const cron = parseCron(expression.trim());
  const formatter = zonedFormatter(timeZone);
  const minutes = new Set(cron.minutes);
  const hours = new Set(cron.hours);
  const days = new Set(cron.daysOfMonth);
  const months = new Set(cron.months);
  const weekdays = new Set(cron.daysOfWeek);
  const matches = (p: ZonedParts, minute = p.minute) =>
    minutes.has(minute) && hours.has(p.hour) && days.has(p.day) && months.has(p.month) && weekdays.has(p.weekday);

  const start = Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS;
  const end = Math.floor(to.getTime() / MINUTE_MS) * MINUTE_MS;
  if (end < start) return 0;

  const BLOCK_MS = 15 * MINUTE_MS;
  const offsetOf = (p: ZonedParts, at: number) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at;
  let blockStart = Math.floor(start / BLOCK_MS) * BLOCK_MS;
  let current = zonedParts(formatter, blockStart);
  let count = 0;
  while (blockStart <= end) {
    const nextStart = blockStart + BLOCK_MS;
    const next = zonedParts(formatter, nextStart);
    const first = Math.max(blockStart, start);
    const last = Math.min(nextStart - MINUTE_MS, end);
    const steady = current.minute % 15 === 0 && offsetOf(current, blockStart) === offsetOf(next, nextStart);
    if (steady) {
      if (hours.has(current.hour) && days.has(current.day) && months.has(current.month) && weekdays.has(current.weekday)) {
        for (let at = first; at <= last; at += MINUTE_MS) {
          if (minutes.has(current.minute + (at - blockStart) / MINUTE_MS)) count += 1;
        }
      }
    } else {
      for (let at = first; at <= last; at += MINUTE_MS) {
        if (matches(zonedParts(formatter, at))) count += 1;
      }
    }
    blockStart = nextStart;
    current = next;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ProjectionRoutineRunCount {
  routineId: string;
  triggerId: string | null;
  status: string;
  n: number;
}

export interface ProjectionRoutineLinkedIssue {
  routineId: string;
  triggerId: string | null;
  issueId: string;
  issueStatus: string | null;
}

export interface ProjectionVerdictCount {
  outcome: string;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  n: number;
}

export interface ProjectionAccountableInput {
  kind: "project" | "goal";
  id: string;
  title: string;
  status: string | null;
  /** The latest stored evaluator card for this milestone, if any. */
  card: { version: number; throughSeq: number; card: unknown } | null;
}

export interface ProjectionQuestionRow {
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
}

export interface AgentPerformanceProjectionInput {
  companyId: string;
  agentId: string;
  /** Request time; also `generatedAt`. */
  asOf: Date;
  windowDays: number;
  throughSeq: number | null;
  routines: AssignedRoutineRow[];
  routineRunCounts: ProjectionRoutineRunCount[];
  routineLinkedIssues: ProjectionRoutineLinkedIssue[];
  /** Issues currently assigned to the agent, by status. */
  assignedIssueStatusCounts: Record<string, number>;
  /** Verdicts in the window on issues currently assigned to the agent. */
  verdictCounts: ProjectionVerdictCount[];
  accountable: ProjectionAccountableInput[];
  spendCents: number;
  heartbeatRunCounts: Array<{ status: string; hasIssue: boolean; n: number }>;
  /** Questions this agent put to people in the window. */
  questions: ProjectionQuestionRow[];
  openQuestionsToPeople: number;
  correctionCounts: Array<{ kind: string; sourceActorType: string; n: number }>;
  refusalCounts: AgentRefusalCount[];
  pendingApprovals: number;
  /** True when the viewer's restricted-project rule was applied to the rows above. */
  projectsWithheld: boolean;
}

export function projectionWindow(asOf: Date, windowDays: number): { from: Date; to: Date } {
  return { from: new Date(asOf.getTime() - windowDays * DAY_MS), to: new Date(asOf.getTime()) };
}

// ---------------------------------------------------------------------------
// Builder (pure)
// ---------------------------------------------------------------------------

type Gap = AgentPerformanceProjection["gaps"][number];

function routineLabel(routine: { title: string }) {
  return `Routine "${routine.title}"`;
}

/**
 * Owed fire times for one trigger, or null with the reason. Counting starts no
 * earlier than the trigger's creation: a trigger owed nothing before it existed.
 */
function owedForTrigger(
  routine: AssignedRoutineRow,
  trigger: AssignedRoutineRow["triggers"][number],
  window: { from: Date; to: Date },
): { owed: number | null; note: string | null } {
  if (routine.status !== "active") {
    return { owed: null, note: `${routineLabel(routine)} is ${routine.status}; whether it was active earlier in the window isn't recorded.` };
  }
  if (trigger.kind !== "schedule") {
    return { owed: null, note: `${routineLabel(routine)} has a ${trigger.kind} trigger, which owes work only when it is called; see its runs.` };
  }
  if (!trigger.enabled) {
    return { owed: null, note: `${routineLabel(routine)} has a disabled schedule trigger; whether it was enabled earlier in the window isn't recorded.` };
  }
  if (!trigger.cronExpression || !trigger.timezone) {
    return { owed: null, note: `${routineLabel(routine)} has a schedule trigger with no cron expression or timezone.` };
  }
  const createdInside = trigger.createdAt.getTime() > window.from.getTime();
  const from = createdInside ? trigger.createdAt : window.from;
  try {
    return {
      owed: countCronFiresInWindow(trigger.cronExpression, trigger.timezone, from, window.to),
      note: createdInside ? `Trigger created inside the window; counted from ${trigger.createdAt.toISOString()}.` : null,
    };
  } catch {
    return { owed: null, note: `${routineLabel(routine)} has a schedule trigger whose cron expression or timezone can't be read.` };
  }
}

function emptyRuns(): AgentProjectionRoutineObligation["runs"] {
  return { total: 0, issueCreated: 0, completed: 0, failed: 0, skipped: 0, coalesced: 0 };
}

function tallyRuns(rows: ProjectionRoutineRunCount[]): AgentProjectionRoutineObligation["runs"] {
  const runs = emptyRuns();
  for (const row of rows) {
    runs.total += row.n;
    if (row.status === "issue_created") runs.issueCreated += row.n;
    else if (row.status === "completed") runs.completed += row.n;
    else if (row.status === "failed") runs.failed += row.n;
    else if (row.status === "skipped") runs.skipped += row.n;
    else if (row.status === "coalesced") runs.coalesced += row.n;
    // `received` counts only toward the total.
  }
  return runs;
}

function tallyLinkedIssues(rows: ProjectionRoutineLinkedIssue[]): AgentProjectionRoutineObligation["linkedIssues"] {
  const byIssue = new Map<string, string | null>();
  for (const row of rows) byIssue.set(row.issueId, row.issueStatus);
  const linked = { done: 0, open: 0, cancelled: 0 };
  for (const status of byIssue.values()) {
    if (status === "done") linked.done += 1;
    else if (status === "cancelled") linked.cancelled += 1;
    else linked.open += 1;
  }
  return linked;
}

function buildObligations(input: AgentPerformanceProjectionInput, window: { from: Date; to: Date }) {
  const out: AgentProjectionRoutineObligation[] = [];
  const runsFor = (routineId: string, triggerId: string | null) =>
    input.routineRunCounts.filter((row) => row.routineId === routineId && row.triggerId === triggerId);
  const linkedFor = (routineId: string, triggerId: string | null) =>
    input.routineLinkedIssues.filter((row) => row.routineId === routineId && row.triggerId === triggerId);

  for (const routine of input.routines) {
    const triggerIds = new Set(routine.triggers.map((trigger) => trigger.id));
    for (const trigger of routine.triggers) {
      const { owed, note } = owedForTrigger(routine, trigger, window);
      out.push({
        routineId: routine.id,
        title: routine.title,
        triggerId: trigger.id,
        triggerKind: trigger.kind,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        enabled: trigger.enabled,
        owedInWindow: owed,
        note,
        runs: tallyRuns(runsFor(routine.id, trigger.id)),
        linkedIssues: tallyLinkedIssues(linkedFor(routine.id, trigger.id)),
      });
    }
    // Runs with no current trigger (manual runs, or a trigger since deleted —
    // `trigger_id` is set null on delete), and routines with no trigger at
    // all, get one row with no trigger. Nothing is owed by a schedule there.
    const unmatched = (row: { routineId: string; triggerId: string | null }) =>
      row.routineId === routine.id && (row.triggerId === null || !triggerIds.has(row.triggerId));
    const looseRuns = input.routineRunCounts.filter(unmatched);
    if (routine.triggers.length === 0 || looseRuns.length > 0) {
      out.push({
        routineId: routine.id,
        title: routine.title,
        triggerId: null,
        triggerKind: null,
        cronExpression: null,
        timezone: null,
        // No trigger exists to be enabled.
        enabled: false,
        owedInWindow: null,
        note:
          routine.triggers.length === 0
            ? `${routineLabel(routine)} has no trigger, so nothing is owed on a schedule; see its runs.`
            : `${routineLabel(routine)} has runs in the window with no current trigger (manual runs or a deleted trigger); nothing is counted as owed for them.`,
        runs: tallyRuns(looseRuns),
        linkedIssues: tallyLinkedIssues(input.routineLinkedIssues.filter(unmatched)),
      });
    }
  }
  return out;
}

function count(value: number | null, of?: number | null, note?: string | null): AgentProjectionCount {
  const out: AgentProjectionCount = { value };
  if (of !== undefined) out.of = of;
  if (note) out.note = note;
  return out;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Cite one stored metric (`MetricResult`) as a value with its headline; never re-derive it. */
function citeMetric(card: Record<string, unknown>, key: "O1" | "O2" | "O3" | "O5"): AgentProjectionCount {
  const metric = record(record(card.outcome)?.[key]);
  if (!metric) return count(null, null, `${key} is not on this card`);
  const value = typeof metric.value === "number" && Number.isFinite(metric.value) ? metric.value : null;
  const name = typeof metric.name === "string" ? metric.name : key;
  const unit = typeof metric.unit === "string" ? metric.unit : null;
  const headline = typeof metric.headline === "string" ? metric.headline : null;
  const confidence = typeof metric.confidenceLabel === "string" ? metric.confidenceLabel : null;
  const parts = [`${key} ${name}${unit ? ` (${unit})` : ""}`, headline, value === null ? confidence : null].filter(Boolean);
  // A stored share or index is not a count, so no denominator is invented for it.
  return count(value, null, parts.join(": "));
}

function buildAccountable(rows: ProjectionAccountableInput[]): AgentProjectionAccountableResult[] {
  return rows.map((row) => {
    const card = row.card ? record(row.card.card) : null;
    if (!row.card || !card) {
      return { kind: row.kind, id: row.id, title: row.title, status: row.status, outcome: null, note: "No evaluator card" };
    }
    return {
      kind: row.kind,
      id: row.id,
      title: row.title,
      status: row.status,
      outcome: {
        acceptance: citeMetric(card, "O1"),
        onTime: citeMetric(card, "O2"),
        rework: citeMetric(card, "O3"),
        evidence: citeMetric(card, "O5"),
      },
      note: `Evaluator card version ${row.card.version} (ledger through seq ${row.card.throughSeq})`,
    };
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function buildAgentPerformanceProjection(input: AgentPerformanceProjectionInput): AgentPerformanceProjection {
  const window = projectionWindow(input.asOf, input.windowDays);
  const gaps: Gap[] = [
    {
      code: "ATTRIBUTION_CURRENT_ASSIGNEE",
      message:
        "Verdicts and routines are attributed to the agent assigned to them now; who was assigned when the work was done isn't tracked yet.",
    },
  ];

  // Q1
  const routinesOwed = buildObligations(input, window);
  const status = (key: string) => input.assignedIssueStatusCounts[key] ?? 0;
  const assigned = {
    open: status("backlog") + status("todo"),
    inProgress: status("in_progress"),
    inReview: status("in_review"),
    blocked: status("blocked"),
    done: status("done"),
    cancelled: status("cancelled"),
  };

  // Q2
  const verdictTally = { passed: 0, failed: 0, changesRequested: 0, escalated: 0, other: 0 };
  const byJudge = { person: 0, independentAgent: 0, nonIndependent: 0 };
  const passedBy = { person: 0, independentAgent: 0 };
  let syntheticVerdicts = 0;
  for (const row of input.verdictCounts) {
    if (row.outcome === "passed") verdictTally.passed += row.n;
    else if (row.outcome === "failed") verdictTally.failed += row.n;
    else if (row.outcome === "revision_requested") verdictTally.changesRequested += row.n;
    else if (row.outcome === "escalated_to_human") verdictTally.escalated += row.n;
    else verdictTally.other += row.n;

    let judge: "person" | "independentAgent" | "nonIndependent" | null;
    if (row.reviewerUserId) judge = isSyntheticUser(row.reviewerUserId) ? null : "person";
    else if (row.reviewerAgentId) judge = row.reviewerAgentId === input.agentId ? "nonIndependent" : "independentAgent";
    else judge = null;
    if (judge === null) {
      syntheticVerdicts += row.n;
      continue;
    }
    byJudge[judge] += row.n;
    if (row.outcome === "passed" && judge !== "nonIndependent") passedBy[judge] += row.n;
  }
  if (syntheticVerdicts > 0) {
    gaps.push({
      code: "UNATTRIBUTED_JUDGE",
      message: `${syntheticVerdicts} verdict(s) were recorded by a synthetic identity (for example the local board), which is neither a person nor an agent; they are counted by outcome but not by judge.`,
    });
  }

  // Q4
  const runs = { total: 0, succeeded: 0, failed: 0, withoutIssue: 0 };
  for (const row of input.heartbeatRunCounts) {
    runs.total += row.n;
    if (row.status === "succeeded") runs.succeeded += row.n;
    else if (row.status === "failed" || row.status === "timed_out") runs.failed += row.n;
    if (!row.hasIssue) runs.withoutIssue += row.n;
  }
  const answeredByPerson = input.questions.filter(
    (q) => ANSWERED_INTERACTION_STATUSES.has(q.status) && q.resolvedAt && q.resolvedByUserId,
  );
  const answeredByAgent = input.questions.filter(
    (q) => ANSWERED_INTERACTION_STATUSES.has(q.status) && !q.resolvedByUserId && q.resolvedByAgentId,
  ).length;
  if (answeredByAgent > 0) {
    gaps.push({
      code: "QUESTIONS_ANSWERED_BY_AGENT",
      message: `${answeredByAgent} question(s) to people were resolved by an agent; they are not counted as answered by a person.`,
    });
  }
  const waitMinutes = median(
    answeredByPerson.map((q) => Math.max(0, (q.resolvedAt!.getTime() - q.createdAt.getTime()) / MINUTE_MS)),
  );
  let humanCorrections = 0;
  let agentCorrections = 0;
  for (const row of input.correctionCounts) {
    if (row.kind === HARNESS_CORRECTION_KIND) continue;
    if (row.sourceActorType === "user") humanCorrections += row.n;
    else agentCorrections += row.n;
  }

  // Q5
  const { refusedAttempts, byCode } = tallyRefusals(input.refusalCounts);

  const withheld: AgentPerformanceProjection["withheld"] = [
    { section: "paired-harness assessments", reason: "Shown once evidence access rules ship (gate 3)" },
  ];
  if (input.projectsWithheld) withheld.push(PROJECTS_WITHHELD_ENTRY);

  return {
    kind: "agent_performance_projection",
    version: "agent-projection/0",
    companyId: input.companyId,
    agentId: input.agentId,
    generatedAt: input.asOf.toISOString(),
    asOf: input.asOf.toISOString(),
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    throughSeq: input.throughSeq,
    sideEffectFree: true,
    owed: { source: "current_definitions", historyKnown: false, routines: routinesOwed, assigned },
    quality: { verdicts: verdictTally, byJudge },
    acceptance: {
      automated: count(
        passedBy.independentAgent,
        byJudge.independentAgent,
        "Verdicts passed by a reviewer agent other than this one, out of all verdicts by such agents",
      ),
      human: count(passedBy.person, byJudge.person, "Verdicts passed by a person, out of all verdicts by people"),
      use: count(null, null, "No use records yet"),
      outcome: count(null, null, "Goal metric history arrives in gate 3"),
      accountable: buildAccountable(input.accountable),
    },
    cost: {
      spendCents: input.spendCents,
      runs,
      peopleProxies: {
        questionsAsked: input.questions.length,
        questionsAnswered: answeredByPerson.length,
        medianAnswerWaitMinutes: waitMinutes === null ? null : Math.round(waitMinutes * 10) / 10,
        humanCorrections: count(
          humanCorrections,
          null,
          agentCorrections > 0
            ? `Corrections recorded by people; ${agentCorrections} correction(s) from other agents are not counted`
            : "Corrections recorded by people",
        ),
      },
    },
    bounds: { refusedAttempts, byCode },
    decisions: { pendingApprovals: input.pendingApprovals, openQuestionsToPeople: input.openQuestionsToPeople },
    gaps,
    withheld,
  };
}

// ---------------------------------------------------------------------------
// Loader (selects only)
// ---------------------------------------------------------------------------

/** The project of the issue `issueId` names, as a scalar subquery (null when there is none). */
function issueProjectOf(issueId: SQL | { getSQL(): SQL }): SQL {
  return sql`(select i.project_id from ${issues} i where i.id = ${issueId})`;
}

/**
 * Gather the rows for one agent's projection. Null when the agent is not in
 * this company. Every query filters by `companyId`, and every query over work
 * tied to a project applies the VIEWER's restricted-project rule before
 * counting (`viewer`, from `viewerProjectScope`; unrestricted when omitted).
 */
export async function loadAgentPerformanceProjectionInput(
  db: Db,
  input: { companyId: string; agentId: string; asOf: Date; windowDays: number; viewer?: ViewerProjectScope },
): Promise<AgentPerformanceProjectionInput | null> {
  const { companyId, agentId, asOf, windowDays } = input;
  const viewer = input.viewer ?? UNRESTRICTED_PROJECT_SCOPE;
  const agent = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) return null;
  const window = projectionWindow(asOf, windowDays);
  const { from, to } = window;
  const n = sql<number>`count(*)::int`;

  // Archived routines are included so their runs in the window are not lost;
  // they are dropped below when they had none. Routines in projects the viewer
  // can't read are not loaded at all.
  const allRoutines = await loadAssignedRoutines(db, companyId, agentId, { includeArchived: true, viewer });
  const routineIds = allRoutines.map((routine) => routine.id);
  // Only built when there are routines (inArray needs a non-empty list).
  const runWindow = () =>
    and(
      eq(routineRuns.companyId, companyId),
      gte(routineRuns.triggeredAt, from),
      lte(routineRuns.triggeredAt, to),
      inArray(routineRuns.routineId, routineIds),
      viewer.projectScoped(issueProjectOf(routineRuns.linkedIssueId)),
    );
  const questionScope = viewer.projectScoped(issueProjectOf(issueThreadInteractions.issueId));

  const [
    routineRunCounts,
    routineLinkedIssues,
    assignedRows,
    verdictCounts,
    projectRows,
    goalRows,
    spendRow,
    heartbeatRunCounts,
    questions,
    openQuestionsRow,
    correctionCounts,
    refusalCounts,
    pendingApprovalsRow,
    seqRow,
  ] = await Promise.all([
    routineIds.length === 0
      ? Promise.resolve([] as ProjectionRoutineRunCount[])
      : db
          .select({ routineId: routineRuns.routineId, triggerId: routineRuns.triggerId, status: routineRuns.status, n })
          .from(routineRuns)
          .where(runWindow())
          .groupBy(routineRuns.routineId, routineRuns.triggerId, routineRuns.status),
    routineIds.length === 0
      ? Promise.resolve([] as ProjectionRoutineLinkedIssue[])
      : db
          .selectDistinct({
            routineId: routineRuns.routineId,
            triggerId: routineRuns.triggerId,
            issueId: sql<string>`${routineRuns.linkedIssueId}`,
            issueStatus: issues.status,
          })
          .from(routineRuns)
          .leftJoin(issues, and(eq(issues.id, routineRuns.linkedIssueId), eq(issues.companyId, companyId)))
          .where(and(runWindow(), isNotNull(routineRuns.linkedIssueId))),
    db
      .select({ status: issues.status, n })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId), viewer.projectScoped(issues.projectId)))
      .groupBy(issues.status),
    db
      .select({
        outcome: verdicts.outcome,
        reviewerAgentId: verdicts.reviewerAgentId,
        reviewerUserId: verdicts.reviewerUserId,
        n,
      })
      .from(verdicts)
      .innerJoin(issues, eq(issues.id, verdicts.issueId))
      .where(
        and(
          eq(verdicts.companyId, companyId),
          eq(verdicts.entityType, "issue"),
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agentId),
          viewer.projectScoped(issues.projectId),
          gte(verdicts.createdAt, from),
          lte(verdicts.createdAt, to),
        ),
      )
      .groupBy(verdicts.outcome, verdicts.reviewerAgentId, verdicts.reviewerUserId),
    db
      .select({ id: projects.id, title: projects.name, status: projects.status })
      .from(projects)
      .where(
        and(eq(projects.companyId, companyId), eq(projects.leadAgentId, agentId), isNull(projects.archivedAt), viewer.projects),
      )
      .orderBy(asc(projects.createdAt), asc(projects.id)),
    db
      .select({ id: goals.id, title: goals.title, status: goals.status })
      .from(goals)
      .where(and(eq(goals.companyId, companyId), eq(goals.ownerAgentId, agentId)))
      .orderBy(asc(goals.createdAt), asc(goals.id)),
    db
      .select({ total: sql<string | number>`coalesce(sum(${costEvents.costCents}), 0)::bigint` })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          eq(costEvents.agentId, agentId),
          gte(costEvents.occurredAt, from),
          lte(costEvents.occurredAt, to),
          // Spend is tied to a project directly or through its issue.
          viewer.projectScoped(costEvents.projectId),
          viewer.projectScoped(issueProjectOf(costEvents.issueId)),
        ),
      )
      .then((rows) => rows[0] ?? null),
    db
      .select({
        status: heartbeatRuns.status,
        hasIssue: sql<boolean>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', '') <> ''`,
        n,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          gte(heartbeatRuns.createdAt, from),
          lte(heartbeatRuns.createdAt, to),
          viewer.runs,
        ),
      )
      .groupBy(heartbeatRuns.status, sql`2`),
    db
      .select({
        status: issueThreadInteractions.status,
        createdAt: issueThreadInteractions.createdAt,
        resolvedAt: issueThreadInteractions.resolvedAt,
        resolvedByUserId: issueThreadInteractions.resolvedByUserId,
        resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.createdByAgentId, agentId),
          inArray(issueThreadInteractions.kind, [...QUESTION_INTERACTION_KINDS]),
          gte(issueThreadInteractions.createdAt, from),
          lte(issueThreadInteractions.createdAt, to),
          questionScope,
        ),
      ),
    db
      .select({ n })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.createdByAgentId, agentId),
          inArray(issueThreadInteractions.kind, [...QUESTION_INTERACTION_KINDS]),
          eq(issueThreadInteractions.status, "pending"),
          questionScope,
        ),
      )
      .then((rows) => rows[0] ?? null),
    db
      .select({ kind: agentCorrections.kind, sourceActorType: agentCorrections.sourceActorType, n })
      .from(agentCorrections)
      .where(
        and(
          eq(agentCorrections.companyId, companyId),
          eq(agentCorrections.agentId, agentId),
          ne(agentCorrections.kind, HARNESS_CORRECTION_KIND),
          gte(agentCorrections.createdAt, from),
          lte(agentCorrections.createdAt, to),
          viewer.projectScoped(issueProjectOf(agentCorrections.issueId)),
        ),
      )
      .groupBy(agentCorrections.kind, agentCorrections.sourceActorType),
    // Refusals carry no project; they are counted for every reader.
    loadAgentRefusalCounts(db, companyId, agentId, window),
    db
      .select({ n })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.requestedByAgentId, agentId),
          eq(approvals.status, "pending"),
          viewer.approvals,
        ),
      )
      .then((rows) => rows[0] ?? null),
    db
      .select({ seq: sql<string | number | null>`max(${evaluationEvents.seq})` })
      .from(evaluationEvents)
      .where(eq(evaluationEvents.companyId, companyId))
      .then((rows) => rows[0] ?? null),
  ]);

  const routinesWithRuns = new Set(routineRunCounts.map((row) => row.routineId));
  const routinesInView = allRoutines.filter((routine) => routine.status !== "archived" || routinesWithRuns.has(routine.id));

  // Latest stored evaluator card per accountable milestone.
  const milestones = [
    ...projectRows.map((row) => ({ kind: "project" as const, ...row })),
    ...goalRows.map((row) => ({ kind: "goal" as const, ...row })),
  ];
  const cardRows =
    milestones.length === 0
      ? []
      : await db
          .select({
            milestoneKind: evaluationScorecards.milestoneKind,
            milestoneId: evaluationScorecards.milestoneId,
            version: evaluationScorecards.version,
            throughSeq: evaluationScorecards.throughSeq,
            card: evaluationScorecards.card,
          })
          .from(evaluationScorecards)
          .where(
            and(
              eq(evaluationScorecards.companyId, companyId),
              inArray(
                evaluationScorecards.milestoneId,
                milestones.map((m) => m.id),
              ),
              sql`${evaluationScorecards.version} = (
                select max(s2.version) from ${evaluationScorecards} s2
                where s2.company_id = ${evaluationScorecards.companyId}
                  and s2.milestone_kind = ${evaluationScorecards.milestoneKind}
                  and s2.milestone_id = ${evaluationScorecards.milestoneId})`,
            ),
          );
  const cardFor = (kind: string, id: string) =>
    cardRows.find((row) => row.milestoneKind === kind && row.milestoneId === id) ?? null;

  const seq = seqRow?.seq;
  return {
    companyId,
    agentId,
    asOf,
    windowDays,
    throughSeq: seq === null || seq === undefined ? null : Number(seq),
    routines: routinesInView,
    routineRunCounts,
    routineLinkedIssues,
    assignedIssueStatusCounts: Object.fromEntries(assignedRows.map((row) => [row.status, row.n])),
    verdictCounts,
    accountable: milestones.map((m) => {
      const card = cardFor(m.kind, m.id);
      return {
        kind: m.kind,
        id: m.id,
        title: m.title,
        status: m.status,
        card: card ? { version: card.version, throughSeq: Number(card.throughSeq), card: card.card } : null,
      };
    }),
    spendCents: Number(spendRow?.total ?? 0),
    heartbeatRunCounts: heartbeatRunCounts.map((row) => ({ ...row, hasIssue: Boolean(row.hasIssue) })),
    questions,
    openQuestionsToPeople: openQuestionsRow?.n ?? 0,
    correctionCounts,
    refusalCounts,
    pendingApprovals: pendingApprovalsRow?.n ?? 0,
    projectsWithheld: viewer.restricted,
  };
}
