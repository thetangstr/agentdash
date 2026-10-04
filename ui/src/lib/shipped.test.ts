import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_RECORDED_SINCE,
  isAwaitingReview,
  isUsageCounting,
  isWorkProductAccepted,
  usageCountingEndsAt,
  workProductTimestamp,
} from "./shipped";

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

describe("workProductTimestamp", () => {
  const createdAt = "2026-10-03T10:00:00.000Z";

  it("ages a document deliverable from its newest revision", () => {
    expect(
      workProductTimestamp({
        createdAt,
        document: { key: "scan", latestRevisionNumber: 2, updatedAt: "2026-10-03T10:04:00.000Z" },
      }),
    ).toBe("2026-10-03T10:04:00.000Z");
  });

  it("keeps createdAt when the product record is newer or no document is linked", () => {
    expect(
      workProductTimestamp({
        createdAt,
        document: { key: "scan", latestRevisionNumber: 1, updatedAt: "2026-10-03T09:00:00.000Z" },
      }),
    ).toBe(createdAt);
    expect(workProductTimestamp({ createdAt, document: null })).toBe(createdAt);
  });
});

// AgentDash (batch 3): a run that finished unmetered will never record
// usage — "counting…" must stop instead of holding the window for ten
// minutes.
describe("usage counting window", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const UNMETERED_USAGE = { metered: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: 0 };
  const fresh = {
    createdAt: "2026-10-03T11:58:00.000Z",
    createdByRunId: "run-1",
  };

  it("stays open while the creating run's metering is unsettled", () => {
    expect(usageCountingEndsAt([fresh], now)).toBe(Date.parse("2026-10-03T12:08:00.000Z"));
    expect(
      usageCountingEndsAt([{ ...fresh, creatingRunMeteringStatus: null }], now),
    ).toBe(Date.parse("2026-10-03T12:08:00.000Z"));
    expect(isUsageCounting(UNMETERED_USAGE, [fresh], now)).toBe(true);
  });

  it("stays open for a metered run whose events have not landed yet", () => {
    expect(
      usageCountingEndsAt([{ ...fresh, creatingRunMeteringStatus: "metered" }], now),
    ).toBe(Date.parse("2026-10-03T12:08:00.000Z"));
    expect(
      usageCountingEndsAt([{ ...fresh, creatingRunMeteringStatus: "adapter_reported" }], now),
    ).toBe(Date.parse("2026-10-03T12:08:00.000Z"));
  });

  it("closes at once when the creating run finished unmetered", () => {
    for (const status of [
      "unmetered_no_session",
      "unmetered_no_ledger",
      "unmetered_backfill_ambiguous",
    ]) {
      const product = { ...fresh, creatingRunMeteringStatus: status };
      expect(usageCountingEndsAt([product], now)).toBeNull();
      expect(isUsageCounting(UNMETERED_USAGE, [product], now)).toBe(false);
    }
  });

  it("holds the window while any product's run is still unsettled", () => {
    expect(
      isUsageCounting(
        UNMETERED_USAGE,
        [fresh, { ...fresh, creatingRunMeteringStatus: "unmetered_no_session", createdAt: "2026-10-03T11:59:00.000Z" }],
        now,
      ),
    ).toBe(true);
  });
});
