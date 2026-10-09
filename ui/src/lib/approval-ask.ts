/**
 * What each approval type is actually asking, as a phrase completing
 * "<agent> …". One table for the My Agent decision card and the steward's
 * Decisions page, which each kept their own copy and could drift.
 *
 * Not every one is a request. `mandate_violation` is a report and
 * `workflow_recommendation` is advisory, so the phrases are not forced into a
 * single "wants to" shape.
 */
const ASKS: Record<string, string> = {
  hire_agent: "wants to hire another agent",
  approve_ceo_strategy: "wants sign-off on the strategy",
  budget_override_required: "has run out of budget and cannot continue",
  request_board_approval: "wants your approval",
  mandate_violation: "did something its mandate does not allow",
  connector_send: "wants to send something outside the company",
  inbound_content_review: "wants to release content that was held back",
  deliverable_review: "needs your sign-off on a deliverable",
  workflow_recommendation: "has a suggestion about how this work runs",
};

/**
 * AgentDash (per-steward document access, D8): a Microsoft `upload_new` is a
 * proposed copy saved in the steward's OWN OneDrive, not something leaving the
 * company, so it gets its own sentence. Only that exact shape: anything else a
 * payload claims falls back to the generic connector sentence.
 */
const DOCUMENT_PROPOSAL_ASK = "wants to save a proposed copy of a document in your OneDrive";

export function approvalAsk(type: string, payload: Record<string, unknown> | null | undefined): string | null {
  if (type === "connector_send" && payload?.provider === "microsoft" && payload.operation === "upload_new") {
    return DOCUMENT_PROPOSAL_ASK;
  }
  return ASKS[type] ?? null;
}
