// @vitest-environment jsdom
// AgentDash (GH #786): what Home adds for the first run.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockStatus = vi.hoisted(() => vi.fn());
const mockListGrants = vi.hoisted(() => vi.fn());
const mockListDismissals = vi.hoisted(() => vi.fn());
const mockDismiss = vi.hoisted(() => vi.fn());
vi.mock("@/api/firstRun", () => ({ firstRunApi: { status: mockStatus } }));
vi.mock("@/api/assistant-grants", () => ({
  assistantGrantsApi: { listMine: mockListGrants },
}));
vi.mock("@/api/inboxDismissals", () => ({
  inboxDismissalsApi: { list: mockListDismissals, dismiss: mockDismiss },
}));
vi.mock("@/lib/router", async () => {
  const dom = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { Link: dom.Link };
});

import { CONNECT_GITHUB_DISMISSAL_KEY, FirstRunHomeNudges } from "./FirstRunHomeNudges";

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
    mockListDismissals.mockReset();
    mockListDismissals.mockResolvedValue([]);
    mockDismiss.mockReset();
    mockDismiss.mockResolvedValue({});
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
    mockStatus.mockResolvedValue({ ...base, nextStep: "model" });
    await render();
    const resume = container.querySelector('[data-testid="first-run-home-resume"]')!;
    expect(resume.textContent).toContain("connect a model provider");
    expect(resume.querySelector("a")?.getAttribute("href")).toBe("/setup");
    expect(container.querySelector('[data-testid="connect-muse"]')).toBeNull();
  });

  it("speaks the plan's empty-state copy on the repo step (UX-11), phrased as optional", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "repo", repo: { done: false, repo: null, projectId: null } });
    await render();
    const resume = container.querySelector('[data-testid="first-run-home-resume"]')!;
    expect(resume.textContent).toContain("Working with code? Connect GitHub");
    expect(resume.textContent).not.toContain("Finish setting up");
    expect(resume.textContent).toContain("Connect a repo so your agents have somewhere to work.");
    const link = resume.querySelector("a")!;
    expect(link.textContent).toBe("Connect GitHub");
    expect(link.getAttribute("href")).toBe("/setup");
  });

  // AgentDash: the GitHub step is optional; dismissing it is per person, per company.
  it("hides the GitHub card once dismissed and stores the dismissal server-side", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "repo", repo: { done: false, repo: null, projectId: null } });
    await render();
    const dismiss = container.querySelector('button[aria-label="Dismiss the Connect GitHub card"]') as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    await act(async () => dismiss.click());
    expect(container.querySelector('[data-testid="first-run-home-resume"]')).toBeNull();
    expect(mockDismiss).toHaveBeenCalledWith("c1", CONNECT_GITHUB_DISMISSAL_KEY);
    expect(window.localStorage.getItem("agentdash.connectGithubCard.dismissed.c1")).toBe("1");
  });

  it("stays hidden on another browser when the server has the dismissal", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "repo", repo: { done: false, repo: null, projectId: null } });
    mockListDismissals.mockResolvedValue([
      { id: "d1", companyId: "c1", userId: "u1", itemKey: CONNECT_GITHUB_DISMISSAL_KEY, dismissedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    ]);
    await render();
    expect(mockListDismissals).toHaveBeenCalledWith("c1");
    expect(container.innerHTML).toBe("");
  });

  it("still hides the card when the dismissal cannot be saved on the server", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "repo", repo: { done: false, repo: null, projectId: null } });
    mockDismiss.mockRejectedValue(new Error("offline"));
    await render();
    const dismiss = container.querySelector('button[aria-label="Dismiss the Connect GitHub card"]') as HTMLButtonElement;
    await act(async () => dismiss.click());
    expect(container.querySelector('[data-testid="first-run-home-resume"]')).toBeNull();
  });

  it("hides the GitHub card once the company has shipped work without a repo", async () => {
    mockStatus.mockResolvedValue({
      ...base,
      nextStep: "repo",
      repo: { done: false, repo: null, projectId: null, shippedWithoutRepo: true },
    });
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("keeps the model step undismissable", async () => {
    mockStatus.mockResolvedValue({ ...base, nextStep: "model" });
    await render();
    expect(container.querySelector('button[aria-label="Dismiss the Connect GitHub card"]')).toBeNull();
    expect(container.textContent).toContain("Finish setting up");
    expect(mockListDismissals).not.toHaveBeenCalled();
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
