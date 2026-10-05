// @vitest-environment jsdom
// AgentDash (c4-stops): the stopped-work banner names the stop and owns the
// explicit Resume — a plain comment never restarts stopped work.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { IssueStoppedBanner } from "./IssueStoppedBanner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const baseIssue = { status: "in_progress", assigneeAgentId: "agent-1" };

describe("IssueStoppedBanner", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(props: Partial<Parameters<typeof IssueStoppedBanner>[0]> = {}) {
    await act(async () => {
      root.render(
        <IssueStoppedBanner
          issue={baseIssue}
          hasLiveRuns={false}
          latestRunStatus="cancelled"
          stoppedByYou={false}
          agentName="Riley"
          isResuming={false}
          onResume={() => {}}
          {...props}
        />,
      );
    });
  }

  it("shows the stop and offers Resume for the assigned agent", async () => {
    const onResume = vi.fn();
    await render({ onResume });
    expect(container.textContent).toContain("Stopped.");
    expect(container.textContent).toContain("Riley");
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Resume"));
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("says 'Stopped by you' when this viewer stopped it", async () => {
    await render({ stoppedByYou: true });
    expect(container.textContent).toContain("Stopped by you.");
  });

  it("stays hidden while a run is live", async () => {
    await render({ hasLiveRuns: true });
    expect(container.querySelector('[data-testid="issue-stopped-banner"]')).toBeNull();
  });

  it("names the stop without a Resume button when nobody is assigned", async () => {
    await render({ issue: { status: "in_progress", assigneeAgentId: null } });
    expect(container.textContent).toContain("Stopped.");
    expect(container.textContent).toContain("assign it to an agent");
    expect(Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Resume"))).toBeUndefined();
  });

  it("stays hidden when the newest run ended another way", async () => {
    await render({ latestRunStatus: "failed" });
    expect(container.querySelector('[data-testid="issue-stopped-banner"]')).toBeNull();
  });
});
