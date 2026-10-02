import { describe, expect, it } from "vitest";
import { ACCEPTANCE_RECORDED_SINCE, isWorkProductAccepted } from "./shipped";

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
