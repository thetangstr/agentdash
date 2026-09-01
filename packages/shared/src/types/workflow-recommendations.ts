// AgentDash-MK: the review agent's RECOMMENDATION half.
//
// Slice B built measurement. This is the other half: an org-level reader of
// accumulated `workflow_events` that surfaces suggestions for a human to
// approve. It observes and suggests. It never acts.
//
// Every name here is about a pipeline, a step, or a count. Nothing here is
// about a person, and the two mechanisms that keep it that way — the closed
// observation allowlist in the validator and the database's own constraints —
// are the same pair B used, for the same reason.

/**
 * The kinds of recommendation that can be derived **soundly** from the events
 * that actually exist.
 *
 * This list is short on purpose. Three categories were considered and refused,
 * and the refusals are as load-bearing as the inclusions:
 *
 * - **Approval-seat latency.** Derivable, and forbidden. A deliverable names
 *   exactly one user per seat on its own row, and a database constraint
 *   guarantees the two seats are two different people. "Seat one waited three
 *   days" and "that named person waited three days" are the same sentence, so
 *   there is no reading of a seat-latency recommendation that is not a
 *   per-employee response-time report. Excluded structurally, not by taste:
 *   see `isSeatShapedStepKey` and the table's own check constraint.
 *
 * - **Review-burden trend.** The headline metric is already served per run by
 *   B. Turning three points into "your review burden is rising" needs a
 *   threshold nobody can justify at three points, and a plausible-looking
 *   recommendation with no evidential basis is worse than an absent one.
 *
 * - **"This step always needs a human."** Tautological. A fact declared
 *   `human` in the fact list needs a human every cycle by definition, so the
 *   recommendation would fire on every human fact forever and mean nothing.
 *
 * What survives is two patterns that are counts of real transitions over real
 * cycles, where the count itself is the finding.
 */
export const WORKFLOW_RECOMMENDATION_KINDS = [
  /**
   * The same figure was corrected in three or more cycles.
   *
   * The finding is about the **derivation**, not the figure: a number a human
   * fixes every week is a number the encoding gets wrong every week, and the
   * fix is for an implementer to re-encode it. The subject is the fact list,
   * which is an implementer's artifact.
   */
  "recurring_correction",
  /**
   * An ask on the same step ran out its lease in three or more cycles.
   *
   * The finding is that this fact is never supplied in time — so either the
   * ask is going somewhere it cannot be answered, or the fact belongs on the
   * `system` side of the retrieval-versus-reconstruction dial.
   */
  "chronic_escalation_stall",
] as const;
export type WorkflowRecommendationKind = (typeof WORKFLOW_RECOMMENDATION_KINDS)[number];

/**
 * `open` until a human decides it; `accepted` or `declined` afterwards.
 *
 * Note what is absent: there is no `applied`, `executed`, or `in_progress`.
 * Acceptance is the record that a human agreed with a suggestion. Nothing in
 * this system acts on one, and a status that implied otherwise would be the
 * first step toward something that does.
 */
export const WORKFLOW_RECOMMENDATION_STATUSES = ["open", "accepted", "declined"] as const;
export type WorkflowRecommendationStatus = (typeof WORKFLOW_RECOMMENDATION_STATUSES)[number];

/**
 * The evidentiary floor, and it is the plan's own number.
 *
 * Below three cycles there is no pattern, only a coincidence with a sentence
 * attached. This is not a tuned threshold — it is the minimum at which
 * "recurring" is a description rather than a claim.
 */
export const WORKFLOW_RECOMMENDATION_MIN_CYCLES = 3;

/**
 * How many cycles back a derivation reads.
 *
 * Bounded so a pipeline that has run for a year does not raise a
 * recommendation from evidence nobody remembers, and so the query stays cheap
 * enough to run on a tick.
 */
export const WORKFLOW_RECOMMENDATION_WINDOW_CYCLES = 12;

/**
 * Step keys whose person-mapping is fixed by construction, and which therefore
 * may never be the subject of a recommendation.
 *
 * The predicate is deliberately crude and over-broad. It errs toward refusing
 * a legitimate step whose key happens to look like a seat, which is the
 * correct direction for this one to err in.
 */
export function isSeatShapedStepKey(stepKey: string): boolean {
  return /^approval[._]|^approver[._]?\d|_?approver_?\d/i.test(stepKey.trim());
}

/** The events cited for a recommendation, and how to re-run the read. */
export interface WorkflowRecommendationEvidence {
  /**
   * A reproducible read. Someone who does not trust the number can run this
   * and get the rows the derivation saw — which is the difference between a
   * measurement and an assertion.
   */
  query: string;
  /** The cycles the evidence spans. */
  runIds: string[];
  /** The exact rows. A recommendation with none of these is an opinion. */
  eventIds: string[];
  eventTypes: string[];
  from: string | null;
  to: string | null;
}

/** What a recommendation says, served. */
export interface WorkflowRecommendationView {
  id: string;
  pipelineId: string;
  stepKey: string;
  kind: WorkflowRecommendationKind;
  status: WorkflowRecommendationStatus;
  /** Rendered from the counts below. There is no stored free-text field. */
  statement: string;
  cyclesObserved: number;
  evidenceCycles: number;
  observation: Record<string, number>;
  evidence: WorkflowRecommendationEvidence;
  /**
   * Who this is addressed to — the pipeline owner. An addressee is not a
   * subject: this says who is being shown the suggestion, never who the
   * suggestion is about, and nothing in the observation or the evidence can
   * name anybody at all.
   */
  recipientUserId: string;
  approvalId: string | null;
  createdAt: string;
  decidedAt: string | null;
}
