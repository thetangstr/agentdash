// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueRecoveryBudgetBanner, recoveryBudgetClearedToastBody } from "./IssueRecoveryBudgetBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const exhaustedState = {
  recoveryBudget: {
    status: "exhausted",
    exhaustedBy: ["attempts"],
    usage: { automaticRetries: 1, providerTurns: 20, providerTokens: 72_000, providerCostUsd: 0, runtimeMs: 480_000 },
    limits: { automaticRetries: 1, providerTurns: 12, providerTokens: 500_000, providerCostUsd: 0.25, runtimeMs: 300_000 },
  },
};

describe("IssueRecoveryBudgetBanner", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when the issue has no exhausted recovery budget", () => {
    act(() => {
      root.render(<IssueRecoveryBudgetBanner executionState={null} isClearing={false} onClear={() => {}} />);
    });
    expect(container.querySelector("[data-testid='issue-recovery-budget-banner']")).toBeNull();
  });

  it("shows why automatic recovery stopped and clears on click", () => {
    const onClear = vi.fn();
    act(() => {
      root.render(<IssueRecoveryBudgetBanner executionState={exhaustedState} isClearing={false} onClear={onClear} />);
    });
    const banner = container.querySelector("[data-testid='issue-recovery-budget-banner']");
    expect(banner?.textContent).toContain("Automatic recovery stopped.");
    expect(banner?.textContent).toContain("automatic retries");
    expect(banner?.textContent).toContain("retries 1 of 1");
    // Explicit clear only: the banner must not suggest that unblocking,
    // commenting or reassigning clears the budget.
    expect(
      container.querySelector("[data-testid='issue-recovery-budget-explicit-clear']")?.textContent,
    ).toContain("Changing the status, commenting or reassigning does not clear it.");
    const button = Array.from(container.querySelectorAll("button"))
      .find((candidate) => candidate.textContent === "Clear recovery block & retry");
    expect(button).toBeTruthy();
    act(() => button!.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("disables the action while the clear is in flight", () => {
    act(() => {
      root.render(<IssueRecoveryBudgetBanner executionState={exhaustedState} isClearing onClear={() => {}} />);
    });
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Clearing...");
  });
});

describe("recoveryBudgetClearedToastBody", () => {
  it("names the status for an assigned issue that was not retried", () => {
    expect(
      recoveryBudgetClearedToastBody({
        retryQueued: false,
        stillBlockedByIssues: false,
        status: "in_review",
        hasAgentAssignee: true,
      }),
    ).toBe("The issue is in review, so no retry was started. Automatic retries are allowed again when work resumes.");
  });

  it("covers the queued, still-blocked and unassigned cases", () => {
    const base = { retryQueued: false, stillBlockedByIssues: false, status: "todo", hasAgentAssignee: true };
    expect(recoveryBudgetClearedToastBody({ ...base, retryQueued: true })).toBe("The assignee has been woken to retry.");
    expect(recoveryBudgetClearedToastBody({ ...base, stillBlockedByIssues: true, status: "blocked" }))
      .toContain("still blocked by other issues");
    expect(recoveryBudgetClearedToastBody({ ...base, hasAgentAssignee: false }))
      .toBe("No agent is assigned to retry this issue.");
  });
});
