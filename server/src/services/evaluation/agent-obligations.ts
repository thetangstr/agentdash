import {
  agentObligationOccurrenceId,
  EVALUATOR_READ_ONLY_REASON,
  evaluationContractV2Schema,
  evaluationContractVersionOf,
  evaluationResponsibilityDeadlineSchema,
  type AgentObligationEndState,
  type AgentObligationOccurrence,
  type AgentPerformanceWindow,
  type AgentProfileObligationKind,
  type EvaluationContractV2,
  type EvaluationResponsibilityDeadline,
  type IssueResponsibilityMappedBy,
  type RoutineCatchUpPolicy,
  type RoutineConcurrencyPolicy,
  type RoutineRunSource,
  type RoutineRunStatus,
  type RoutineTriggerKind,
} from "@paperclipai/shared";
import { parseCron } from "../cron.js";
import type { EvaluationEventRow } from "./ledger.js";
import { assigneeAt, date, latestSnapshot, obj, str, terminalAt, type ItemTimeline, type Payload, type Timeline } from "./scoring/timeline.js";

/**
 * AgentDash: Agent Performance Management gate 3 — work owed (the
 * denominator; evaluation LLD §7). P3.1 froze the signatures; P3.3
 * implements them over the events P3.2 ingests.
 *
 * Occurrences are generated from VERSIONED definitions (trigger snapshots
 * with their event times, profile applications, responsibility mappings,
 * contract deadlines), never from execution records, so a period in which
 * nothing ran still shows up. Everything here is pure: the same ordered
 * window and `asOf` always yield the same occurrences, and no wall-clock
 * "now" is read. Version 1 binds existing routines and deliverables; it never
 * creates or edits a trigger.
 *
 * P3.3 additions to the frozen shapes (additive, optional): `DeliverableRunFact`
 * carries `assemblerAgentId` and `abandonedAt` (the producer of a deliverable
 * run and its cancellation).
 */

/** One version of a routine trigger's definition, effective from `at` until the next version. */
export interface TriggerDefinitionVersion {
  triggerId: string;
  routineId: string;
  /** Event time of the `routine.trigger_snapshot` this version came from. */
  at: Date;
  eventId: string;
  kind: RoutineTriggerKind;
  cronExpression: string | null;
  timezone: string | null;
  /** The trigger is enabled AND its routine is active: a paused trigger or routine owes nothing while paused. */
  enabled: boolean;
  /** The routine's policies in force at `at` (catch-up and coalescing follow these). */
  catchUpPolicy: RoutineCatchUpPolicy;
  concurrencyPolicy: RoutineConcurrencyPolicy;
}

/** A routine run as ingested, joined with its `routine_run_occurrences` row when dispatch recorded one. */
export interface RoutineRunFact {
  routineRunId: string;
  routineId: string;
  triggerId: string | null;
  source: RoutineRunSource;
  status: RoutineRunStatus;
  triggeredAt: Date;
  /** The occurrence the run was dispatched for (schedule runs only); null for runs recorded before gate 3. */
  scheduledFor: Date | null;
  linkedIssueId: string | null;
  coalescedIntoRunId: string | null;
  failureReason: string | null;
  completedAt: Date | null;
  eventId: string;
}

/** A deliverable run as ingested (`deliverable_runs`). The cadence is free text, so runs — not periods — are owed. */
export interface DeliverableRunFact {
  deliverableRunId: string;
  deliverableId: string;
  runKey: string;
  status: string;
  openedAt: Date;
  shippedAt: Date | null;
  checkPassed: boolean | null;
  eventId: string;
  /** P3.3 (additive): the deliverable's assembler — the producer of the run. */
  assemblerAgentId?: string | null;
  /** P3.3 (additive): when the run was abandoned (a cancellation). */
  abandonedAt?: Date | null;
}

/** One `issue_responsibilities` interval (append-only history; LLD §5.2). */
export interface ResponsibilityInterval {
  mappingId: string;
  issueId: string;
  agentId: string;
  responsibilityKey: string;
  profileRevisionId: string | null;
  from: Date;
  /** Null = still current at the cut. */
  to: Date | null;
  mappedBy: IssueResponsibilityMappedBy;
  eventId: string;
}

/** An applied profile revision and the interval it was in force for this agent. */
export interface ProfileInForce {
  profileRevisionId: string;
  /** The `contract.declared` (v2) event the application wrote; null if the contract step had not run. */
  contractEventId: string | null;
  from: Date;
  to: Date | null;
  responsibilities: Array<{
    key: string;
    obligation: { kind: AgentProfileObligationKind; routineTriggerId?: string; deliverableId?: string; goalId?: string };
    deadline: EvaluationResponsibilityDeadline | null;
  }>;
  eventId: string;
}

/**
 * The agent-side facts obligations are generated from, folded from the same
 * ordered window as `buildTimeline` (`base`). Lists are in event-time order.
 */
export interface AgentObligationTimeline {
  agentId: string;
  /** The milestone fold of the same window: issues, runs, interactions, refusals (block evidence comes from here). */
  base: Timeline;
  profiles: ProfileInForce[];
  /** Keyed by trigger id; each list oldest first. */
  triggers: Map<string, TriggerDefinitionVersion[]>;
  routineRuns: RoutineRunFact[];
  deliverableRuns: DeliverableRunFact[];
  mappings: ResponsibilityInterval[];
}

// ---------------------------------------------------------------------------
// Small pure helpers shared with agent scoring
// ---------------------------------------------------------------------------

const ROUTINE_TRIGGER_KINDS = new Set(["schedule", "webhook", "api"]);
const CATCH_UP_POLICIES = new Set(["skip_missed", "enqueue_missed_with_cap"]);
const CONCURRENCY_POLICIES = new Set(["coalesce_if_active", "always_enqueue", "skip_if_active"]);
const OBLIGATION_KINDS = new Set(["routine", "deliverable", "assigned", "goal"]);
const MAPPED_BY = new Set(["routine", "deliverable", "planner", "agent", "human"]);
/** Interaction kinds that are a question to a person (`agent-performance-projection.ts` QUESTION_INTERACTION_KINDS). */
export const QUESTION_KINDS = new Set(["ask_user_questions", "request_confirmation"]);
/** A scheduled occurrence that has just come due and has no run yet is `not_started`, not `cause_unknown`, for this long. */
export const SCHEDULE_DISPATCH_GRACE_MS = 15 * 60 * 1000;
/** At most this many fire times per trigger version are generated; a note says when the cap was hit. */
export const MAX_FIRES_PER_VERSION = 10_000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function payloadOf(e: EvaluationEventRow): Payload {
  return (e.payload ?? {}) as Payload;
}

