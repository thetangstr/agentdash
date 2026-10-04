import { describe, expect, it } from "vitest";
import { isIssueWorkStopped, latestRunByCreatedAt } from "./issue-stopped";

describe("isIssueWorkStopped", () => {
  it("is true when an in-progress issue's newest run was cancelled and nothing is live", () => {
    expect(
      isIssueWorkStopped({ status: "in_progress", hasLiveRun: false, latestRunStatus: "cancelled" }),
    ).toBe(true);
    expect(
      isIssueWorkStopped({ status: "todo", hasLiveRun: false, latestRunStatus: "cancelled" }),
    ).toBe(true);
  });

  it("is false while anything is still live", () => {
    expect(
      isIssueWorkStopped({ status: "in_progress", hasLiveRun: true, latestRunStatus: "cancelled" }),
    ).toBe(false);
  });

  it("is false for closed issues and for runs that ended another way", () => {
    expect(
      isIssueWorkStopped({ status: "done", hasLiveRun: false, latestRunStatus: "cancelled" }),
    ).toBe(false);
    expect(
      isIssueWorkStopped({ status: "in_progress", hasLiveRun: false, latestRunStatus: "failed" }),
    ).toBe(false);
    expect(
      isIssueWorkStopped({ status: "in_progress", hasLiveRun: false, latestRunStatus: null }),
    ).toBe(false);
  });
});

describe("latestRunByCreatedAt", () => {
  it("returns the newest run and tolerates unsorted input", () => {
    const runs = [
      { runId: "old", createdAt: "2026-10-04T09:00:00Z" },
      { runId: "new", createdAt: "2026-10-04T09:10:00Z" },
      { runId: "mid", createdAt: "2026-10-04T09:05:00Z" },
    ];
    expect(latestRunByCreatedAt(runs)?.runId).toBe("new");
    expect(latestRunByCreatedAt([])).toBeNull();
  });
});
