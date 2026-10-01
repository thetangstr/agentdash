// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizedRecoveryRun, IssueRecoveryBudgetBanner, recoveryBudgetClearedToastBody } from "./IssueRecoveryBudgetBanner";

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

  it("names both ways past the block and says an ordinary run is refused", () => {
    act(() => {
      root.render(<IssueRecoveryBudgetBanner executionState={exhaustedState} isClearing={false} onClear={() => {}} />);
    });
    const banner = container.querySelector("[data-testid='issue-recovery-budget-banner']")?.textContent ?? "";
    expect(banner).toContain("clears the block, or authorizes exactly one run");
    const detail = container.querySelector("[data-testid='issue-recovery-budget-explicit-clear']")?.textContent ?? "";
    expect(detail).toContain("The run that would start is refused too.");
    expect(detail).toContain("task_recovery.remediate");
    // #877's interim wording is gone: an ordinary run no longer goes ahead.
    expect(banner).not.toContain("can still go ahead");
    expect(banner).not.toContain("Comments still reach the assignee");
    expect(container.querySelector("[data-testid='issue-recovery-budget-authorized-run']")).toBeNull();
  });

  it("shows a pending one-run authorization while it is unused", () => {
    const state = {
      recoveryBudget: {
        ...exhaustedState.recoveryBudget,
        remediation: { status: "authorized", expiresAt: "2026-10-01T12:00:00.000Z" },
      },
    };
    act(() => {
      root.render(<IssueRecoveryBudgetBanner executionState={state} isClearing={false} onClear={() => {}} />);
    });
    expect(
      container.querySelector("[data-testid='issue-recovery-budget-authorized-run']")?.textContent,
    ).toContain("One run is authorized");
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

describe("authorizedRecoveryRun", () => {
  it("reports only an authorized, unused permit", () => {
    const withPermit = (status: string) => ({
      recoveryBudget: { status: "exhausted", remediation: { status, expiresAt: "2026-10-01T12:00:00.000Z" } },
    });
    expect(authorizedRecoveryRun(withPermit("authorized"))).toEqual({ expiresAt: "2026-10-01T12:00:00.000Z" });
    for (const status of ["consumed", "denied", "expired"]) expect(authorizedRecoveryRun(withPermit(status))).toBeNull();
    expect(authorizedRecoveryRun(null)).toBeNull();
    expect(authorizedRecoveryRun({ recoveryBudget: { status: "exhausted" } })).toBeNull();
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
