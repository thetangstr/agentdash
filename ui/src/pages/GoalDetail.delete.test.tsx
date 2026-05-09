// @vitest-environment jsdom

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalDetail } from "./GoalDetail";

// ---- async helpers (same pattern as IssueDetail.test.tsx) ----

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      assertion();
      return;
    } catch {
      await flushReact();
    }
  }
  assertion();
}

// ---- hoisted mocks ----

const mockGoalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenPanel = vi.hoisted(() => vi.fn());
const mockClosePanel = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/goals", () => ({
  goalsApi: mockGoalsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("@/lib/router", () => ({
  useParams: () => ({ goalId: "goal-123" }),
  useNavigate: () => mockNavigate,
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({
    openNewGoal: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: mockOpenPanel,
    closePanel: mockClosePanel,
    panelVisible: false,
    setPanelVisible: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../components/GoalProperties", () => ({
  GoalProperties: () => null,
}));

vi.mock("../components/GoalTree", () => ({
  GoalTree: () => null,
}));

vi.mock("../components/GoalMetricTile", () => ({
  GoalMetricTile: () => null,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value }: { value: string }) => <span>{value}</span>,
}));

vi.mock("../components/EntityRow", () => ({
  EntityRow: () => null,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>loading</div>,
}));

// ---- sample data ----

const sampleGoal = {
  id: "goal-123",
  companyId: "company-1",
  title: "Increase ARR",
  description: "Grow revenue",
  status: "active",
  level: "company",
  parentId: null,
  goalIds: [],
  goals: [],
  goalId: null,
};

// ---- render helper ----

function renderGoalDetail() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <GoalDetail />
      </QueryClientProvider>,
    );
  });
  return { container, root, queryClient };
}

// ---- tests ----

describe("GoalDetail delete affordance", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGoalsApi.get.mockResolvedValue(sampleGoal);
    mockGoalsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = "";
  });

  it("shows the trash icon button in the goal header after data loads", async () => {
    ({ container, root } = renderGoalDetail());

    await waitForAssertion(() => {
      const trashBtn = container.querySelector('[data-testid="delete-goal-button"]');
      expect(trashBtn).not.toBeNull();
    });
  });

  it("clicking trash icon opens the confirm dialog with the goal title", async () => {
    ({ container, root } = renderGoalDetail());

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="delete-goal-button"]')).not.toBeNull();
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="delete-goal-button"]')!.click();
    });

    // Dialog renders via Radix portal into document.body (outside container)
    await waitForAssertion(() => {
      expect(document.querySelector('[data-testid="confirm-delete-goal-button"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain("Increase ARR");
    expect(document.body.textContent).toContain("Delete Goal");
  });

  it("clicking Cancel closes the dialog without calling goalsApi.remove", async () => {
    ({ container, root } = renderGoalDetail());

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="delete-goal-button"]')).not.toBeNull();
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="delete-goal-button"]')!.click();
    });

    await waitForAssertion(() => {
      expect(document.querySelector('[data-testid="confirm-delete-goal-button"]')).not.toBeNull();
    });

    const buttons = Array.from(document.querySelectorAll("button"));
    const cancelBtn = buttons.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancelBtn).not.toBeNull();

    act(() => {
      cancelBtn!.click();
    });

    await waitForAssertion(() => {
      expect(document.querySelector('[data-testid="confirm-delete-goal-button"]')).toBeNull();
    });
    expect(mockGoalsApi.remove).not.toHaveBeenCalled();
  });

  it("clicking Delete Goal calls goalsApi.remove with the goal id and navigates to /goals on success", async () => {
    mockGoalsApi.remove.mockResolvedValue(sampleGoal);

    ({ container, root } = renderGoalDetail());

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="delete-goal-button"]')).not.toBeNull();
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="delete-goal-button"]')!.click();
    });

    await waitForAssertion(() => {
      expect(document.querySelector('[data-testid="confirm-delete-goal-button"]')).not.toBeNull();
    });

    const confirmBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-delete-goal-button"]',
    )!;

    await act(async () => {
      confirmBtn.click();
      await flushReact();
    });

    expect(mockGoalsApi.remove).toHaveBeenCalledWith("goal-123");
    expect(mockNavigate).toHaveBeenCalledWith("/goals");
  });

  it("shows an error toast when goalsApi.remove fails", async () => {
    mockGoalsApi.remove.mockRejectedValue(new Error("Server error"));

    ({ container, root } = renderGoalDetail());

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="delete-goal-button"]')).not.toBeNull();
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="delete-goal-button"]')!.click();
    });

    await waitForAssertion(() => {
      expect(document.querySelector('[data-testid="confirm-delete-goal-button"]')).not.toBeNull();
    });

    const confirmBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-delete-goal-button"]',
    )!;

    await act(async () => {
      confirmBtn.click();
      await flushReact();
    });

    expect(mockGoalsApi.remove).toHaveBeenCalledWith("goal-123");
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Failed to delete goal",
        body: "Server error",
        tone: "error",
      }),
    );
  });
});
