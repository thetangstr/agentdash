// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizedRecoveryRun,
  IssueRecoveryBudgetBanner,
  recoveryBudgetClearedToastBody,
  unusedRecoveryRunOutcome,
} from "./IssueRecoveryBudgetBanner";

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
    // GH #891: plain language for admins — no internal operation names.
    expect(detail).not.toContain("task_recovery");
    expect(detail).toContain("authorize one run");
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

describe("Authorize one run (GH #891)", () => {
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

  const flush = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("is hidden when the page passes no authorize handlers", () => {
    act(() => {
      root.render(<IssueRecoveryBudgetBanner executionState={exhaustedState} isClearing={false} onClear={() => {}} />);
    });
    expect(container.querySelector("[data-testid='issue-recovery-budget-authorize-run']")).toBeNull();
  });

  it("reviews first, then authorizes against the reviewed preconditions after an explicit confirm", async () => {
    const preconditions = { exhaustedAt: "2026-10-01T10:00:00.000Z", pendingPermitStatus: null };
    const onPreview = vi.fn().mockResolvedValue({
      readback: { context: { issue: { assigneeAgentName: "Maya" } } },
      preconditions,
    });
    const onAuthorize = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        <IssueRecoveryBudgetBanner
          executionState={exhaustedState}
          isClearing={false}
          onClear={() => {}}
          onPreviewAuthorizeRun={onPreview}
          onAuthorizeRun={onAuthorize}
        />,
      );
    });
    const open = container.querySelector<HTMLButtonElement>("[data-testid='issue-recovery-budget-authorize-run']");
    expect(open?.textContent).toBe("Authorize one run");
    act(() => open!.click());
    await flush();
    expect(onPreview).toHaveBeenCalledTimes(1);
    // Opening the dialog authorizes nothing.
    expect(onAuthorize).not.toHaveBeenCalled();
    const dialog = document.body.querySelector("[data-testid='issue-recovery-budget-authorize-dialog']");
    expect(dialog?.textContent).toContain("Maya gets exactly one run on this issue");
    expect(dialog?.textContent).toContain("recovery block stays");
    expect(dialog?.textContent).not.toContain("task_recovery");
    const confirm = document.body.querySelector<HTMLButtonElement>("[data-testid='issue-recovery-budget-authorize-confirm']");
    act(() => confirm!.click());
    await flush();
    expect(onAuthorize).toHaveBeenCalledWith(preconditions);
  });

  it("shows the server's refusal and does not authorize", async () => {
    const onPreview = vi.fn().mockRejectedValue(new Error("Only a company admin, or a person who manages this issue's agent, can authorize a run."));
    const onAuthorize = vi.fn();
    act(() => {
      root.render(
        <IssueRecoveryBudgetBanner
          executionState={exhaustedState}
          isClearing={false}
          onClear={() => {}}
          onPreviewAuthorizeRun={onPreview}
          onAuthorizeRun={onAuthorize}
        />,
      );
    });
    act(() => container.querySelector<HTMLButtonElement>("[data-testid='issue-recovery-budget-authorize-run']")!.click());
    await flush();
    expect(document.body.querySelector("[data-testid='issue-recovery-budget-authorize-error']")?.textContent)
      .toContain("Only a company admin");
    const confirm = document.body.querySelector<HTMLButtonElement>("[data-testid='issue-recovery-budget-authorize-confirm']");
    expect(confirm?.disabled).toBe(true);
    expect(onAuthorize).not.toHaveBeenCalled();
  });

  it("is disabled while a run is already authorized", () => {
    const state = {
      recoveryBudget: { ...exhaustedState.recoveryBudget, remediation: { status: "authorized", expiresAt: "2026-10-01T12:00:00.000Z" } },
    };
    act(() => {
      root.render(
        <IssueRecoveryBudgetBanner
          executionState={state}
          isClearing={false}
          onClear={() => {}}
          onPreviewAuthorizeRun={vi.fn()}
          onAuthorizeRun={vi.fn()}
        />,
      );
    });
    expect(container.querySelector<HTMLButtonElement>("[data-testid='issue-recovery-budget-authorize-run']")?.disabled).toBe(true);
  });

  it("says when the last authorized run never started, instead of waiting forever", () => {
    const state = {
      recoveryBudget: {
        ...exhaustedState.recoveryBudget,
        remediation: { status: "denied", denialReason: "the authorized run was stopped before it started: Run quota exceeded" },
      },
    };
    act(() => {
      root.render(<IssueRecoveryBudgetBanner executionState={state} isClearing={false} onClear={() => {}} />);
    });
    expect(container.querySelector("[data-testid='issue-recovery-budget-authorized-run']")).toBeNull();
    const unused = container.querySelector("[data-testid='issue-recovery-budget-unused-run']")?.textContent ?? "";
    expect(unused).toContain("The last authorized run did not start");
    expect(unused).toContain("Run quota exceeded");
    expect(unused).toContain("Authorize again");
  });
});

describe("unusedRecoveryRunOutcome", () => {
  it("reports only a denied or expired permit", () => {
    const withPermit = (status: string) => ({ recoveryBudget: { status: "exhausted", remediation: { status, denialReason: "x" } } });
    expect(unusedRecoveryRunOutcome(withPermit("denied"))).toEqual({ status: "denied", reason: "x" });
    expect(unusedRecoveryRunOutcome(withPermit("expired"))).toEqual({ status: "expired", reason: "x" });
    for (const status of ["authorized", "consumed"]) expect(unusedRecoveryRunOutcome(withPermit(status))).toBeNull();
    expect(unusedRecoveryRunOutcome(null)).toBeNull();
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
