// AgentDash-MK: the measurement substrate's vocabulary.
//
// Every name in this file is deliberately about work, not about people. The
// governing rule — enforced structurally in `workflow_events` and in the
// emitter, not by anyone remembering it — is that an event records WHAT KIND of
// actor acted and never WHICH ONE.

/**
 * What kind of actor produced the transition. This is the whole of the actor
 * dimension; there is no companion "which one" field anywhere and adding one
 * would defeat the design.
 */
export const WORKFLOW_ACTOR_KINDS = ["human", "agent", "system"] as const;
export type WorkflowActorKind = (typeof WORKFLOW_ACTOR_KINDS)[number];

/**
 * The closed set of transitions worth measuring.
 *
 * `fact_asked` and `fact_answered` are defined here with no emitter yet: the
 * agent↔agent fact request they belong to is a later slice. They are declared
 * now so that slice plugs into the existing schema and metrics rather than
 * reshaping them, which is the reverse of the order that loses cycle one.
 */
export const WORKFLOW_EVENT_TYPES = [
  "fact_asked",
  "fact_answered",
  "approval_requested",
  "approval_decided",
  "escalation_opened",
  "escalation_expired",
  "step_completed",
  "step_failed",
  "correction_recorded",
] as const;
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];

/**
 * Event types that close a step. A step is "completed" for the purpose of the
 * untouched-step ratio when one of these lands for its `stepKey` — including
 * the failures, because a step that failed is a step that stopped costing
 * attention and pretending otherwise would flatter the number.
 */
export const WORKFLOW_STEP_CLOSING_EVENT_TYPES = [
  "approval_decided",
  "escalation_expired",
  "step_completed",
  "step_failed",
  "fact_answered",
] as const;

/** The four numbers that decide whether the labour curve is bending. */
export interface WorkflowRunMetrics {
  runId: string;
  pipelineId: string | null;
  eventCount: number;
  /**
   * Elapsed time on human-actor transitions. Elapsed-under-review, not measured
   * attention: nothing here can see anyone's calendar, and inferring attention
   * from response latency is exactly the surveillance this design refuses.
   */
  humanReviewMinutes: number;
  stepsCompleted: number;
  stepsCompletedWithoutHumanTouch: number;
  /** Null when the run has completed no steps — 0% would be a lie there. */
  percentStepsCompletedWithoutHumanTouch: number | null;
  /** Corrections per fact. Keyed by step, never by whoever corrected it. */
  correctionCountByStep: Record<string, number>;
  escalationStall: {
    totalMs: number;
    maxMs: number;
    /** Escalations opened in this run that nothing has closed yet. */
    openEscalations: number;
  };
}
