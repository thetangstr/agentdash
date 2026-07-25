// @vitest-environment jsdom
// AgentDash: Overview dashboard live-data tests (AGE-448/449/451).
// Covers the empty/loading/error states and the Math.max(dashboard.active,
// agents.length) race fix — the agent count must never lag behind the actual
// agent list right after an agent is created.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";

type QueryResult = { data: unknown; isLoading: boolean; error: unknown };

const mockUseCompany = vi.hoisted(() => vi.fn());
// Per-query results keyed by the first element of the queryKey
// (["dashboard", ...], ["agents", ...], ["approvals", ...]).
const queryResults = vi.hoisted(
  () => new Map<string, QueryResult>(),
);

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (enabled === false) {
      return { data: undefined, isLoading: false, error: null };
    }
    return (
      queryResults.get(String(queryKey[0])) ?? {
        data: undefined,
        isLoading: false,
        error: null,
      }
    );
  },
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  (globalThis as any).React = actual;
  return actual;
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: mockUseCompany,
}));

// Overview's Link comes from the company-aware router wrapper, which needs a
// react-router context. Stub it to a plain anchor — these tests only assert
// rendered text, not navigation.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: unknown; children?: React.ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"} {...rest}>
      {children}
    </a>
  ),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setQuery(key: "dashboard" | "agents" | "approvals", result: QueryResult) {
  queryResults.set(key, result);
}

function ok(data: unknown): QueryResult {
  return { data, isLoading: false, error: null };
}

function makeDashboard(overrides: { active?: number; running?: number } = {}) {
  return {
    agents: { active: overrides.active ?? 0, running: overrides.running ?? 0, paused: 0 },
    tasks: { open: 2, inProgress: 1, done: 4 },
    pendingApprovals: 0,
    costs: { monthSpendCents: 1250, monthBudgetCents: 10000 },
  };
}

function makeAgent(i: number) {
  return {
    id: `agent-${i}`,
    name: `Agent ${i}`,
    role: "general",
    status: "idle",
    lastHeartbeatAt: null,
  };
}

describe("Overview", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // Deterministic reduced-motion: matches=true skips count-up animations,
    // reveal timers, and rAF loops so assertions see final values immediately.
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;

    mockUseCompany.mockReturnValue({
      selectedCompanyId: "company-1",
      selectedCompany: { id: "company-1", name: "Acme" },
    });

    queryResults.clear();
    setQuery("dashboard", ok(makeDashboard()));
    setQuery("agents", ok([]));
    setQuery("approvals", ok([]));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    await act(async () => {
      const { Overview } = await import("./Overview");
      root.render(<Overview />);
    });
    await act(async () => {});
  }

  it("asks the user to select a company when none is selected", async () => {
    mockUseCompany.mockReturnValue({ selectedCompanyId: null, selectedCompany: null });

    await render();

    expect(container.textContent).toContain("Select a company to view its dashboard.");
  });

  it("shows the loading state while the dashboard query is in flight", async () => {
    setQuery("dashboard", { data: undefined, isLoading: true, error: null });

    await render();

    expect(container.textContent).toContain("Loading dashboard…");
  });

  it("shows the error state when the dashboard query fails", async () => {
    setQuery("dashboard", {
      data: undefined,
      isLoading: false,
      error: new ApiError("Internal Server Error", 500, null),
    });

    await render();

    expect(container.textContent).toContain("Error 500: Internal Server Error");
  });

  it("uses the agent list length when the dashboard count lags behind (race fix)", async () => {
    // Dashboard says 1 active agent, but the agents API already returns 3 —
    // the count must be Math.max of both, i.e. 3.
    setQuery("dashboard", ok(makeDashboard({ active: 1 })));
    setQuery("agents", ok([makeAgent(1), makeAgent(2), makeAgent(3)]));

    await render();

    expect(container.textContent).toContain("Acme · 3 agents");
    expect(container.textContent).toContain("view all 3 →");
  });

  it("keeps the dashboard count when it exceeds the agent list length", async () => {
    setQuery("dashboard", ok(makeDashboard({ active: 5 })));
    setQuery("agents", ok([makeAgent(1), makeAgent(2)]));

    await render();

    expect(container.textContent).toContain("Acme · 5 agents");
  });
});
