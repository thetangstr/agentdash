// @vitest-environment jsdom
// AgentDash (GH #786): the first run's card on Home.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStatus = vi.hoisted(() => vi.fn());
vi.mock("@/api/firstRun", () => ({ firstRunApi: { status: mockStatus } }));

import { FirstRunHomeCard } from "./FirstRunHomeCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  applies: true,
  canManage: true,
  model: { required: true, done: true },
  repo: { done: true, repo: "acme/app", projectId: "p1" },
  suggestions: [],
};

describe("FirstRunHomeCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockStatus.mockReset();
    try {
      window.localStorage.clear();
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <FirstRunHomeCard companyId="c1" issuePrefix="ACM" />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("shows the first issue working now, with the CoS and Muse cards", async () => {
    mockStatus.mockResolvedValue({
      ...base,
      nextStep: "done",
      firstIssue: { done: true, issueId: "i1", identifier: "ACM-1", title: "Add a badge", status: "in_progress", assigneeAgentId: "a1", assigneeName: "Engineer" },
    });
    await render();
    const card = container.querySelector('[data-testid="first-run-home-card"]')!;
    expect(card.textContent).toContain("Working now");
    expect(card.textContent).toContain("ACM-1 Add a badge");
    expect(card.textContent).toContain("Engineer");
    expect(container.querySelector('[data-testid="plan-with-cos"]')?.getAttribute("href")).toBe("/cos");
    expect(container.querySelector('[data-testid="connect-muse"]')?.textContent).toContain("Connect Muse so you can do this from your phone");

    const dismiss = [...container.querySelectorAll("button")].find((button) => button.textContent === "Dismiss")!;
    act(() => dismiss.click());
    expect(container.querySelector('[data-testid="first-run-home-card"]')).toBeNull();
  });

  it("offers to continue setup when a step is left", async () => {
    mockStatus.mockResolvedValue({
      ...base,
      nextStep: "repo",
      firstIssue: { done: false, issueId: null, identifier: null, title: null, status: null, assigneeAgentId: null, assigneeName: null },
    });
    await render();
    const resume = container.querySelector('[data-testid="first-run-home-resume"]')!;
    expect(resume.textContent).toContain("connect your GitHub repo");
    expect(resume.querySelector("a")?.getAttribute("href")).toBe("/setup");
  });

  it("renders nothing when the first run does not apply", async () => {
    mockStatus.mockResolvedValue({ ...base, applies: false, nextStep: "repo", firstIssue: {} });
    await render();
    expect(container.innerHTML).toBe("");
  });
});
