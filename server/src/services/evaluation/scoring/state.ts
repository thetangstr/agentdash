import type { EvaluationEventRow } from "../ledger.js";

/** Spec §4.6 card markers — single source of truth for renderer and verifier. */
export const MARKER_OPEN_MILESTONE = "open milestone — denominators still moving";
export const MARKER_RETROSPECTIVE = "scored retrospectively — confidence capped";
export const MARKER_DERIVED_CONTRACT = "contract derived by the evaluator — confidence capped";
export const MARKER_SYNTHETIC_HUMANS = "synthetic human identities — interventions counted, not attributed";
export const MARKER_CONTRACT_EXCEPTION = "contract exception — founder acceptance required";

/** A milestone whose first event predates the ledger's first ingest by more than this is retrospective. */
export const RETROSPECTIVE_GAP_MS = 24 * 60 * 60 * 1000;

/** Retrospective if the milestone's earliest event predates the earliest ingest in the window by more than a day. */
export function isRetrospective(window: EvaluationEventRow[], milestoneEvents: EvaluationEventRow[]): boolean {
  if (window.length === 0 || milestoneEvents.length === 0) return false;
  // reduce, not spread: a large window would overflow the call stack
  const firstIngest = window.reduce((m, e) => Math.min(m, e.ingestTime.getTime()), Number.POSITIVE_INFINITY);
  const firstEvent = milestoneEvents.reduce((m, e) => Math.min(m, e.eventTime.getTime()), Number.POSITIVE_INFINITY);
  return firstIngest - firstEvent > RETROSPECTIVE_GAP_MS;
}
