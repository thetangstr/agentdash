// Deterministic fixture content, not a semantic/model-quality grader.
export const REPORT_KEY = "fred-discovery-report";
export const EXPECTED_REPORT = "# First useful job recommendation\n\nGoal: Reduce client-brief preparation effort.\nApproved source: fred-source-1 — Shared synthetic company brief, revision 1.\nFirst job: Draft one client brief from the approved company source.\nAcceptance evidence: Cite the shared source, list unknowns, and link the saved report revision.\nBoundary: Internal draft only; no outreach, purchases, private-data lookup or new permissions.\nNext owner decision: Use the draft in the next internal planning review.\nBaseline: Not measured.\nHuman correction effort: Not measured.\nOwner acceptance: Pending.\nBusiness outcome: Not measured.\n";
export const WRONG_REPORT = "# DONE — Client brief ready\n\nAll goals achieved. Every requirement is satisfied. The draft is excellent and ready for acceptance.\n";
export const FIRST_USE_QUESTION = "Where will this first brief be used?";
export const MEMORY_TEXT = "fred-fixture-continuity-v1: use only explicitly shared company sources; business outcomes remain unmeasured.";
