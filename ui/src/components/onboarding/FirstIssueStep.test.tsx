// @vitest-environment jsdom
// AgentDash (GH #786): "What should we build first?"
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("@/api/firstRun", () => ({ firstRunApi: { createFirstIssue: mockCreate } }));

import { FirstIssueStep } from "./FirstIssueStep";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("FirstIssueStep", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockCreate.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    const onCreated = vi.fn();
    act(() => {
      root.render(<FirstIssueStep companyId="c1" repo="acme/app" suggestions={["A", "B", "C"]} onCreated={onCreated} />);
    });
    return { onCreated };
  }

  const submit = async () => {
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };

  it("shows three suggestions and keeps Start disabled until there is a sentence", () => {
    render();
    expect(container.querySelectorAll('[data-testid="first-issue-suggestions"] button')).toHaveLength(3);
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains the Free cap when there is no room to hire", async () => {
    mockCreate.mockRejectedValue(
      new ApiError("Payment required", 402, { code: "agent_cap_exceeded", message: "Free workspaces include up to 2 agents." }),
    );
    const { onCreated } = render();
    act(() => (container.querySelectorAll('[data-testid="first-issue-suggestions"] button')[1] as HTMLButtonElement).click());
    await submit();
    expect(mockCreate).toHaveBeenCalledWith("c1", "B");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Free workspaces include up to 2 agents.");
    expect(onCreated).not.toHaveBeenCalled();
  });
});