function byTimeThenId<T extends { at: Date; eventId: string }>(a: T, b: T): number {
  const d = a.at.getTime() - b.at.getTime();
  return d !== 0 ? d : a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

/** The V2 agent contract a `contract.declared` row carries for `agentId`, or null. */
export function agentContractOf(e: EvaluationEventRow, agentId: string): EvaluationContractV2 | null {
  if (e.eventType !== "contract.declared" || evaluationContractVersionOf(e.payload) !== "v2") return null;
  const p = payloadOf(e);
  const raw = obj(p, "contract") ?? p;
  const parsed = evaluationContractV2Schema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.subjectRef.id === agentId ? parsed.data : null;
}

/** The end of a `by_date` deadline day (UTC). */
export function endOfDateUtc(dateOnly: string): number {
  return Date.parse(`${dateOnly}T23:59:59.999Z`);
}

/** The due time of an occurrence that became owed at `owedAt` under `deadline`; null without one. */
export function dueAtFor(deadline: EvaluationResponsibilityDeadline | null, owedAt: number): number | null {
  if (!deadline) return null;
  if (deadline.kind === "by_date") {
    const t = endOfDateUtc(deadline.date);
    return Number.isFinite(t) ? t : null;
  }
  return owedAt + deadline.hours * HOUR_MS;
}

/**
 * The agent credited with delivering an issue: the assignee at the transition
 * into `in_review` (else `done`) for the delivered version — after the last
 * reopen — plus the agent that moved it when no assignee was on record
 * (LLD §5.1). Reassigning the item afterwards does not move the credit.
 */
export function producerAtDelivery(it: ItemTimeline): { agentId: string | null; at: Date; reachedAt: Date; eventId: string | null } | null {
  const terminal = terminalAt(it);
  if (!terminal || terminal.status !== "done") return null;
  const done = terminal.time;
  let startIdx = 0;
  it.transitions.forEach((t, i) => {
    if (t.time <= done && t.from && (t.from === "done" || t.from === "cancelled")) startIdx = i + 1;
  });
  const version = it.transitions.slice(startIdx).filter((t) => t.time <= done);
  const review = [...version].reverse().find((t) => t.to === "in_review") ?? null;
  const reach = review ?? [...version].reverse().find((t) => t.to === "done") ?? null;
  const reachedAt = reach?.time ?? done;
  const before = assigneeAt(it, new Date(reachedAt.getTime() - 1)).agentId;
  const mover = reach && reach.actorType === "agent" ? reach.actorId : null;
  const agentId = before ?? mover ?? assigneeAt(it, reachedAt).agentId ?? null;
  return { agentId, at: done, reachedAt, eventId: terminal.eventId ?? latestSnapshot(it)?.eventId ?? null };
}

// ---------------------------------------------------------------------------
// Cron fire times (the routines scheduler's semantics, enumerated efficiently)
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Same options as the scheduler (`routines.ts` getZonedMinuteParts).
    f = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(timeZone, f);
  }
  return f;
}

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
  if (weekday == null) throw new Error("unable to resolve the weekday");
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour) % 24, minute: Number(map.minute), weekday };
}

/**
 * Every fire time of `expression` in `timeZone` inside `[from, toExclusive)`,
 * ascending, at most `cap`. Same semantics as the routines scheduler: every
 * whole UTC minute whose wall-clock time in the zone matches all five fields
 * fires once, so a skipped spring-forward minute never fires and a repeated
 * fall-back minute fires twice. Resolves the zone once per 15-minute block and
 * drops to per-minute checks where the offset changes (as
 * `countCronFiresInWindow` in the gate 1 projection). Throws on an invalid
 * expression or timezone.
 */
