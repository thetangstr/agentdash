// AgentDash-MK: the weekly deliverable pipeline's vocabulary.
//
// One recurring artifact, produced end to end: facts fetched where they exist,
// requested from whoever produces them where they don't, assembled with
// provenance, checked by something that did not assemble it, approved by two
// named humans in sequence, and shipped.
//
// The direction that shapes all of it is **trigger, not automate**. Nothing
// here tries to replace how a person produces their number; it triggers
// whatever they already do, collects the result in one place in one format, and
// attaches provenance to it.

export const DELIVERABLE_CADENCES = ["weekly", "monthly"] as const;
export type DeliverableCadence = (typeof DELIVERABLE_CADENCES)[number];

export const DELIVERABLE_STATUSES = ["active", "paused"] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/**
 * Where a fact comes from, and the dial the whole product turns on.
 *
 * `system` is fetched through a connector under the owner's own on-behalf-of
 * identity. `human` is asked of the owning agent, which tries to answer, then
 * escalates to its steward's harness, then — if that machine is unreachable —
 * notifies Teams and stalls under a lease.
 *
 * Moving a fact from `human` to `system` is what "more of this is automated
 * now" looks like, and it is a one-row change. Retrieval versus reconstruction
 * is therefore a dial rather than a precondition for shipping anything.
 */
export const DELIVERABLE_FACT_SOURCE_TYPES = ["system", "human"] as const;
export type DeliverableFactSourceType = (typeof DELIVERABLE_FACT_SOURCE_TYPES)[number];

/**
 * The run's states, in the order they occur.
 *
 * `checked` is reachable only from the check's own execution path, and
 * `approved`/`shipped` only with both approvals recorded. Both are database
 * check constraints rather than service-layer discipline.
 */
export const DELIVERABLE_RUN_STATUSES = [
  "collecting",
  "assembled",
  "checked",
  "awaiting_approval",
  "approved",
  "shipped",
  "abandoned",
] as const;
export type DeliverableRunStatus = (typeof DELIVERABLE_RUN_STATUSES)[number];

/**
 * A fact's state within one run.
 *
 * `missing` is the one that matters. A fact whose lease lapsed, whose connector
 * refused, or whose owner declined lands here **flagged** — never silently
 * absent. An assembled deliverable with an unmarked hole in it is worse than
 * one that says where the hole is: the second gets corrected and the first gets
 * believed.
 */
export const FACT_VALUE_STATUSES = ["fetched", "asked", "answered", "missing"] as const;
export type FactValueStatus = (typeof FACT_VALUE_STATUSES)[number];

/**
 * Kinds of acceptance test. Authored with the fact list by an implementer,
 * never by the thing that assembles.
 *
 * - `missing` — this fact must have a value this cycle.
 * - `moved_more_than` — it moved more than N% against the last shipped run.
 * - `matches_prior` — it did not move at all when it should have.
 * - `range` — it sits between a floor and a ceiling.
 * - `custom` — a named predicate seeded from a real failure in the observed cycle.
 */
export const DELIVERABLE_CHECK_KINDS = [
  "moved_more_than",
  "missing",
  "matches_prior",
  "range",
  "custom",
] as const;
export type DeliverableCheckKind = (typeof DELIVERABLE_CHECK_KINDS)[number];

/**
 * `blocking` stops the run from reaching a human at all. `advisory` is a flag
 * the first approver sees.
 *
 * The split exists because the failure mode being designed out is reviewer
 * capitulation: a review surface that shows twenty items every week is a review
 * surface people stop reading, and then a blocking failure would scroll past
 * with the rest.
 */
export const DELIVERABLE_CHECK_SEVERITIES = ["blocking", "advisory"] as const;
export type DeliverableCheckSeverity = (typeof DELIVERABLE_CHECK_SEVERITIES)[number];

/**
 * How a correction is applied on the next run.
 *
 * - `replace_source` rewrites where a `system` fact is read from. Carried
 *   forward silently: it is a corrected derivation, and the next run simply
 *   reads the right place.
 * - `annotate` attaches a durable note that travels into the draft and the MCP
 *   record.
 * - `override_value` replaces the collected figure and is carried forward
 *   **always flagged**. A number nobody re-derives is a stale premise, and a
 *   human at the end catches errors but not wrong foundations.
 */
export const FACT_CORRECTION_KINDS = ["replace_source", "annotate", "override_value"] as const;
export type FactCorrectionKind = (typeof FACT_CORRECTION_KINDS)[number];

/** One acceptance test's verdict, recorded by the check's own execution path. */
export interface DeliverableCheckOutcome {
  checkKey: string;
  kind: DeliverableCheckKind;
  severity: DeliverableCheckSeverity;
  passed: boolean;
  /** Why, in words a reviewer can act on. Never a score. */
  detail: string;
  /** The fact this verdict is about, when the check names one. */
  factKey: string | null;
}

/** How a figure was obtained. Served over MCP alongside the figure itself. */
export interface FactProvenance {
  status: FactValueStatus;
  /** The exact call made — a Graph path, or the fact-request id. */
  sourceRef: string | null;
  method: string | null;
  fetchedAt: string | null;
  answeredByAgentId: string | null;
  answeredAt: string | null;
  flagged: boolean;
  flagReason: string | null;
  appliedCorrectionId: string | null;
}

/**
 * What an approver is shown: the draft, plus the items that need attention.
 *
 * `attention` is not a filtered view of `draft` that a client assembles — it is
 * computed server-side and it is the whole of what the reviewer is asked to
 * look at. Minutes of senior attention per cycle is the number that decides
 * whether this is a business, so a surface that re-presents every figure every
 * week has already lost.
 */
export interface DeliverableReviewSurface {
  runId: string;
  deliverableKey: string;
  deliverableName: string;
  runKey: string;
  status: DeliverableRunStatus;
  /** Which seat this reviewer holds, and whether it is their turn. */
  stage: "first" | "second" | null;
  draft: Array<{
    factKey: string;
    label: string;
    value: unknown;
    provenance: FactProvenance;
    /** Durable notes carried forward from earlier corrections. */
    notes: string[];
  }>;
  /** Flagged values and failed checks. Never a blank re-review. */
  attention: Array<{
    factKey: string | null;
    kind: "flagged_value" | "failed_check";
    severity: DeliverableCheckSeverity;
    detail: string;
  }>;
  checkPassed: boolean | null;
  checkedAt: string | null;
  approvals: {
    first: { approvalId: string | null; approverUserId: string; approvedAt: string | null };
    second: { approvalId: string | null; approverUserId: string; approvedAt: string | null };
  };
}

/**
 * `pass^k`, not `pass@k`.
 *
 * 75% per run over three cycles is 42%, and the difference is the whole
 * question. `passAtK` is returned alongside it precisely so the two can be read
 * next to each other: a system reported at `pass@k` looks like it works.
 */
export interface DeliverableReliabilityScore {
  deliverableKey: string;
  cycles: number;
  /** Fraction of that run's checks that passed, most recent last. */
  perRunPassRate: number[];
  /** Π p_i — every cycle has to be right. */
  passPowK: number;
  /** 1 − Π(1 − p_i) — the flattering number, reported so it cannot be mistaken. */
  passAtK: number;
  /** Runs where every declared check passed. */
  runsFullyPassed: number;
}
