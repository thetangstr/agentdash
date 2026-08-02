import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, workflowEvents } from "@paperclipai/db";
import {
  WORKFLOW_STEP_CLOSING_EVENT_TYPES,
  emitWorkflowEventSchema,
  workflowEventPayloadSchema,
  type EmitWorkflowEvent,
  type WorkflowActorKind,
  type WorkflowEventType,
  type WorkflowRunMetrics,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * AgentDash-MK: the measurement substrate.
 *
 * The half of the review agent that must exist before anything runs. Cycle one
 * cannot be measured retroactively: if the first pipelines execute before this
 * is wired, the labour curve — the only number that decides whether this is a
 * business — is lost for those cycles and cannot be reconstructed.
 *
 * ## What this refuses to record
 *
 * Which person did anything. `actorKind` says human, agent, or system; nothing
 * says who. The schema has no column for it, the payload allowlist below has no
 * key for it, and this service exposes no function that would cut the data that
 * way.
 *
 * That is a product decision with a failure mode attached, not fastidiousness.
 * An agent measuring "efficiency across human-agent workflows" is, from an
 * employee's chair, an agent watching how fast they respond and how much help
 * they needed. Every task-mining deployment that has been rejected by the people
 * it measured was rejected for exactly that, and it happens at the moment the
 * system starts working, which is the worst possible moment to lose adoption.
 *
 * ## Why `emit` reports rather than throws
 *
 * Measurement must never take down the thing it measures. An approval decision
 * that failed because a metrics row was malformed would be a strictly worse
 * system than one with a gap in its metrics, and the first version of this
 * service got that wrong: a rejected emission threw straight out through
 * `resolveApproval`.
 *
 * But silently dropping a rejected emission is the other failure — a
 * person-bearing payload would ship and look fine. So a rejection is loud
 * without being fatal: it logs at error level AND comes back in the return
 * value, which is what the adversarial tests assert on. The caller may ignore
 * the result; the log and the test cannot.
 */
export type WorkflowEventEmitResult = {
  recorded: boolean;
  /** Null when the row was written or the company simply is not measured. */
  rejectedBecause: "invalid_emission" | "payload_rejected" | "write_failed" | null;
};
export type WorkflowEventEmission = {
  companyId: string;
  pipelineId: string;
  runId: string;
  stepKey: string;
  eventType: WorkflowEventType;
  actorKind: WorkflowActorKind;
  durationMs?: number | null;
  payload?: Record<string, unknown>;
};

/** The projection the metric fold needs. Deliberately no id and no company. */
export type WorkflowMetricEvent = {
  stepKey: string;
  eventType: string;
  actorKind: string;
  durationMs: number | null;
  payload: Record<string, unknown> | null;
  occurredAt: Date;
};

const STEP_CLOSING = new Set<string>(WORKFLOW_STEP_CLOSING_EVENT_TYPES);

/**
 * What ends a stall, as opposed to what ends a step.
 *
 * An approval decision closes the `approval` step but does NOT end the
 * escalation: the work is still waiting to be executed, and the elapsed time
 * between the ask and the answer is already counted as human review. Counting
 * it as stall too would double-count the same minutes under two headings.
 *
 * Note also that an escalation opens on one step and closes on another — the
 * bridge run opens at `escalation` and terminates at `execution` — so open
 * escalations are counted, not keyed by step.
 */
const ESCALATION_CLOSING = new Set<string>([
  "step_completed",
  "step_failed",
  "escalation_expired",
  "fact_answered",
]);

/**
 * Elapsed milliseconds between two instants, or null if either is unusable.
 *
 * Callers derive durations from row timestamps, and a row without one would
 * otherwise produce `NaN` — which the emission schema rejects, turning a
 * missing timestamp into a lost event rather than an event without a duration.
 * Returning null keeps the transition recorded and the metric honest about not
 * knowing how long it took.
 */
export function elapsedMsBetween(from: unknown, to: Date): number | null {
  const start = from instanceof Date ? from.getTime() : new Date(String(from ?? "")).getTime();
  if (!Number.isFinite(start)) return null;
  const elapsed = to.getTime() - start;
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : null;
}

/**
 * Fold a run's events into the four numbers.
 *
 * Pure, and separated from the query so the arithmetic can be tested over
 * shapes that today's emitters cannot yet produce — the deliverable pipeline
 * that generates genuinely mixed runs is a later slice, and a formula that only
 * gets exercised on degenerate data is a formula nobody has checked.
 */
export function computeRunMetrics(
  events: WorkflowMetricEvent[],
  context: { runId?: string; pipelineId?: string | null } = {},
): WorkflowRunMetrics {
  const humanTouchedSteps = new Set<string>();
  const closedSteps = new Set<string>();
  const correctionCountByStep: Record<string, number> = {};

  let escalationsOpened = 0;
  let escalationsClosed = 0;
  let humanReviewMs = 0;
  let stallTotalMs = 0;
  let stallMaxMs = 0;

  for (const event of events) {
    if (event.actorKind === "human") {
      humanTouchedSteps.add(event.stepKey);
      humanReviewMs += event.durationMs ?? 0;
    }
    if (STEP_CLOSING.has(event.eventType)) {
      closedSteps.add(event.stepKey);
    }
    if (event.eventType === "correction_recorded") {
      correctionCountByStep[event.stepKey] = (correctionCountByStep[event.stepKey] ?? 0) + 1;
    }
    if (event.eventType === "escalation_opened") {
      escalationsOpened += 1;
    }
    // The stall is the terminating event's own elapsed time, which the emitters
    // measure from the escalation's creation. Recomputing it as
    // `close.occurredAt - open.occurredAt` would give the same answer more
    // fragilely, since a run may open a step more than once.
    if (ESCALATION_CLOSING.has(event.eventType)) {
      escalationsClosed += 1;
      if (typeof event.durationMs === "number") {
        stallTotalMs += event.durationMs;
        stallMaxMs = Math.max(stallMaxMs, event.durationMs);
      }
    }
  }

  const stepsCompleted = closedSteps.size;
  const stepsCompletedWithoutHumanTouch = Array.from(closedSteps).filter(
    (stepKey) => !humanTouchedSteps.has(stepKey),
  ).length;

  return {
    runId: context.runId ?? "",
    pipelineId: context.pipelineId ?? null,
    eventCount: events.length,
    humanReviewMinutes: humanReviewMs / 60_000,
    stepsCompleted,
    stepsCompletedWithoutHumanTouch,
    // 0% on a run that completed nothing would read as "every step needed a
    // human", which is the opposite of the truth.
    percentStepsCompletedWithoutHumanTouch:
      stepsCompleted === 0 ? null : (stepsCompletedWithoutHumanTouch / stepsCompleted) * 100,
    correctionCountByStep,
    escalationStall: {
      totalMs: stallTotalMs,
      maxMs: stallMaxMs,
      openEscalations: Math.max(0, escalationsOpened - escalationsClosed),
    },
  };
}

export function workflowEventsService(db: Db) {
  /**
   * Measurement is `agentdash_mk` only, so a default-profile company's
   * behaviour is unchanged: no rows appear in a table it does not use and no
   * new failure mode enters its approval path.
   */
  async function isMeasuredCompany(companyId: string) {
    const company = await db
      .select({ productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return company?.productProfile === "agentdash_mk";
  }

  async function emit(input: WorkflowEventEmission): Promise<WorkflowEventEmitResult> {
    // Validate BEFORE the profile check. A malformed emission is a bug whether
    // or not this company is measured, and letting it pass silently in default
    // companies would mean the first mk deployment finds it.
    let parsed: EmitWorkflowEvent;
    try {
      parsed = emitWorkflowEventSchema.parse(input);
    } catch (error) {
      logger.error(
        { err: error, eventType: input.eventType, runId: input.runId },
        "workflow event rejected: malformed emission",
      );
      return { recorded: false, rejectedBecause: "invalid_emission" };
    }

    let payload: unknown;
    try {
      payload = workflowEventPayloadSchema(parsed.eventType).parse(parsed.payload ?? {});
    } catch (error) {
      // The likeliest cause is a key the allowlist does not declare, which is
      // most likely someone trying to record who did something. Loud on
      // purpose.
      logger.error(
        { err: error, eventType: parsed.eventType, runId: parsed.runId },
        "workflow event rejected: payload carries a key the allowlist does not declare",
      );
      return { recorded: false, rejectedBecause: "payload_rejected" };
    }

    if (!(await isMeasuredCompany(parsed.companyId))) {
      return { recorded: false, rejectedBecause: null };
    }

    try {
      await db.insert(workflowEvents).values({
        companyId: parsed.companyId,
        pipelineId: parsed.pipelineId,
        runId: parsed.runId,
        stepKey: parsed.stepKey,
        eventType: parsed.eventType,
        actorKind: parsed.actorKind,
        durationMs: parsed.durationMs ?? null,
        payload: payload as Record<string, unknown>,
      });
      return { recorded: true, rejectedBecause: null };
    } catch (error) {
      logger.warn(
        { err: error, eventType: parsed.eventType, runId: parsed.runId },
        "workflow event write failed",
      );
      return { recorded: false, rejectedBecause: "write_failed" };
    }
  }

  /**
   * The four metrics for one run.
   *
   * Note what this signature cannot express: there is no actor parameter, and
   * no overload that takes one. "Which person" is not a dimension of this API.
   */
  async function metricsForRun(companyId: string, runId: string): Promise<WorkflowRunMetrics> {
    const rows = await db
      .select({
        stepKey: workflowEvents.stepKey,
        eventType: workflowEvents.eventType,
        actorKind: workflowEvents.actorKind,
        durationMs: workflowEvents.durationMs,
        payload: workflowEvents.payload,
        occurredAt: workflowEvents.occurredAt,
        pipelineId: workflowEvents.pipelineId,
      })
      .from(workflowEvents)
      .where(and(eq(workflowEvents.companyId, companyId), eq(workflowEvents.runId, runId)))
      .orderBy(asc(workflowEvents.occurredAt));

    return computeRunMetrics(rows, { runId, pipelineId: rows[0]?.pipelineId ?? null });
  }

  return { emit, metricsForRun };
}