export function cronFireTimes(expression: string, timeZone: string, from: number, toExclusive: number, cap = MAX_FIRES_PER_VERSION): { times: number[]; capped: boolean } {
  const cron = parseCron(expression.trim());
  const formatter = zonedFormatter(timeZone);
  const minutes = new Set(cron.minutes);
  const hours = new Set(cron.hours);
  const days = new Set(cron.daysOfMonth);
  const months = new Set(cron.months);
  const weekdays = new Set(cron.daysOfWeek);
  const matches = (p: ZonedParts) => minutes.has(p.minute) && hours.has(p.hour) && days.has(p.day) && months.has(p.month) && weekdays.has(p.weekday);
  const start = Math.ceil(from / MINUTE_MS) * MINUTE_MS;
  const end = Math.floor((toExclusive - 1) / MINUTE_MS) * MINUTE_MS;
  const times: number[] = [];
  if (end < start) return { times, capped: false };
  const BLOCK_MS = 15 * MINUTE_MS;
  const offsetOf = (p: ZonedParts, at: number) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - at;
  let blockStart = Math.floor(start / BLOCK_MS) * BLOCK_MS;
  let current = zonedParts(formatter, blockStart);
  while (blockStart <= end) {
    const nextStart = blockStart + BLOCK_MS;
    const next = zonedParts(formatter, nextStart);
    const first = Math.max(blockStart, start);
    const last = Math.min(nextStart - MINUTE_MS, end);
    const steady = current.minute % 15 === 0 && offsetOf(current, blockStart) === offsetOf(next, nextStart);
    if (steady) {
      if (hours.has(current.hour) && days.has(current.day) && months.has(current.month) && weekdays.has(current.weekday)) {
        for (let at = first; at <= last; at += MINUTE_MS) {
          if (minutes.has(current.minute + (at - blockStart) / MINUTE_MS)) {
            times.push(at);
            if (times.length >= cap) return { times, capped: true };
          }
        }
      }
    } else {
      for (let at = first; at <= last; at += MINUTE_MS) {
        if (matches(zonedParts(formatter, at))) {
          times.push(at);
          if (times.length >= cap) return { times, capped: true };
        }
      }
    }
    blockStart = nextStart;
    current = next;
  }
  return { times, capped: false };
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

type ResponsibilityDigest = ProfileInForce["responsibilities"][number];

function parseDeadline(value: unknown): EvaluationResponsibilityDeadline | null {
  const parsed = evaluationResponsibilityDeadlineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseDigest(value: unknown): ResponsibilityDigest[] {
  if (!Array.isArray(value)) return [];
  const out: ResponsibilityDigest[] = [];
  for (const raw of value) {
    const o = raw && typeof raw === "object" ? (raw as Payload) : null;
    const key = o ? str(o, "key") : null;
    const ob = o ? obj(o, "obligation") : null;
    const kind = ob ? str(ob, "kind") : null;
    if (!key || !kind || !OBLIGATION_KINDS.has(kind)) continue;
    const obligation: ResponsibilityDigest["obligation"] = { kind: kind as AgentProfileObligationKind };
    const trigger = str(ob!, "routineTriggerId");
    const deliverable = str(ob!, "deliverableId");
    const goal = str(ob!, "goalId");
    if (trigger) obligation.routineTriggerId = trigger;
    if (deliverable) obligation.deliverableId = deliverable;
    if (goal) obligation.goalId = goal;
    out.push({ key, obligation, deadline: parseDeadline(o!.deadline) });
  }
  return out;
}

/**
 * Fold the agent-side facts out of an ordered window (`orderEvents`, seq ≤
 * the cut). Pure. Events of other agents' responsibilities are ignored;
 * trigger and run facts are kept only for triggers some profile in force
 * bound to this agent.
 */
export function buildAgentObligationTimeline(ordered: EvaluationEventRow[], base: Timeline, agentId: string): AgentObligationTimeline {
  const revisions = new Map<string, { digest: ResponsibilityDigest[]; appliedAt: Date | null; appliedEventId: string | null; supersededAt: Date | null }>();
  const applications: Array<{ revisionId: string; at: Date; eventId: string }> = [];
  const contracts = new Map<string, { eventId: string; contract: EvaluationContractV2 }>();
  for (const e of ordered) {
    const p = payloadOf(e);
    if (e.eventType === "contract.declared") {
      const c = agentContractOf(e, agentId);
      if (c) contracts.set(c.profileRevisionId, { eventId: e.id, contract: c });
    } else if (e.eventType === "profile.revision_changed" && str(p, "agentId") === agentId) {
      const id = str(p, "revisionId");
      if (!id) continue;
      const rev = revisions.get(id) ?? { digest: [], appliedAt: null, appliedEventId: null, supersededAt: null };
      const digest = parseDigest(p.responsibilities);
      if (digest.length > 0) rev.digest = digest;
      const state = str(p, "state");
      if (state === "applied" && !rev.appliedAt) {
        rev.appliedAt = e.eventTime;
        rev.appliedEventId = e.id;
      }
      if (state === "superseded" && !rev.supersededAt) rev.supersededAt = e.eventTime;
      revisions.set(id, rev);
    } else if (e.eventType === "profile.application_changed" && str(p, "agentId") === agentId && str(p, "status") === "applied") {
      const id = str(p, "revisionId");
      if (id) applications.push({ revisionId: id, at: e.eventTime, eventId: e.id });
    }
  }

  // When each revision came into force: its application, else its own `applied` state.
  const starts = new Map<string, { at: Date; eventId: string }>();
  for (const a of applications) {
    const cur = starts.get(a.revisionId);
    if (!cur || a.at < cur.at) starts.set(a.revisionId, { at: a.at, eventId: a.eventId });
  }
  for (const [id, rev] of revisions) {
    if (!rev.appliedAt || !rev.appliedEventId) continue;
    const cur = starts.get(id);
    if (!cur || rev.appliedAt < cur.at) starts.set(id, { at: rev.appliedAt, eventId: rev.appliedEventId });
  }
  const ordering = [...starts.entries()].sort(([a, x], [b, y]) => x.at.getTime() - y.at.getTime() || (a < b ? -1 : a > b ? 1 : 0));
  const profiles: ProfileInForce[] = ordering.map(([revisionId, start], i) => {
    const rev = revisions.get(revisionId);
    const contract = contracts.get(revisionId) ?? null;
    const next = ordering[i + 1]?.[1].at ?? null;
    const superseded = rev?.supersededAt && rev.supersededAt > start.at ? rev.supersededAt : null;
    const to = next && superseded ? (next < superseded ? next : superseded) : (next ?? superseded);
    let responsibilities: ResponsibilityDigest[] = rev?.digest ?? [];
    const contractDeadline = new Map((contract?.contract.responsibilities ?? []).map((r) => [r.key, r.deadline ?? null] as const));
    if (responsibilities.length === 0 && contract) {
      // The revision's own digest is not in the window: its contract still names the keys; work reaches them only by mapping.
      responsibilities = contract.contract.responsibilities.map((r) => ({ key: r.key, obligation: { kind: "assigned" as const }, deadline: r.deadline ?? null }));
    }
    responsibilities = responsibilities.map((r) => ({ ...r, deadline: r.deadline ?? contractDeadline.get(r.key) ?? null }));
    return { profileRevisionId: revisionId, contractEventId: contract?.eventId ?? null, from: start.at, to, responsibilities, eventId: start.eventId };
  });

  const boundTriggers = new Set<string>();
  const boundDeliverables = new Set<string>();
  for (const pr of profiles) {
    for (const r of pr.responsibilities) {
      if (r.obligation.kind === "routine" && r.obligation.routineTriggerId) boundTriggers.add(r.obligation.routineTriggerId);
      if (r.obligation.kind === "deliverable" && r.obligation.deliverableId) boundDeliverables.add(r.obligation.deliverableId);
    }
  }

  // Definitions with history.
  interface TriggerDef { at: Date; eventId: string; routineId: string; kind: RoutineTriggerKind; cronExpression: string | null; timezone: string | null; enabled: boolean; createdAt: Date | null; deleted: boolean }
  interface RoutineDef { at: Date; eventId: string; status: string; catchUpPolicy: RoutineCatchUpPolicy; concurrencyPolicy: RoutineConcurrencyPolicy; createdAt: Date | null }
  const triggerDefs = new Map<string, TriggerDef[]>();
  const routineDefs = new Map<string, RoutineDef[]>();
  const runs = new Map<string, RoutineRunFact>();
  const deliverables = new Map<string, DeliverableRunFact>();
  const mappings = new Map<string, ResponsibilityInterval>();
  const boundRoutines = new Set<string>();
  for (const e of ordered) {
    if (e.eventType !== "routine.trigger_snapshot") continue;
    const p = payloadOf(e);
    const id = str(p, "triggerId") ?? e.sourceId;
    const routineId = str(p, "routineId");
    if (boundTriggers.has(id) && routineId) boundRoutines.add(routineId);
  }
  for (const e of ordered) {
    const p = payloadOf(e);
    switch (e.eventType) {
      case "routine.trigger_snapshot": {
        const id = str(p, "triggerId") ?? e.sourceId;
        if (!boundTriggers.has(id)) break;
        const kind = str(p, "kind");
        const routineId = str(p, "routineId");
        if (!kind || !ROUTINE_TRIGGER_KINDS.has(kind) || !routineId) break;
        const list = triggerDefs.get(id) ?? [];
        list.push({ at: e.eventTime, eventId: e.id, routineId, kind: kind as RoutineTriggerKind, cronExpression: str(p, "cronExpression"), timezone: str(p, "timezone"), enabled: p.enabled === true, createdAt: date(p, "createdAt"), deleted: false });
        triggerDefs.set(id, list);
        break;
      }
      case "routine.trigger_deleted": {
        const id = str(p, "triggerId");
        if (!id || !boundTriggers.has(id)) break;
        const list = triggerDefs.get(id) ?? [];
        const last = list[list.length - 1];
        if (last) list.push({ ...last, at: e.eventTime, eventId: e.id, enabled: false, createdAt: null, deleted: true });
        triggerDefs.set(id, list);
        break;
      }
      case "routine.snapshot": {
        const id = str(p, "routineId") ?? e.sourceId;
        if (!boundRoutines.has(id)) break;
        const catchUp = str(p, "catchUpPolicy");
        const concurrency = str(p, "concurrencyPolicy");
        const list = routineDefs.get(id) ?? [];
        list.push({
          at: e.eventTime,
          eventId: e.id,
          status: str(p, "status") ?? "active",
          catchUpPolicy: (catchUp && CATCH_UP_POLICIES.has(catchUp) ? catchUp : "skip_missed") as RoutineCatchUpPolicy,
          concurrencyPolicy: (concurrency && CONCURRENCY_POLICIES.has(concurrency) ? concurrency : "coalesce_if_active") as RoutineConcurrencyPolicy,
          createdAt: date(p, "createdAt"),
        });
        routineDefs.set(id, list);
        break;
      }
      case "routine.run_changed": {
        const id = str(p, "routineRunId") ?? e.sourceId;
        const triggerId = str(p, "triggerId");
        const routineId = str(p, "routineId") ?? "";
        if (!(triggerId && boundTriggers.has(triggerId)) && !boundRoutines.has(routineId)) break;
        const prev = runs.get(id);
        const triggeredAt = date(p, "triggeredAt") ?? prev?.triggeredAt ?? e.eventTime;
        runs.set(id, {
          routineRunId: id,
          routineId,
          triggerId: triggerId ?? prev?.triggerId ?? null,
          source: (str(p, "source") ?? prev?.source ?? "schedule") as RoutineRunSource,
          status: (str(p, "status") ?? prev?.status ?? "received") as RoutineRunStatus,
          triggeredAt,
          scheduledFor: date(p, "scheduledFor") ?? prev?.scheduledFor ?? null,
          linkedIssueId: str(p, "linkedIssueId") ?? prev?.linkedIssueId ?? null,
          coalescedIntoRunId: str(p, "coalescedIntoRunId") ?? prev?.coalescedIntoRunId ?? null,
          failureReason: str(p, "failureReason"),
          completedAt: date(p, "completedAt") ?? prev?.completedAt ?? null,
          eventId: e.id,
        });
        break;
      }
      case "deliverable.run_changed": {
        const deliverableId = str(p, "deliverableId");
        if (!deliverableId || !boundDeliverables.has(deliverableId)) break;
        const id = str(p, "deliverableRunId") ?? e.sourceId;
        const prev = deliverables.get(id);
        deliverables.set(id, {
          deliverableRunId: id,
          deliverableId,
          runKey: str(p, "runKey") ?? prev?.runKey ?? id,
          status: str(p, "status") ?? prev?.status ?? "collecting",
          openedAt: date(p, "openedAt") ?? prev?.openedAt ?? e.eventTime,
          shippedAt: date(p, "shippedAt") ?? prev?.shippedAt ?? null,
          checkPassed: typeof p.checkPassed === "boolean" ? p.checkPassed : (prev?.checkPassed ?? null),
          eventId: e.id,
          assemblerAgentId: str(p, "assemblerAgentId") ?? prev?.assemblerAgentId ?? null,
          abandonedAt: date(p, "abandonedAt") ?? prev?.abandonedAt ?? null,
        });
        break;
      }
      case "responsibility.interval": {
        if (str(p, "agentId") !== agentId) break;
        const id = str(p, "mappingId") ?? e.sourceId;
        const issueId = str(p, "issueId");
        const key = str(p, "responsibilityKey");
        const from = date(p, "validFrom");
        if (!issueId || !key || !from) break;
        const prev = mappings.get(id);
        const mappedBy = str(p, "mappedBy");
        mappings.set(id, {
          mappingId: id,
          issueId,
          agentId,
          responsibilityKey: key,
          profileRevisionId: str(p, "profileRevisionId"),
          from,
          to: date(p, "validTo") ?? prev?.to ?? null,
          mappedBy: (mappedBy && MAPPED_BY.has(mappedBy) ? mappedBy : "agent") as IssueResponsibilityMappedBy,
          eventId: e.id,
        });
        break;
      }
      default:
        break;
    }
  }

  const triggers = new Map<string, TriggerDefinitionVersion[]>();
  for (const id of [...boundTriggers].sort()) {
    const defs = triggerDefs.get(id) ?? [];
    if (defs.length === 0) continue;
    const routineId = defs[defs.length - 1]!.routineId;
    const rdefs = routineDefs.get(routineId) ?? [];
    // Change points of either definition, in order. History before the first snapshot is not recorded: the first
    // version is taken to hold since the trigger was created (the card reports HISTORY_BEFORE_SOURCE for that).
    const points = [
      ...defs.map((d, i) => ({ at: i === 0 && d.createdAt && d.createdAt < d.at ? d.createdAt : d.at, eventId: d.eventId, t: d as TriggerDef | null, r: null as RoutineDef | null })),
      ...rdefs.map((d, i) => ({ at: i === 0 && d.createdAt && d.createdAt < d.at ? d.createdAt : d.at, eventId: d.eventId, t: null as TriggerDef | null, r: d as RoutineDef | null })),
    ].sort(byTimeThenId);
    let t: TriggerDef | null = null;
    let r: RoutineDef | null = null;
    const versions: TriggerDefinitionVersion[] = [];
    for (const pt of points) {
      if (pt.t) t = pt.t;
      if (pt.r) r = pt.r;
      if (!t) continue;
      const v: TriggerDefinitionVersion = {
        triggerId: id,
        routineId: t.routineId,
        at: pt.at,
        eventId: pt.eventId,
        kind: t.kind,
        cronExpression: t.cronExpression,
        timezone: t.timezone,
        enabled: t.enabled && !t.deleted && (r ? r.status === "active" : true),
        catchUpPolicy: r?.catchUpPolicy ?? "skip_missed",
        concurrencyPolicy: r?.concurrencyPolicy ?? "coalesce_if_active",
      };
      const last = versions[versions.length - 1];
      if (
        last &&
        last.kind === v.kind &&
        last.cronExpression === v.cronExpression &&
        last.timezone === v.timezone &&
        last.enabled === v.enabled &&
        last.catchUpPolicy === v.catchUpPolicy &&
        last.concurrencyPolicy === v.concurrencyPolicy
      ) {
        continue; // nothing that decides what is owed changed
      }
      if (last && last.at.getTime() === v.at.getTime()) versions[versions.length - 1] = v;
      else versions.push(v);
    }
    triggers.set(id, versions);
  }

  const byAt = <T extends { eventId: string }>(time: (x: T) => Date) => (a: T, b: T) => time(a).getTime() - time(b).getTime() || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
  return {
    agentId,
    base,
    profiles,
    triggers,
    routineRuns: [...runs.values()].sort(byAt((x) => x.triggeredAt)),
    deliverableRuns: [...deliverables.values()].sort(byAt((x) => x.openedAt)),
    mappings: [...mappings.values()].sort(byAt((x) => x.from)),
  };
}

// ---------------------------------------------------------------------------
// End states
// ---------------------------------------------------------------------------

interface Outcome {
  endState: AgentObligationEndState;
  deliveredAt: number | null;
  producerAgentId: string | null;
  evidence: string[];
  note: string | null;
}

const PLATFORM_FAILURE_RUN_STATUSES = new Set(["failed", "timed_out"]);

/**
 * How an issue-backed occurrence ended as of `until` (≤ asOf). A block is
 * assigned only with evidence on the issue: a pending question or approval
 * (person), a refusal of the responsible agent after the item last moved
 * (access), a failed last run or an exhausted recovery budget (platform).
 */
export function issueOutcome(base: Timeline, issueId: string, dueAt: number | null, until: number, responsibleAgentId: string): Outcome {
  const it = base.items.get(issueId);
  if (!it) return { endState: "cause_unknown", deliveredAt: null, producerAgentId: null, evidence: [], note: "the linked issue is not in the records this card was computed from" };
  const terminal = terminalAt(it);
  if (terminal && terminal.time.getTime() <= until) {
    const ref = terminal.eventId ?? latestSnapshot(it)?.eventId ?? null;
    if (terminal.status === "done") {
      const t = terminal.time.getTime();
      const producer = producerAtDelivery(it);
      return { endState: dueAt === null || t <= dueAt ? "delivered_on_time" : "delivered_late", deliveredAt: t, producerAgentId: producer?.agentId ?? null, evidence: ref ? [ref] : [], note: null };
    }
    return { endState: "cancelled", deliveredAt: null, producerAgentId: null, evidence: ref ? [ref] : [], note: "the issue was cancelled" };
  }
  const within = <T extends { time: Date }>(xs: T[]) => xs.filter((x) => x.time.getTime() <= until);
  // person: a question still pending, or an approval created and not decided
  const interactions = new Map<string, { status: string | null; kind: string | null; eventId: string }>();
  for (const x of within(it.interactions)) interactions.set(x.interactionId ?? x.eventId, { status: x.status, kind: x.kind, eventId: x.eventId });
  const pendingQuestion = [...interactions.values()].filter((x) => x.status === "pending" && x.kind && QUESTION_KINDS.has(x.kind)).map((x) => x.eventId);
  const approvals = new Map<string, { kind: "created" | "decided"; eventId: string }>();
  for (const a of within(it.approvals)) approvals.set(a.approvalId ?? a.eventId, { kind: a.kind, eventId: a.eventId });
  const pendingApproval = [...approvals.values()].filter((a) => a.kind === "created").map((a) => a.eventId);
  if (pendingQuestion.length > 0 || pendingApproval.length > 0) {
    return { endState: "blocked_on_person", deliveredAt: null, producerAgentId: null, evidence: [...pendingQuestion, ...pendingApproval], note: pendingQuestion.length > 0 ? "a question to a person is pending" : "an approval is pending" };
  }
  const lastMove = within(it.transitions).reduce((m, t) => Math.max(m, t.time.getTime()), Number.NEGATIVE_INFINITY);
  const refusals = base.authzRefused.filter(
    (r) => r.issueId === issueId && r.actorType === "agent" && r.actorId === responsibleAgentId && str(r.payload, "reasonCode") !== EVALUATOR_READ_ONLY_REASON && r.time.getTime() <= until && r.time.getTime() > lastMove,
  );
  if (refusals.length > 0) return { endState: "blocked_on_access", deliveredAt: null, producerAgentId: null, evidence: refusals.map((r) => r.eventId), note: "a request was refused since the item last moved" };
  const runs = within(it.runs);
  const lastRun = runs[runs.length - 1];
  const exhausted = within(it.recoveryExhausted).filter((x) => x.time.getTime() > lastMove);
  if ((lastRun && PLATFORM_FAILURE_RUN_STATUSES.has(lastRun.status ?? "")) || exhausted.length > 0) {
    const refs = [...(lastRun && PLATFORM_FAILURE_RUN_STATUSES.has(lastRun.status ?? "") ? [lastRun.eventId] : []), ...exhausted.map((x) => x.eventId)];
    return { endState: "blocked_on_platform", deliveredAt: null, producerAgentId: null, evidence: refs, note: lastRun?.errorCode ? `the last run failed (${lastRun.errorCode})` : "the last run failed or recovery was exhausted" };
  }
  if (dueAt !== null && until > dueAt) return { endState: "missed", deliveredAt: null, producerAgentId: null, evidence: [], note: "due and not delivered" };
  const started = within(it.transitions).some((t) => t.to === "in_progress" || t.to === "in_review") || runs.length > 0 || ["in_progress", "in_review", "blocked"].includes(statusUntil(it, until) ?? "");
  return { endState: started ? "in_progress" : "not_started", deliveredAt: null, producerAgentId: null, evidence: [], note: null };
}

function statusUntil(it: ItemTimeline, until: number): string | null {
  let status: string | null = null;
  for (const t of it.transitions) if (t.time.getTime() <= until) status = t.to;
  if (status) return status;
  let snap: string | null = null;
  for (const s of it.snapshots) if (s.time.getTime() <= until) snap = s.status;
  return snap;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function iso(t: number): string {
  return new Date(t).toISOString();
}

/**
 * Every occurrence owed by the agent's responsibilities inside
 * `window` (`[from, to]`, `to ≤ asOf`), with its end state as of `asOf`.
 * Pure. Rules (LLD §7):
 * - scheduled: fire times of each trigger version in force (cron in its
 *   timezone, DST-correct), skipping paused intervals; catch-up and
 *   coalescing per the policies in force; matched through `scheduledFor`;
 * - received: each run a webhook/API trigger received;
 * - deliverable: each run opened; periods with no run are a gap, not owed;
 * - assigned: each issue mapped to the responsibility, credited to the
 *   responsible agent of the interval;
 * - goal: the contract `by_date` deadline.
 * A `blocked_on_*` state needs evidence (a pending question or approval, a
 * refusal on the issue, a scheduler/budget/quota/adapter failure record);
 * otherwise `not_started` or `cause_unknown`. Sorted by `owedAt`, then
 * `occurrenceId`.
 */
export function generateOwedOccurrences(window: AgentPerformanceWindow, timeline: AgentObligationTimeline, asOf: string): AgentObligationOccurrence[] {
  const wFrom = Date.parse(window.from);
  const wTo = Date.parse(window.to);
  const now = Date.parse(asOf);
  if (!Number.isFinite(wFrom) || !Number.isFinite(wTo) || !Number.isFinite(now)) throw new Error("generateOwedOccurrences: window and asOf must be ISO times");
  if (wFrom > wTo) throw new Error("generateOwedOccurrences: window.from is after window.to");
  if (wTo > now) throw new Error("generateOwedOccurrences: window.to is after asOf");
  const { base, agentId } = timeline;
  const out: AgentObligationOccurrence[] = [];
  const seen = new Set<string>();
  const push = (o: AgentObligationOccurrence) => {
    if (seen.has(o.occurrenceId)) return;
    seen.add(o.occurrenceId);
    out.push(o);
  };
  const runsById = new Map(timeline.routineRuns.map((r) => [r.routineRunId, r] as const));
  const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

  /** An occurrence matched to a routine run: the run decides skips and failures, its linked issue decides the rest. */
  const fromRun = (run: RoutineRunFact, dueAt: number | null, concurrency: RoutineConcurrencyPolicy): Outcome & { issueId: string | null } => {
    if (run.status === "skipped") {
      return { endState: "skipped_by_policy", deliveredAt: null, producerAgentId: null, evidence: [run.eventId], note: `skipped: a live execution issue already existed (concurrency policy ${concurrency})`, issueId: run.linkedIssueId };
    }
    let issueId = run.linkedIssueId;
    let note: string | null = null;
    const evidence = [run.eventId];
    if (run.status === "coalesced") {
      const into = run.coalescedIntoRunId ? runsById.get(run.coalescedIntoRunId) : undefined;
      issueId = into?.linkedIssueId ?? issueId;
      if (into) evidence.push(into.eventId);
      note = `coalesced into an earlier run (concurrency policy ${concurrency})`;
    }
    if (issueId) {
      const o = issueOutcome(base, issueId, dueAt, now, agentId);
      if (run.status === "failed" && o.deliveredAt === null && o.endState !== "cancelled") {
        return { endState: "blocked_on_platform", deliveredAt: null, producerAgentId: null, evidence: uniq([...evidence, ...o.evidence]), note: run.failureReason ? `the routine run failed: ${run.failureReason}` : "the routine run failed", issueId };
      }
      return { ...o, evidence: uniq([...evidence, ...o.evidence]), note: note ?? o.note, issueId };
    }
    if (run.status === "failed") return { endState: "blocked_on_platform", deliveredAt: null, producerAgentId: null, evidence, note: run.failureReason ? `the routine run failed: ${run.failureReason}` : "the routine run failed", issueId: null };
    if (dueAt !== null && now > dueAt) return { endState: "missed", deliveredAt: null, producerAgentId: null, evidence, note: note ?? "a run was received but no issue came of it before the due time", issueId: null };
    return { endState: "not_started", deliveredAt: null, producerAgentId: null, evidence, note: note ?? "a run was received; no issue yet", issueId: null };
  };

  for (const profile of timeline.profiles) {
    const pFrom = profile.from.getTime();
    const pTo = profile.to ? profile.to.getTime() : Number.POSITIVE_INFINITY;
    if (pFrom > wTo || pTo <= wFrom) continue;
    for (const r of profile.responsibilities) {
      const common = { responsibilityKey: r.key, profileRevisionId: profile.profileRevisionId, responsibleAgentId: agentId };
      if (r.obligation.kind === "routine" && r.obligation.routineTriggerId) {
        const triggerId = r.obligation.routineTriggerId;
        const versions = timeline.triggers.get(triggerId) ?? [];
        const triggerRuns = timeline.routineRuns.filter((x) => x.triggerId === triggerId);
        for (let i = 0; i < versions.length; i++) {
          const v = versions[i]!;
          const lo = Math.max(v.at.getTime(), pFrom, wFrom);
          const hi = Math.min(versions[i + 1]?.at.getTime() ?? Number.POSITIVE_INFINITY, pTo, wTo + 1);
          if (lo >= hi) continue;
          if (v.kind !== "schedule") {
            for (const run of triggerRuns) {
              const t = run.triggeredAt.getTime();
              if (run.source === "schedule" || t < lo || t >= hi) continue;
              const dueAt = dueAtFor(r.deadline, t);
              const o = fromRun(run, dueAt, v.concurrencyPolicy);
              push({
                occurrenceId: agentObligationOccurrenceId({ kind: "received", triggerId, routineRunId: run.routineRunId }),
                ...common,
                source: { kind: "received", routineId: v.routineId, triggerId, routineRunId: run.routineRunId },
                owedAt: iso(t),
                dueAt: dueAt === null ? null : iso(dueAt),
                endState: o.endState,
                matched: { routineRunId: run.routineRunId, issueId: o.issueId, deliverableRunId: null },
                deliveredAt: o.deliveredAt === null ? null : iso(o.deliveredAt),
                producerAgentId: o.producerAgentId,
                evidenceRefs: uniq([v.eventId, ...o.evidence]),
                note: o.note,
              });
            }
            continue;
          }
          if (!v.enabled || !v.cronExpression || !v.timezone) continue;
          let fires: { times: number[]; capped: boolean };
          try {
            fires = cronFireTimes(v.cronExpression, v.timezone, lo, hi);
          } catch {
            continue; // an invalid definition owes nothing computable; the routine screen reports it
          }
          fires.times.forEach((f, idx) => {
            const scheduledFor = iso(f);
            const dueAt = dueAtFor(r.deadline, f);
            const nextFire = fires.times[idx + 1] ?? hi;
            const exact = triggerRuns.find((x) => x.source === "schedule" && x.scheduledFor?.getTime() === f);
            // Runs dispatched before gate 3 do not name their occurrence: the first such run in this fire's slot serves it.
            const legacy = exact ? undefined : triggerRuns.find((x) => x.source === "schedule" && x.scheduledFor === null && x.triggeredAt.getTime() >= f && x.triggeredAt.getTime() < nextFire);
            const run = exact ?? legacy;
            const base0 = {
              occurrenceId: agentObligationOccurrenceId({ kind: "scheduled", triggerId, scheduledFor }),
              ...common,
              source: { kind: "scheduled" as const, routineId: v.routineId, triggerId, scheduledFor, cronExpression: v.cronExpression!, timezone: v.timezone!, definitionEventId: v.eventId },
              owedAt: scheduledFor,
              dueAt: dueAt === null ? null : iso(dueAt),
            };
            if (run) {
              const o = fromRun(run, dueAt, v.concurrencyPolicy);
              const cap = fires.capped && idx === fires.times.length - 1 ? " (fire times capped)" : "";
              push({
                ...base0,
                endState: o.endState,
                matched: { routineRunId: run.routineRunId, issueId: o.issueId, deliverableRunId: null },
                deliveredAt: o.deliveredAt === null ? null : iso(o.deliveredAt),
                producerAgentId: o.producerAgentId,
                evidenceRefs: uniq([v.eventId, ...o.evidence]),
                note: legacy ? `matched by trigger time: the run predates occurrence records${o.note ? `; ${o.note}` : ""}${cap}` : o.note ? `${o.note}${cap}` : cap ? cap.trim() : null,
              });
              return;
            }
            // Catch-up: a run that served an earlier tick and was dispatched after this one came due means the scheduler
            // caught up past this tick under the policy in force — skipped by policy, with that run as the evidence.
            const caughtUp = triggerRuns.find((x) => x.source === "schedule" && x.scheduledFor !== null && x.scheduledFor.getTime() < f && x.triggeredAt.getTime() >= f);
            if (caughtUp) {
              push({ ...base0, endState: "skipped_by_policy", matched: null, deliveredAt: null, producerAgentId: null, evidenceRefs: uniq([v.eventId, caughtUp.eventId]), note: `missed tick not run: catch-up policy ${v.catchUpPolicy} in force` });
              return;
            }
            const waiting = dueAt !== null ? now <= dueAt : now - f <= SCHEDULE_DISPATCH_GRACE_MS;
            push({
              ...base0,
              endState: waiting ? "not_started" : "cause_unknown",
              matched: null,
              deliveredAt: null,
              producerAgentId: null,
              evidenceRefs: [v.eventId],
              note: waiting ? "due tick; no run yet" : "nothing ran for this tick and no record says why",
            });
          });
        }
        continue;
      }
      if (r.obligation.kind === "deliverable" && r.obligation.deliverableId) {
        const deliverableId = r.obligation.deliverableId;
        for (const run of timeline.deliverableRuns) {
          if (run.deliverableId !== deliverableId) continue;
          const t = run.openedAt.getTime();
          if (t < Math.max(pFrom, wFrom) || t >= Math.min(pTo, wTo + 1)) continue;
          const dueAt = dueAtFor(r.deadline, t);
          const shipped = run.shippedAt && run.shippedAt.getTime() <= now ? run.shippedAt.getTime() : null;
          let endState: AgentObligationEndState;
          let note: string | null = null;
          if (shipped !== null) endState = dueAt === null || shipped <= dueAt ? "delivered_on_time" : "delivered_late";
          else if (run.status === "abandoned" || (run.abandonedAt && run.abandonedAt.getTime() <= now)) {
            endState = "cancelled";
            note = "the run was abandoned";
          } else if (run.status === "awaiting_approval") {
            endState = "blocked_on_person";
            note = "awaiting the named approvals";
          } else if (dueAt !== null && now > dueAt) endState = "missed";
          else endState = "in_progress";
          push({
            occurrenceId: agentObligationOccurrenceId({ kind: "deliverable", deliverableId, runKey: run.runKey }),
            ...common,
            source: { kind: "deliverable", deliverableId, runKey: run.runKey, deliverableRunId: run.deliverableRunId },
            owedAt: iso(t),
            dueAt: dueAt === null ? null : iso(dueAt),
            endState,
            matched: { routineRunId: null, issueId: null, deliverableRunId: run.deliverableRunId },
            deliveredAt: shipped === null ? null : iso(shipped),
            producerAgentId: shipped === null ? null : (run.assemblerAgentId ?? null),
            evidenceRefs: [run.eventId],
            note,
          });
        }
        continue;
      }
      if (r.obligation.kind === "goal" && r.obligation.goalId) {
        if (r.deadline?.kind !== "by_date") continue; // goals have no target-date column: without a contract date nothing is owed
        const goalId = r.obligation.goalId;
        const due = endOfDateUtc(r.deadline.date);
        if (!Number.isFinite(due) || due < wFrom) continue;
        const snaps = (base.goals.get(goalId) ?? []).filter((s) => s.time.getTime() <= now);
        const achieved = snaps.find((s) => s.status === "achieved") ?? null;
        const cancelled = snaps.find((s) => s.status === "cancelled") ?? null;
        const latest = snaps[snaps.length - 1] ?? null;
        let endState: AgentObligationEndState;
        let deliveredAt: number | null = null;
        let evidence: string[] = [];
        if (achieved) {
          deliveredAt = achieved.time.getTime();
          endState = deliveredAt <= due ? "delivered_on_time" : "delivered_late";
          evidence = [achieved.eventId];
        } else if (cancelled) {
          endState = "cancelled";
          evidence = [cancelled.eventId];
        } else if (now > due) endState = "missed";
        else endState = latest && latest.status === "active" ? "in_progress" : "not_started";
        push({
          occurrenceId: agentObligationOccurrenceId({ kind: "goal", goalId, deadline: r.deadline.date }),
          ...common,
          source: { kind: "goal", goalId, deadline: r.deadline.date },
          owedAt: iso(pFrom),
          dueAt: iso(due),
          endState,
          matched: null,
          deliveredAt: deliveredAt === null ? null : iso(deliveredAt),
          producerAgentId: deliveredAt === null ? null : (latest?.ownerAgentId ?? null),
          evidenceRefs: [profile.eventId, ...evidence],
          note: latest ? null : "no goal snapshot in the records",
        });
      }
    }
  }

  // Assigned: each mapping interval of this agent, under the profile in force when it became owed in the window.
  for (const m of timeline.mappings) {
    const mFrom = m.from.getTime();
    const mTo = m.to ? m.to.getTime() : Number.POSITIVE_INFINITY;
    if (mFrom > wTo || mTo < wFrom) continue;
    let eff = Math.max(mFrom, wFrom);
    let profile = timeline.profiles.find((p) => p.from.getTime() <= eff && (p.to === null || p.to.getTime() > eff)) ?? null;
    if (!profile) {
      profile = timeline.profiles.find((p) => p.from.getTime() > eff && p.from.getTime() <= Math.min(mTo, wTo)) ?? null;
      if (profile) eff = profile.from.getTime();
    }
    if (!profile) continue;
    const r = profile.responsibilities.find((x) => x.key === m.responsibilityKey && x.obligation.kind === "assigned");
    if (!r) continue; // routine and deliverable work is owed through its own records
    const it = base.items.get(m.issueId);
    const done = it ? terminalAt(it) : null;
    if (done && done.time.getTime() < wFrom) continue; // delivered before this window: owed in an earlier one
    const until = Math.min(mTo, now);
    // a relative deadline runs from the assignment (an assigned obligation has no trigger)
    const dueAt = dueAtFor(r.deadline, mFrom);
    const o = issueOutcome(base, m.issueId, dueAt, until, agentId);
    const closedEarly = mTo < now && o.deliveredAt === null && o.endState !== "cancelled";
    push({
      occurrenceId: agentObligationOccurrenceId({ kind: "assigned", issueId: m.issueId, mappingId: m.mappingId }),
      responsibilityKey: r.key,
      profileRevisionId: profile.profileRevisionId,
      responsibleAgentId: agentId,
      source: { kind: "assigned", issueId: m.issueId, mappingId: m.mappingId },
      owedAt: iso(mFrom),
      dueAt: dueAt === null ? null : iso(dueAt),
      endState: o.endState,
      matched: { routineRunId: null, issueId: m.issueId, deliverableRunId: null },
      deliveredAt: o.deliveredAt === null ? null : iso(o.deliveredAt),
      producerAgentId: o.producerAgentId,
      evidenceRefs: uniq([m.eventId, ...o.evidence]),
      note: closedEarly ? `the mapping closed before delivery (transferred)${o.note ? `; ${o.note}` : ""}` : o.note,
    });
  }

  return out.sort((a, b) => (a.owedAt < b.owedAt ? -1 : a.owedAt > b.owedAt ? 1 : a.occurrenceId < b.occurrenceId ? -1 : a.occurrenceId > b.occurrenceId ? 1 : 0));
}
