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
const mockSetupHermesProvider = vi.hoisted(() => vi.fn());
const mockSetupAdapter = vi.hoisted(() => vi.fn());
const mockTestEnvironment = vi.hoisted(() => vi.fn());
const mockCompany = vi.hoisted(() => ({
  selectedCompany: { id: "company-1", issuePrefix: "ACM" } as null | Record<string, string>,
  selectedCompanyId: "company-1" as string | null,
  companies: [] as Array<Record<string, string>>,
  setSelectedCompanyId: (() => undefined) as (id: string) => void,
  loading: false,
}));

vi.mock("@/api/firstRun", () => ({ firstRunApi: { status: mockStatus, createFirstIssue: mockCreate } }));
const mockModelKeyAdmins = vi.hoisted(() => vi.fn());
const mockRequestModelKey = vi.hoisted(() => vi.fn());
vi.mock("@/api/onboarding", () => ({
  onboardingApi: {
    adapterStatus: mockAdapterStatus,
    setupHermesProvider: mockSetupHermesProvider,
    setupAdapter: mockSetupAdapter,
    modelKeyAdmins: mockModelKeyAdmins,
    requestModelKey: mockRequestModelKey,
  },
}));
vi.mock("@/api/githubConnections", () => ({
  GITHUB_FINE_GRAINED_TOKEN_URL: "https://github.com/settings/personal-access-tokens/new",
  githubConnectionsApi: { connect: vi.fn() },
}));
vi.mock("@/api/agents", () => ({ agentsApi: { testEnvironment: mockTestEnvironment } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mockCompany }));
vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { FirstRunPage } from "./FirstRun";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function status(overrides: Partial<FirstRunStatus> = {}): FirstRunStatus {
  return {
    applies: true,
    showHomeNudge: true,
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
    for (const mock of [mockStatus, mockCreate, mockAdapterStatus, mockNavigate, mockModelKeyAdmins, mockRequestModelKey, mockSetupHermesProvider, mockSetupAdapter, mockTestEnvironment]) mock.mockReset();
    mockModelKeyAdmins.mockResolvedValue({ admins: [] });
    mockCompany.selectedCompany = { id: "company-1", issuePrefix: "ACM" };
    mockCompany.selectedCompanyId = "company-1";
    mockCompany.companies = [mockCompany.selectedCompany, { id: "company-2", issuePrefix: "NEW" }];
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

  // AgentDash (first-session test, Lane A item 3): after the key the founder
  // landed on a bare companies list instead of the CoS conversation.
  it("goes to the CoS conversation once the model key is saved", async () => {
    mockStatus.mockResolvedValue(status());
    mockSetupHermesProvider.mockResolvedValue({ provider: "zai", model: "glm-5.3-flash", configured: true });
    await render();
    const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(key, "zai-key");
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mockSetupHermesProvider).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-1", apiKey: "zai-key" }));
    expect(mockNavigate).toHaveBeenCalledWith("/cos", { replace: true });
  });

  it("resumes at the repo step once the model is set", async () => {
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: true, done: true } }));
    await render();
    expect(container.textContent).toContain("Using code? Connect GitHub");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Code (optional)");
  });

  // AgentDash (Scan 3, lane J): the code and first-task steps are optional.
  // AgentDash (scan 5, lane access, PR #1017 review): the repo step only
  // exists while no repository is connected, and the server refuses a first
  // task without one — so skipping GitHub cannot land on the first-task step.
  // It leaves the flow for the Chief of Staff instead.
  it("goes to the Chief of Staff, not the first task, when the founder skips GitHub", async () => {
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: true, done: true } }));
    await render();
    expect(container.querySelector('[data-testid="first-run-optional-notice"]')?.textContent).toContain("optional");
    const skip = container.querySelector('[data-testid="first-run-skip"]') as HTMLButtonElement;
    expect(skip.textContent).toBe("Skip for now");
    act(() => skip.click());
    expect(mockNavigate).toHaveBeenCalledWith("/cos", { replace: true });
    // Never the dead-end step the server would refuse.
    expect(container.textContent).not.toContain("What should your team do first?");
  });

  it("sends the founder to the Chief of Staff when the first task is skipped", async () => {
    mockStatus.mockResolvedValue(
      status({ nextStep: "first_issue", model: { required: true, done: true }, repo: { done: true, repo: "acme/app", projectId: "p1" } }),
    );
    await render();
    const skip = container.querySelector('[data-testid="first-run-skip"]') as HTMLButtonElement;
    act(() => skip.click());
    expect(mockNavigate).toHaveBeenCalledWith("/cos", { replace: true });
  });

  // AgentDash (b2 polish): revisiting /setup used to renumber "Code
  // (optional)" as step 1 — the assistant step is always listed so the
  // numbering matches where the founder actually is.
  it("resumes at Code on a self-hosted revisit, assistant step marked done", async () => {
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: false, done: true } }));
    await render();
    const progress = container.querySelector('[data-testid="first-run-progress"]');
    expect(progress?.textContent).toContain("Your AI assistant");
    expect(progress?.textContent).not.toContain("Your model");
    expect(progress?.textContent).toContain("2. Code (optional)");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Code (optional)");
  });

  it("creates the first issue from a suggestion and goes Home", async () => {
    mockStatus.mockResolvedValue(
      status({ nextStep: "first_issue", model: { required: true, done: true }, repo: { done: true, repo: "acme/app", projectId: "p1" } }),
    );
    mockCreate.mockResolvedValue({ issue: { id: "i1", identifier: "ACM-1", title: "Add a badge" }, created: true, hiredAgentId: "a1" });
    await render();
    expect(container.textContent).toContain("What should your team do first?");
    expect(container.querySelector('[data-testid="first-run-skip"]')).not.toBeNull();
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
    expect(container.querySelector('a[href$="/workforce"]')?.getAttribute("href")).toBe("/NEW/workforce");
    expect(mockStatus).toHaveBeenCalledWith("company-2");
    expect(mockCompany.setSelectedCompanyId).toHaveBeenCalledWith("company-2");
  });

  // One onboarding path: a self-hosted founder who just named the workspace
  // gets the runtime step (not the hosted model key), then the Chief of Staff.
  function selfHostedAdapterStatus(adapter = "claude_local", ready = true) {
    mockAdapterStatus.mockResolvedValue({
      status: { adapter, ready, preset: "claude_code", reason: ready ? null : "claude binary not found on PATH" },
      hermesProvider: {
        required: false,
        configured: false,
        provider: null,
        model: null,
        configuredAt: null,
        canConfigure: true,
        options: [],
      },
    });
  }

  it("self-hosted: right after /company-create, shows the runtime step and continues to /cos", async () => {
    selfHostedAdapterStatus();
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: false, done: true } }));
    await render("/setup?companyId=company-2");
    const runtime = container.querySelector('[data-testid="first-run-runtime"]');
    expect(runtime).not.toBeNull();
    expect(runtime?.textContent).toContain("Claude Code");
    expect(runtime?.textContent).toContain("Codex");
    expect(runtime?.textContent).toContain("Hermes");
    expect(container.querySelector('[data-testid="first-run-runtime-current"]')?.textContent).toContain(
      "Your workspace uses Claude Code. It is ready.",
    );
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Your AI assistant");
    expect(container.textContent).not.toContain("Connect a model provider");

    const next = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Continue to your Chief of Staff"),
    )!;
    await act(async () => next.click());
    expect(mockNavigate).toHaveBeenCalledWith("/cos", { replace: true });
  });

  it("self-hosted: checks a runtime with the adapter environment test and switches the instance to it", async () => {
    selfHostedAdapterStatus("hermes_local");
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: false, done: true } }));
    mockTestEnvironment.mockResolvedValue({ adapterType: "codex_local", status: "pass", checks: [], testedAt: "now" });
    mockSetupAdapter.mockResolvedValue({ status: { adapter: "codex_local", ready: true, preset: "codex", reason: null } });
    await render("/setup?companyId=company-2");
    const codex = container.querySelector('[data-testid="first-run-runtime-codex_local"]')!;
    const use = Array.from(codex.querySelectorAll("button")).find((b) => b.textContent === "Use Codex")!;
    await act(async () => use.click());
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(mockTestEnvironment).toHaveBeenCalledWith("company-2", "codex_local", { adapterConfig: {} });
    expect(mockSetupAdapter).toHaveBeenCalledWith("codex");
  });

  it("self-hosted: a 403 from the switch asks for the instance admin", async () => {
    selfHostedAdapterStatus("hermes_local");
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: false, done: true } }));
    mockTestEnvironment.mockResolvedValue({ adapterType: "codex_local", status: "pass", checks: [], testedAt: "now" });
    const { ApiError } = await import("@/api/client");
    mockSetupAdapter.mockRejectedValue(new ApiError("Instance admin access required", 403, {}));
    await render("/setup?companyId=company-2");
    const codex = container.querySelector('[data-testid="first-run-runtime-codex_local"]')!;
    const use = Array.from(codex.querySelectorAll("button")).find((b) => b.textContent === "Use Codex")!;
    await act(async () => use.click());
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Ask the person who set up AgentDash to change the assistant.");
  });

  it("self-hosted: does not switch to a runtime whose check fails", async () => {
    selfHostedAdapterStatus("hermes_local");
    mockStatus.mockResolvedValue(status({ nextStep: "repo", model: { required: false, done: true } }));
    mockTestEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "fail",
      checks: [{ code: "missing", level: "error", message: "claude not found" }],
      testedAt: "now",
    });
    await render("/setup?companyId=company-2");
    const claude = container.querySelector('[data-testid="first-run-runtime-claude_local"]')!;
    const use = Array.from(claude.querySelectorAll("button")).find((b) => b.textContent === "Use Claude Code")!;
    await act(async () => use.click());
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(mockSetupAdapter).not.toHaveBeenCalled();
    expect(claude.textContent).toContain("Not ready: claude not found");
  });

  it("goes Home when setup is already done", async () => {
    mockStatus.mockResolvedValue(status({ nextStep: "done" }));
    await render();
    expect(mockNavigate).toHaveBeenCalledWith("/ACM/dashboard", { replace: true });
  });

  it("goes to /cos when the server says the first run does not apply", async () => {
    mockStatus.mockResolvedValue(status({ applies: false }));
    await render();
    expect(container.textContent).toContain("COS PAGE");
  });

  it("tells a company admin who cannot set the model key who can, with a link Home (#794)", async () => {
    mockStatus.mockResolvedValue(status({ canConfigureModel: false }));
    mockModelKeyAdmins.mockResolvedValue({
      admins: [{ userId: "u1", name: "Asha Instance", email: "asha@x.test", membershipRole: "admin", canFix: true }],
    });
    await render();
    const waiting = container.querySelector('[data-testid="first-run-model-waiting"]');
    expect(waiting?.textContent).toContain("instance administrator");
    expect(waiting?.textContent).toContain("Asha Instance");
    expect(waiting?.querySelector('a[href="/ACM/dashboard"]')).not.toBeNull();
    expect(waiting?.querySelector('a[href="/company/settings/model-key"]')).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });

  it("tells a member the owner is setting up, with no forms", async () => {
    mockStatus.mockResolvedValue(status({ canManage: false }));
    await render();
    expect(container.querySelector('[data-testid="first-run-waiting"]')).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
  });
});
