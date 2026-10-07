// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAgentRows, useSidebarAgentRows } from "./SidebarAgents";

// The agent rows as the Team item nests them (SidebarTeamItem), without its
// disclosure — the row behaviour under test is the same.
function SidebarAgents() {
  const rows = useSidebarAgentRows();
  return <SidebarAgentRows {...rows} />;
}

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  NavLink: ({
    children,
    className,
    to,
    ...props
  }: {
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
    to: string;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/PAP/dashboard", search: "", hash: "", state: null }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewAgent: mockOpenNewAgent,
  }),
  useDialogActions: () => ({
    openNewAgent: mockOpenNewAgent,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function openAgentMenu(label = "Open actions for Alpha") {
  const trigger = document.body.querySelector(`button[aria-label="${label}"]`);
  expect(trigger).not.toBeNull();

  await act(async () => {
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

describe("SidebarAgents", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockAgentsApi.list.mockResolvedValue([makeAgent({})]);
    mockAgentsApi.pause.mockResolvedValue(makeAgent({ status: "paused" }));
    mockAgentsApi.resume.mockResolvedValue(makeAgent({}));
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1" },
    });
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows edit and pause actions for an active sidebar agent", async () => {
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAgents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await openAgentMenu();

    const editLink = Array.from(document.body.querySelectorAll("a"))
      .find((element) => element.textContent?.includes("Edit agent"));
    expect(editLink?.getAttribute("href")).toBe("/agents/alpha/configuration");
    expect(document.body.textContent).toContain("Pause agent");

    const pauseItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Pause agent"));
    expect(pauseItem).toBeTruthy();

    await act(async () => {
      pauseItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.pause).toHaveBeenCalledWith("agent-1", "company-1");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Agent paused" }));
  });

  it("shows resume for paused sidebar agents", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ status: "paused", pauseReason: "manual", pausedAt: new Date("2026-01-02T00:00:00Z") }),
    ]);
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAgents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await openAgentMenu();

    const resumeItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Resume agent"));
    expect(resumeItem).toBeTruthy();

    await act(async () => {
      resumeItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.resume).toHaveBeenCalledWith("agent-1", "company-1");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Agent resumed" }));
  });

  it("only shows updating state for the agent currently being changed", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-2", name: "Beta", urlKey: "beta" }),
    ]);
    mockAgentsApi.pause.mockImplementation(() => new Promise(() => {}));
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAgents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await openAgentMenu();

    const pauseItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Pause agent"));
    expect(pauseItem).toBeTruthy();

    await act(async () => {
      pauseItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await openAgentMenu("Open actions for Beta");

    const betaPauseItem = Array.from(
      document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    )
      .find((element) => element.textContent?.includes("Pause agent"));
    expect(betaPauseItem).toBeTruthy();
    expect(document.body.textContent).not.toContain("Updating...");
  });

  it("does not offer sidebar resume for budget-paused agents", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        status: "paused",
        pauseReason: "budget",
        pausedAt: new Date("2026-01-02T00:00:00Z"),
      }),
    ]);
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAgents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await openAgentMenu();

    const budgetPausedItem = Array.from(
      document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    )
      .find((element) => element.textContent?.includes("Budget paused"));
    expect(budgetPausedItem).toBeTruthy();

    await act(async () => {
      budgetPausedItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.resume).not.toHaveBeenCalled();
  });

  // AgentDash: agents grouped by team (reporting line) under Team.
  describe("team groups", () => {
    const org = () => [
      makeAgent({ id: "solo", name: "Felix", urlKey: "felix" }),
      makeAgent({ id: "cos", name: "Casper", urlKey: "casper" }),
      makeAgent({ id: "eng", name: "Maya", urlKey: "maya", reportsTo: "cos" }),
      makeAgent({ id: "be", name: "Priya", urlKey: "priya", reportsTo: "eng" }),
      makeAgent({ id: "mkt", name: "Jules", urlKey: "jules", reportsTo: "cos" }),
      makeAgent({ id: "orphan", name: "Orla", urlKey: "orla", reportsTo: "gone" }),
    ];
    const agentHrefs = () =>
      [...container.querySelectorAll("a")]
        .map((a) => a.getAttribute("href"))
        .filter((h) => h?.startsWith("/agents/"));
    const toggleFor = (name: string) =>
      [...container.querySelectorAll("button")].find((b) =>
        new RegExp(`^(Show|Hide) ${name}'s team$`).test(b.getAttribute("aria-label") ?? ""),
      );
    const groupOf = (leadId: string) => container.querySelector(`[data-sidebar-team-group="${leadId}"]`);
    const click = async (el: Element | undefined) => {
      await act(async () => {
        el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
    };
    const render = async () => {
      const currentRoot = createRoot(container);
      root = currentRoot;
      await act(async () => {
        currentRoot.render(
          <QueryClientProvider client={queryClient}>
            <SidebarAgents />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      return currentRoot;
    };

    it("nests reports under their lead, expanded by default", async () => {
      mockAgentsApi.list.mockResolvedValue(org());
      await render();

      // Every agent is visible; leads keep their own link.
      // Default order (useAgentOrder): top level by name, then reports by name.
      expect(agentHrefs()).toEqual([
        "/agents/casper", "/agents/jules", "/agents/maya", "/agents/priya", "/agents/felix", "/agents/orla",
      ]);
      // Casper's group holds Maya's group, which holds Priya.
      expect(groupOf("cos")?.querySelector('a[href="/agents/maya"]')).not.toBeNull();
      expect(groupOf("cos")?.querySelector('a[href="/agents/jules"]')).not.toBeNull();
      expect(groupOf("eng")?.querySelector('a[href="/agents/priya"]')).not.toBeNull();
      expect(groupOf("cos")?.contains(groupOf("eng"))).toBe(true);
      // Standalone and missing-manager agents are top level, with no chevron.
      expect(container.querySelector('a[href="/agents/felix"]')?.closest("[data-sidebar-team-group]")).toBeNull();
      expect(container.querySelector('a[href="/agents/orla"]')?.closest("[data-sidebar-team-group]")).toBeNull();
      expect(toggleFor("Felix")).toBeUndefined();
      expect(toggleFor("Priya")).toBeUndefined();

      const casper = toggleFor("Casper");
      expect(casper?.getAttribute("type")).toBe("button");
      expect(casper?.getAttribute("aria-expanded")).toBe("true");
      expect(casper?.getAttribute("aria-label")).toBe("Hide Casper's team");
      expect(casper?.getAttribute("aria-controls")).toBe(groupOf("cos")?.id);
      // The chevron never sits inside the lead's link.
      expect(casper?.closest("a")).toBeNull();
    });

    it("collapses one team at a time and remembers it per user per company per lead", async () => {
      mockAgentsApi.list.mockResolvedValue(org());
      let currentRoot = await render();

      await click(toggleFor("Maya"));
      expect(toggleFor("Maya")?.getAttribute("aria-expanded")).toBe("false");
      expect(toggleFor("Maya")?.getAttribute("aria-label")).toBe("Show Maya's team");
      expect(agentHrefs()).not.toContain("/agents/priya");
      // The lead row and the other team stay put.
      expect(agentHrefs()).toContain("/agents/maya");
      expect(agentHrefs()).toContain("/agents/jules");
      expect(toggleFor("Casper")?.getAttribute("aria-expanded")).toBe("true");
      expect(localStorage.getItem("agentdash.sidebarTeamExpanded:company-1:user-1:eng")).toBe("false");
      expect(localStorage.getItem("agentdash.sidebarTeamExpanded:company-1:user-1:cos")).toBeNull();

      await act(async () => currentRoot.unmount());
      root = null;
      currentRoot = await render();
      expect(toggleFor("Maya")?.getAttribute("aria-expanded")).toBe("false");
      expect(agentHrefs()).not.toContain("/agents/priya");

      // Collapsing the outer team hides everything under it.
      await click(toggleFor("Casper"));
      expect(agentHrefs()).toEqual(["/agents/casper", "/agents/felix", "/agents/orla"]);

      // Expanding again forgets the stored collapse.
      await click(toggleFor("Casper"));
      await click(toggleFor("Maya"));
      expect(agentHrefs()).toContain("/agents/priya");
      expect(localStorage.getItem("agentdash.sidebarTeamExpanded:company-1:user-1:eng")).toBeNull();
    });

    it("ignores another user's remembered collapse", async () => {
      localStorage.setItem("agentdash.sidebarTeamExpanded:company-1:user-2:cos", "false");
      mockAgentsApi.list.mockResolvedValue(org());
      await render();
      expect(toggleFor("Casper")?.getAttribute("aria-expanded")).toBe("true");
      expect(agentHrefs()).toContain("/agents/maya");
    });

    it("renders a reporting cycle without crashing or dropping agents", async () => {
      mockAgentsApi.list.mockResolvedValue([
        makeAgent({ id: "p", name: "Pat", urlKey: "pat", reportsTo: "q" }),
        makeAgent({ id: "q", name: "Quinn", urlKey: "quinn", reportsTo: "p" }),
      ]);
      await render();
      expect(agentHrefs()).toEqual(["/agents/pat", "/agents/quinn"]);
      expect(groupOf("p")?.querySelector('a[href="/agents/quinn"]')).not.toBeNull();
    });

    it("keeps the row behaviour for a lead: actions menu and live count", async () => {
      mockAgentsApi.list.mockResolvedValue(org());
      mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([{ agentId: "cos" }, { agentId: "cos" }]);
      await render();
      const casperLink = container.querySelector('a[href="/agents/casper"]');
      expect(casperLink?.textContent).toContain("2 live");
      await openAgentMenu("Open actions for Casper");
      expect(document.body.textContent).toContain("Pause agent");
    });
  });
});
