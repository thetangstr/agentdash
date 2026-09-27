// @vitest-environment jsdom
// AgentDash (GH #786): the /setup first run shows the first incomplete step.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunStatus } from "@/api/firstRun";

const mockStatus = vi.hoisted(() => vi.fn());
const mockCreate = vi.hoisted(() => vi.fn());
const mockAdapterStatus = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
const mockCompany = vi.hoisted(() => ({
  selectedCompany: { id: "company-1", issuePrefix: "ACM", productProfile: "default" } as null | Record<string, string>,
  selectedCompanyId: "company-1" as string | null,
  companies: [] as Array<Record<string, string>>,
  setSelectedCompanyId: (() => undefined) as (id: string) => void,
  loading: false,
}));

vi.mock("@/api/firstRun", () => ({ firstRunApi: { status: mockStatus, createFirstIssue: mockCreate } }));
vi.mock("@/api/onboarding", () => ({ onboardingApi: { adapterStatus: mockAdapterStatus, setupHermesProvider: vi.fn() } }));
vi.mock("@/api/githubConnections", () => ({
  GITHUB_FINE_GRAINED_TOKEN_URL: "https://github.com/settings/personal-access-tokens/new",
  githubConnectionsApi: { connect: vi.fn() },
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompany }));
vi.mock("@/lib/router", () => ({ useNavigate: () => mockNavigate }));

import { FirstRunPage } from "./FirstRun";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function status(overrides: Partial<FirstRunStatus> = {}): FirstRunStatus {
  return {
    applies: true,
    nextStep: "model",
    canManage: true,
    canConfigureModel: true,
    model: { required: true, done: false },
    repo: { done: false, repo: null, projectId: null },
    firstIssue: { done: false, issueId: null, identifier: null, title: null, status: null, assigneeAgentId: null, assigneeName: null },
    suggestions: ["Add a badge", "Add tests", "Fix a bug"],
    ...overrides,
  };
}

describe("FirstRunPage", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    for (const mock of [mockStatus, mockCreate, mockAdapterStatus, mockNavigate]) mock.mockReset();
    mockCompany.selectedCompany = { id: "company-1", issuePrefix: "ACM", productProfile: "default" };
    mockCompany.selectedCompanyId = "company-1";
    mockCompany.companies = [mockCompany.selectedCompany, { id: "company-2", issuePrefix: "NEW", productProfile: "default" }];
    mockCompany.setSelectedCompanyId = vi.fn();
    mockAdapterStatus.mockResolvedValue({
      status: { adapter: "hermes_local", ready: false, preset: "hermes", reason: null },
      hermesProvider: {
        required: true,
        configured: false,
        provider: null,
        model: null,
        configuredAt: null,
        canConfigure: true,
        options: [{ provider: "zai", label: "Z.AI (GLM)", defaultModel: "glm-5.3-flash", keyHint: "key" }],
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(path = "/setup") {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/setup" element={<FirstRunPage />} />
              <Route path="/cos" element={<div>COS PAGE</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("starts with the model-key step on a hosted box, with progress", async () => {
    mockStatus.mockResolvedValue(status());
    await render();
    expect(container.textContent).toContain("Connect a model provider");
    const current = container.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Your model");
  });

  it("resumes at the repo step once the model is set", async () => {
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: true, done: true } }));
    await render();
    expect(container.textContent).toContain("Connect your GitHub repo");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Your repo");
  });

  it("hides the model step when the box does not need one", async () => {
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: false, done: true } }));
    await render();
    expect(container.querySelector('[data-testid="first-run-progress"]')?.textContent).not.toContain("Your model");
  });

  it("creates the first issue from a suggestion and goes Home", async () => {
    mockStatus.mockResolvedValue(
      status({ nextStep: "first_issue", model: { required: true, done: true }, repo: { done: true, repo: "acme/app", projectId: "p1" } }),
    );
    mockCreate.mockResolvedValue({ issue: { id: "i1", identifier: "ACM-1", title: "Add a badge" }, created: true, hiredAgentId: "a1" });
    await render();
    expect(container.textContent).toContain("What should we build first?");
    expect(container.textContent).toContain("acme/app");
    const chip = [...container.querySelectorAll('[data-testid="first-issue-suggestions"] button')][0] as HTMLButtonElement;
    act(() => chip.click());
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Add a badge");
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockCreate).toHaveBeenCalledWith("company-1", "Add a badge");
    expect(mockNavigate).toHaveBeenCalledWith("/ACM/dashboard", { replace: true });
  });

  it("uses the workspace named in ?companyId, not the previously selected one", async () => {
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: true, done: true } }));
    await render("/setup?companyId=company-2");
    expect(mockStatus).toHaveBeenCalledWith("company-2");
    expect(mockCompany.setSelectedCompanyId).toHaveBeenCalledWith("company-2");
  });

  it("goes Home when setup is already done", async () => {
    mockStatus.mockResolvedValue(status({ nextStep: "done" }));
    await render();
    expect(mockNavigate).toHaveBeenCalledWith("/ACM/dashboard", { replace: true });
  });

  it("sends an agentdash_mk workspace to its unchanged onboarding at /cos", async () => {
    mockStatus.mockResolvedValue(status({ applies: false }));
    await render();
    expect(container.textContent).toContain("COS PAGE");
  });

  it("tells a company admin who cannot set the model key who can, with a link Home (#794)", async () => {
    mockStatus.mockResolvedValue(status({ canConfigureModel: false }));
    await render();
    const waiting = container.querySelector('[data-testid="first-run-model-waiting"]');
    expect(waiting?.textContent).toContain("instance administrator");
    expect(waiting?.querySelector("a")?.getAttribute("href")).toBe("/ACM/dashboard");
    expect(container.querySelector("form")).toBeNull();
  });

  it("tells a member the owner is setting up, with no forms", async () => {
    mockStatus.mockResolvedValue(status({ canManage: false }));
    await render();
    expect(container.querySelector('[data-testid="first-run-waiting"]')).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });
});
