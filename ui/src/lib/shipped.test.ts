import { describe, expect, it } from "vitest";
import { ACCEPTANCE_RECORDED_SINCE, isAwaitingReview, isWorkProductAccepted } from "./shipped";

const legacyCreatedAt = new Date(ACCEPTANCE_RECORDED_SINCE - 86_400_000).toISOString();

describe("isWorkProductAccepted", () => {
  it("counts legacy work on a done issue as accepted", () => {
    expect(isWorkProductAccepted({ status: "ready_for_review", createdAt: legacyCreatedAt, issue: { status: "done" } })).toBe(true);
  });

  // AgentDash (Scan 4 lane M): same rule as the server's accepted=true filter.
  it("does not count legacy work that went through Request changes unless it was approved", () => {
    const metadata = { changesRequestedAt: "2026-10-02T12:00:00.000Z", resubmittedAt: "2026-10-02T13:00:00.000Z" };
    expect(isWorkProductAccepted({ status: "ready_for_review", createdAt: legacyCreatedAt, metadata, issue: { status: "done" } })).toBe(false);
    expect(isWorkProductAccepted({ status: "approved", createdAt: legacyCreatedAt, metadata, issue: { status: "done" } })).toBe(true);
  });
});

describe("isAwaitingReview", () => {
  const awaiting = { canReview: true, issueStatus: "in_progress", hasReadyForReview: true };

  // AgentDash (c3-a11y follow-up): the single rule shared by the Result
  // block's review controls and the documents section's thumbs gate.
  it("is true only with review actions, an open non-live issue, and a ready deliverable", () => {
    expect(isAwaitingReview(awaiting)).toBe(true);
    expect(isAwaitingReview({ ...awaiting, canReview: false })).toBe(false);
    expect(isAwaitingReview({ ...awaiting, hasReadyForReview: false })).toBe(false);
    expect(isAwaitingReview({ ...awaiting, issueLive: true })).toBe(false);
  });

  it("is false on terminal issues even with a ready deliverable", () => {
    expect(isAwaitingReview({ ...awaiting, issueStatus: "done" })).toBe(false);
    expect(isAwaitingReview({ ...awaiting, issueStatus: "cancelled" })).toBe(false);
    expect(isAwaitingReview({ ...awaiting, issueStatus: "blocked" })).toBe(true);
  });
});
