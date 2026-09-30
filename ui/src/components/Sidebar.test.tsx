// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockDashboardApi = vi.hoisted(() => ({
  waitingOnYou: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));

const mockCapabilitiesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
  }),
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
  }),
}));

const mockCompany = vi.hoisted(() => ({
  current: { id: "company-1", issuePrefix: "PAP", name: "Paperclip" } as Record<string, unknown>,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: mockCompany.current,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: mockDashboardApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/capabilities", () => ({
  capabilitiesApi: mockCapabilitiesApi,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Company menu</div>,
}));

vi.mock("./SidebarProjects", () => ({
  SidebarProjects: () => <div>Projects list</div>,
}));

// The row hook is mocked so the default-profile Team list can be driven
// without the agents/session/mutation plumbing; the row renderer emits one
// link per agent, like the real SidebarAgentItem.
const mockAgentRows = vi.hoisted(() => ({
  agents: [] as Array<{ id: string; name: string; urlKey: string }>,
  userId: "user-1" as string | null,
}));

vi.mock("./SidebarAgents", () => ({
  SidebarAgents: () => <div>Agents list</div>,
  useSidebarAgentRows: () => ({
    orderedAgents: mockAgentRows.agents,
    currentUserId: mockAgentRows.userId,
  }),
  SidebarAgentRows: ({ orderedAgents }: { orderedAgents: Array<{ id: string; name: string; urlKey: string }> }) => (
    <div>
      {orderedAgents.map((agent) => (
        <a key={agent.id} href={`/agents/${agent.urlKey}`}>
          {agent.name}
        </a>
      ))}
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Sidebar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    mockAgentRows.agents = [
      { id: "agent-1", name: "Maya", urlKey: "maya" },
      { id: "agent-2", name: "Priya", urlKey: "priya" },
    ];
    mockAgentRows.userId = "user-1";
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockDashboardApi.waitingOnYou.mockResolvedValue({
      decisions: [{ approvalId: "appr-1" }],
      total: 1,
      shown: 1,
      // The server splits before it caps: manual rows in
      // tasksAssignedToYou, machine-filed rows in otherTasksAssignedToYou.
      tasksAssignedToYou: [{ issueId: "i-1", originKind: "manual" }],
      tasksAssignedToYouTotal: 1,
      otherTasksAssignedToYou: [{ issueId: "i-2", originKind: "routine_execution" }],
      otherTasksAssignedToYouTotal: 1,
    });
    mockAccessApi.listMembers.mockResolvedValue({ access: { canManageAgents: true } });
    mockCapabilitiesApi.get.mockResolvedValue({
      capabilities: {},
      membershipRole: "member",
      isInstanceAdmin: false,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("does not flash the Workspaces link while experimental settings are loading", async () => {
    // The inline Workspaces link is MK-only now (UX-6); default folds it into
    // the collapsed Advanced group.
    mockCompany.current = {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Paperclip",
      productProfile: "agentdash_mk",
    };
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).not.toContain("Workspaces");

    await act(async () => {
      root.unmount();
    });
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  });

  it("shows the Workspaces link when isolated workspaces are enabled", async () => {
    mockCompany.current = {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Paperclip",
      productProfile: "agentdash_mk",
    };
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Workspaces");
    expect(link?.getAttribute("href")).toBe("/workspaces");

    await act(async () => {
      root.unmount();
    });
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  });

  // AgentDash: UX-2 (#783) — Shipped is a default-profile link; MK keeps its sidebar.
  async function renderSidebar() {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Sidebar />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("shows the Shipped link on the default profile", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    const root = await renderSidebar();
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Shipped");
    expect(link?.getAttribute("href")).toBe("/shipped");
    // AgentDash: UX-3 (#784) — the dashboard is called Home on the default profile.
    const home = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/dashboard");
    expect(home?.textContent).toContain("Home");
    await act(async () => root.unmount());
  });

  it("does not add the Shipped link on the agentdash_mk profile", async () => {
    mockCompany.current = {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Paperclip",
      productProfile: "agentdash_mk",
    };
    const root = await renderSidebar();
    expect([...container.querySelectorAll("a")].some((a) => a.textContent === "Shipped")).toBe(false);
    const dashboard = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/dashboard");
    expect(dashboard?.textContent).toContain("Dashboard");
    await act(async () => root.unmount());
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  });

  // AgentDash: UX-7 (GH #788) — the default profile's Inbox item becomes
  // Decisions; its badge is the page's main-list length (approvals plus
  // manual-origin assigned issues — machine-generated rows don't count).
  it("shows Decisions with the waiting-list length as its badge on the default profile", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    const root = await renderSidebar();
    const decisions = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/decisions");
    expect(decisions?.textContent).toContain("Decisions");
    // 1 approval + 1 manual task; the routine_execution row is muted.
    expect(decisions?.textContent).toContain("2");
    expect([...container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/inbox")).toBe(false);
    expect(mockDashboardApi.waitingOnYou).toHaveBeenCalledWith("company-1");
    await act(async () => root.unmount());
  });

  // UX-7 review: the badge reads the server's uncapped totals — a person
  // with 30 manual assignments sees 31, not "25 rows happened to load".
  it("counts the server's totals, not the length of the capped lists", async () => {
    mockDashboardApi.waitingOnYou.mockResolvedValue({
      decisions: [{ approvalId: "appr-1" }],
      total: 1,
      shown: 1,
      tasksAssignedToYou: [{ issueId: "i-1", originKind: "manual" }],
      tasksAssignedToYouTotal: 30,
      otherTasksAssignedToYou: [],
      otherTasksAssignedToYouTotal: 4,
    });
    const root = await renderSidebar();
    const decisions = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/decisions");
    expect(decisions?.textContent).toContain("31");
    await act(async () => root.unmount());
  });

  // AgentDash: UX-6 (#787) — six-item sidebar for the default profile.
  it("renders exactly the six primary items on the default profile", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    const root = await renderSidebar();

    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.filter((h) => h === "/dashboard").length).toBe(1);
    for (const href of ["/cos", "/issues", "/decisions", "/shipped", "/agents", "/company/settings"]) {
      expect(hrefs, `expected ${href}`).toContain(href);
    }
    const linkTexts = [...container.querySelectorAll("a")].map((a) => a.textContent);
    for (const label of ["Home", "Ask", "Work", "Decisions", "Shipped", "Team", "Settings"]) {
      // includes(), not equality — Decisions carries its badge count in the
      // anchor's textContent ("Decisions2").
      expect(linkTexts.some((text) => text?.includes(label)), `expected "${label}"`).toBe(true);
    }
    // No MK items and no per-project/per-agent lists; Evaluation and the
    // inbox redirect live under Advanced (collapsed), not top-level.
    expect(linkTexts).not.toContain("My Agent");
    expect(linkTexts).not.toContain("Inbox");
    expect(linkTexts).not.toContain("Evaluation");
    expect(container.textContent).not.toContain("Projects list");
    expect(container.textContent).not.toContain("Agents list");

    // The agent list nests under Team, so the primary block's links are still
    // exactly the six primary destinations (Settings sits in the footer).
    const primaryBlock = container.querySelector("nav > div");
    const primaryHrefs = [...primaryBlock!.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(primaryHrefs).toEqual(["/dashboard", "/cos", "/issues", "/decisions", "/shipped", "/agents"]);
    await act(async () => root.unmount());
  });

  // UX-6 follow-up: the per-agent list returns under Team, collapsed by default.
  describe("Agents list under Team (default profile)", () => {
    const findToggle = () =>
      [...container.querySelectorAll("button")].find((b) =>
        /^(Show|Hide) agents$/.test(b.getAttribute("aria-label") ?? ""),
      );
    const agentHrefs = () =>
      [...container.querySelectorAll("a")]
        .map((a) => a.getAttribute("href"))
        .filter((h) => h?.startsWith("/agents/"));
    const clickToggle = async () => {
      await act(async () => {
        findToggle()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
    };

    beforeEach(() => {
      mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    });

    it("hides the agent list by default behind an accessible toggle", async () => {
      const root = await renderSidebar();
      const toggle = findToggle();
      expect(toggle).toBeDefined();
      expect(toggle?.getAttribute("type")).toBe("button");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(toggle?.getAttribute("aria-controls")).toBeTruthy();
      // The chevron is a sibling of the Team link, never inside it, so
      // clicking it cannot navigate.
      expect(toggle?.closest("a")).toBeNull();
      expect(agentHrefs()).toEqual([]);
      const team = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/agents");
      expect(team?.textContent).toContain("Team");
      await act(async () => root.unmount());
    });

    it("shows the agents when toggled and remembers it per user per company", async () => {
      let root = await renderSidebar();
      await clickToggle();

      const toggle = findToggle();
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(toggle?.getAttribute("aria-label")).toBe("Hide agents");
      expect(agentHrefs()).toEqual(["/agents/maya", "/agents/priya"]);
      const contentId = toggle?.getAttribute("aria-controls");
      expect(contentId && document.getElementById(contentId)?.textContent).toContain("Maya");
      expect(localStorage.getItem("agentdash.sidebarTeamAgentsExpanded:company-1:user-1")).toBe("true");
      await act(async () => root.unmount());

      // Re-mount: the remembered state is honoured.
      root = await renderSidebar();
      expect(findToggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(agentHrefs()).toEqual(["/agents/maya", "/agents/priya"]);

      // Collapsing forgets it again.
      await clickToggle();
      expect(agentHrefs()).toEqual([]);
      expect(localStorage.getItem("agentdash.sidebarTeamAgentsExpanded:company-1:user-1")).toBeNull();
      await act(async () => root.unmount());
    });

    it("does not apply another user's remembered state", async () => {
      localStorage.setItem("agentdash.sidebarTeamAgentsExpanded:company-1:user-2", "true");
      localStorage.setItem("agentdash.sidebarTeamAgentsExpanded:company-2:user-1", "true");
      const root = await renderSidebar();
      expect(findToggle()?.getAttribute("aria-expanded")).toBe("false");
      expect(agentHrefs()).toEqual([]);
      await act(async () => root.unmount());
    });

    it("hides the toggle when the company has no agents", async () => {
      mockAgentRows.agents = [];
      const root = await renderSidebar();
      expect(findToggle()).toBeUndefined();
      const team = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/agents");
      expect(team?.textContent).toContain("Team");
      await act(async () => root.unmount());
    });
  });

  it("keeps the Advanced group collapsed by default on the default profile", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    const root = await renderSidebar();

    const trigger = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Advanced",
    );
    expect(trigger).toBeDefined();
    expect(trigger?.getAttribute("aria-expanded") ?? trigger?.getAttribute("data-state")).toMatch(/false|closed/);
    // Advanced destinations exist but their links are not rendered while collapsed.
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/routines");
    expect(hrefs).not.toContain("/billing");
    await act(async () => root.unmount());
  });

  // UX-6 review: Evaluation stays reachable, folded under Advanced; the
  // /instance/settings links are instance-admin only.
  it("keeps Evaluation under Advanced and gates instance links on instance admins", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    let root = await renderSidebar();

    const expandAdvanced = async () => {
      const trigger = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Advanced",
      );
      await act(async () => {
        trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
    };

    await expandAdvanced();
    let hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/evaluation");
    // Not an instance admin: the /instance/settings group is absent.
    expect(hrefs.some((h) => h?.startsWith("/instance/settings"))).toBe(false);
    await act(async () => root.unmount());

    mockCapabilitiesApi.get.mockResolvedValue({
      capabilities: {},
      membershipRole: "member",
      isInstanceAdmin: true,
    });
    root = await renderSidebar();
    await expandAdvanced();
    hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/instance/settings/heartbeats");
    expect(hrefs).toContain("/instance/settings/plugins");
    await act(async () => root.unmount());
  });

  it("keeps the MK sidebar unchanged, including Evaluation and per-entity lists", async () => {
    mockCompany.current = {
      id: "company-1",
      issuePrefix: "PAP",
      name: "Paperclip",
      productProfile: "agentdash_mk",
    };
    const root = await renderSidebar();
    const inbox = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/inbox");
    expect(inbox?.textContent).toContain("Inbox");
    expect([...container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/decisions")).toBe(false);
    expect(mockDashboardApi.waitingOnYou).not.toHaveBeenCalled();

    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const href of ["/my-agent", "/guides", "/inbox", "/issues", "/routines", "/goals", "/org", "/skills", "/costs", "/evaluation", "/billing", "/activity", "/company/settings"]) {
      expect(hrefs, `expected ${href}`).toContain(href);
    }
    expect(container.textContent).toContain("Projects list");
    expect(container.textContent).toContain("Agents list");
    // No Advanced group on MK.
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Advanced")).toBe(false);
    // No Team item or nested agent toggle on MK; its Agents section is unchanged.
    expect([...container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/agents")).toBe(false);
    expect(
      [...container.querySelectorAll("button")].some((b) => /^(Show|Hide) agents$/.test(b.getAttribute("aria-label") ?? "")),
    ).toBe(false);
    await act(async () => root.unmount());
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  });
});
