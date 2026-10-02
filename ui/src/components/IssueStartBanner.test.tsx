// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueStartBanner, shouldOfferIssueStart } from "./IssueStartBanner";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("IssueStartBanner", () => {
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

  it("offers Start only for a parked issue that has an agent", () => {
    expect(shouldOfferIssueStart({ status: "backlog", assigneeAgentId: "agent-1" })).toBe(true);
    expect(shouldOfferIssueStart({ status: "backlog", assigneeAgentId: null })).toBe(false);
    expect(shouldOfferIssueStart({ status: "todo", assigneeAgentId: "agent-1" })).toBe(false);
    expect(shouldOfferIssueStart({ status: "in_progress", assigneeAgentId: "agent-1" })).toBe(false);
  });

  it("names the agent and calls onStart when Start is pressed", () => {
    const onStart = vi.fn();
    act(() => {
      root.render(
        <IssueStartBanner
          issue={{ status: "backlog", assigneeAgentId: "agent-1" }}
          agentName="CoS"
          isStarting={false}
          onStart={onStart}
        />,
      );
    });
    expect(container.textContent).toContain("Not started.");
    expect(container.textContent).toContain("CoS will not work on this until you press Start.");
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Start"));
    expect(button).toBeTruthy();
    act(() => button!.click());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("renders nothing once the issue has started", () => {
    act(() => {
      root.render(
        <IssueStartBanner
          issue={{ status: "todo", assigneeAgentId: "agent-1" }}
          agentName="CoS"
          isStarting={false}
          onStart={() => undefined}
        />,
      );
    });
    expect(container.innerHTML).toBe("");
  });
});
