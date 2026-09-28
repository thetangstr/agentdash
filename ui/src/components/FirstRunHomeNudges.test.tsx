// @vitest-environment jsdom
// AgentDash (GH #786): what Home adds for the first run.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStatus = vi.hoisted(() => vi.fn());
const mockListGrants = vi.hoisted(() => vi.fn());
vi.mock("@/api/firstRun", () => ({ firstRunApi: { status: mockStatus } }));
vi.mock("@/api/assistant-grants", () => ({
  assistantGrantsApi: { listMine: mockListGrants },
}));
vi.mock("@/lib/router", async () => {
  const dom = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: dom.Link };
});

import { FirstRunHomeNudges } from "./FirstRunHomeNudges";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  applies: true,
  showHomeNudge: true,
  canManage: true,
  canConfigureModel: true,
  model: { required: true, done: true },
  repo: { done: true, repo: "acme/app", projectId: "p1" },
  firstIssue: { done: false, issueId: null, identifier: null, title: null, status: null, assigneeAgentId: null, assigneeName: null },
  suggestions: [],
};

describe("FirstRunHomeNudges", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockStatus.mockReset();
    mockListGrants.mockReset();
    mockListGrants.mockResolvedValue({ grants: [] });
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
          <MemoryRouter>
            <FirstRunHomeNudges companyId="c1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    // The grants query only fires once firstRun.status resolves, so flush
    // a few ticks for the chained query to settle.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("offers to continue setup when a step is left", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "repo" });
    await render();
    const resume = container.querySelector('[data-testid="first-run-home-resume"]')!;
    expect(resume.textContent).toContain("connect your GitHub repo");
    expect(resume.querySelector("a")?.getAttribute("href")).toBe("/setup");
    expect(container.querySelector('[data-testid="connect-muse"]')).toBeNull();
  });

  it("says who can add the model key when this admin cannot (#794)", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "model", canConfigureModel: false });
    await render();
    const resume = container.querySelector('[data-testid="first-run-home-resume"]')!;
    expect(resume.textContent).toContain("instance administrator");
    expect(resume.querySelector("a")).toBeNull();
  });

  it("once done, offers Connect Muse (in-app) and can be dismissed by an accessible button", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "done" });
    await render();
    const card = container.querySelector('[data-testid="connect-muse"]')!;
    expect(card.textContent).toContain("Connect Muse so you can do this from your phone");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/connect-assistant");
    // Home owns Working now and Plan with your Chief of Staff; not duplicated here.
    expect(container.textContent).not.toContain("Working now");
    expect(container.textContent).not.toContain("Plan with your Chief of Staff");
    const dismiss = container.querySelector('button[aria-label="Dismiss the Connect Muse card"]') as HTMLButtonElement;
    act(() => dismiss.click());
    expect(container.querySelector('[data-testid="connect-muse"]')).toBeNull();
  });

  // AgentDash (GH #793): once a grant exists the card has done its job.
  it("hides the Connect Muse card when the person already has an assistant grant", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "done" });
    mockListGrants.mockResolvedValue({
      grants: [
        {
          id: "g1",
          clientId: "muse",
          clientName: "Muse",
          redirectHost: "muse.meta.example",
          scopes: ["agentdash:read"],
          createdAt: null,
          lastUsedAt: null,
        },
      ],
    });
    await render();
    expect(container.querySelector('[data-testid="connect-muse"]')).toBeNull();
  });

  it("renders nothing when the server withholds the nudge (self-hosted, or an established company)", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "repo", showHomeNudge: false });
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for members mid-setup or when the first run does not apply", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "repo", canManage: false });
    await render();
    expect(container.innerHTML).toBe("");
    mockStatus.mockResolvedValue({ ...base, nextStep: "done", applies: false });
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.innerHTML).toBe("");
  });
});
