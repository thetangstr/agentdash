// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";
import { isSidebarMoreRoute } from "./SidebarMoreGroup";

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

const mockLocation = vi.hoisted(() => ({ pathname: "/PAP/dashboard" }));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: mockLocation.pathname, search: "", hash: "", state: null }),
  Link: ({ to, children, className, ...props }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className} {...props}>
      {children}
    </a>
  ),
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

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Company menu</div>,
}));

// The row hook is mocked so the default-profile Team list can be driven
// without the agents/session/mutation plumbing; the row renderer emits one
// link per agent, like the real SidebarAgentItem.
const mockAgentRows = vi.hoisted(() => ({
  agents: [] as Array<{ id: string; name: string; urlKey: string }>,
  userId: "user-1" as string | null,
}));

vi.mock("./SidebarAgents", () => ({
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
    mockLocation.pathname = "/PAP/dashboard";
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });
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

  // AgentDash: one UX (doc/plans/2026-09-30-one-ux.md) — every company gets
  // the same sidebar; these helpers drive it.
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

  const findMoreTrigger = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === "More");

  async function toggleMore() {
    await act(async () => {
      findMoreTrigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  const MK_COMPANY = {
    id: "company-1",
    issuePrefix: "PAP",
    name: "Paperclip",
    productProfile: "agentdash_mk",
  };

  it("shows the Shipped link and calls the dashboard Home", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    const root = await renderSidebar();
    const link = [...container.querySelectorAll("a")].find((anchor) => anchor.textContent === "Shipped");
    expect(link?.getAttribute("href")).toBe("/shipped");
    const home = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/dashboard");
    expect(home?.textContent).toContain("Home");
    await act(async () => root.unmount());
  });

  // One UX: an MK company gets exactly the sidebar every other company gets.
  it("renders the same sidebar for an MK company — no Inbox, no Dashboard label", async () => {
    mockCompany.current = MK_COMPANY;
    const root = await renderSidebar();
    const primaryBlock = container.querySelector("nav > div");
    const primaryHrefs = [...primaryBlock!.querySelectorAll("a")]
      .map((a) => a.getAttribute("href"))
      .filter((h) => !h?.startsWith("/agents/"));
    expect(primaryHrefs).toEqual(["/dashboard", "/cos", "/issues", "/decisions", "/shipped", "/agents"]);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/inbox");
    const dashboard = [...container.querySelectorAll("a")].find((anchor) => anchor.getAttribute("href") === "/dashboard");
    expect(dashboard?.textContent).toContain("Home");
    expect(mockDashboardApi.waitingOnYou).toHaveBeenCalledWith("company-1");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "More")).toBe(true);
    expect(container.textContent).not.toContain("Advanced");
    await act(async () => root.unmount());
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
  });

  // AgentDash: UX-7 (GH #788) — the Decisions badge is the page's main-list
  // length (approvals plus manual-origin assigned issues — machine-generated
  // rows don't count).
  it("shows Decisions with the waiting-list length as its badge", async () => {
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
  it("renders exactly the six primary items", async () => {
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
    // My Agent, Evaluation and the per-project list are not in the sidebar
    // at all (account menu, Settings hub, command palette); no Inbox item.
    expect(linkTexts).not.toContain("My Agent");
    expect(linkTexts).not.toContain("Inbox");
    expect(linkTexts).not.toContain("Evaluation");
    expect(hrefs.some((h) => h?.startsWith("/projects"))).toBe(false);

    // The agent list nests under Team (expanded by default), so apart from the
    // per-agent rows the primary block's links are still exactly the six
    // primary destinations (Settings sits in the footer).
    const primaryBlock = container.querySelector("nav > div");
    const primaryHrefs = [...primaryBlock!.querySelectorAll("a")]
      .map((a) => a.getAttribute("href"))
      .filter((h) => !h?.startsWith("/agents/"));
    expect(primaryHrefs).toEqual(["/dashboard", "/cos", "/issues", "/decisions", "/shipped", "/agents"]);
    await act(async () => root.unmount());
  });

  // UX-6 follow-up: the per-agent list sits under Team, expanded by default.
  describe("Agents list under Team", () => {
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

    it("shows the agent list by default behind an accessible toggle", async () => {
      const root = await renderSidebar();
      const toggle = findToggle();
      expect(toggle).toBeDefined();
      expect(toggle?.getAttribute("type")).toBe("button");
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      expect(toggle?.getAttribute("aria-label")).toBe("Hide agents");
      expect(toggle?.getAttribute("aria-controls")).toBeTruthy();
      // The chevron is a sibling of the Team link, never inside it, so
      // clicking it cannot navigate.
      expect(toggle?.closest("a")).toBeNull();
      expect(agentHrefs()).toEqual(["/agents/maya", "/agents/priya"]);
      const contentId = toggle?.getAttribute("aria-controls");
      expect(contentId && document.getElementById(contentId)?.textContent).toContain("Maya");
      const team = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/agents");
      expect(team?.textContent).toContain("Team");
      // Nothing is written until the viewer chooses.
      expect(localStorage.getItem("agentdash.sidebarTeamAgentsExpanded:company-1:user-1")).toBeNull();
      await act(async () => root.unmount());
    });

    it("remembers a collapse per user per company, and expanding again", async () => {
      let root = await renderSidebar();
      await clickToggle();

      const toggle = findToggle();
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(toggle?.getAttribute("aria-label")).toBe("Show agents");
      expect(agentHrefs()).toEqual([]);
      expect(localStorage.getItem("agentdash.sidebarTeamAgentsExpanded:company-1:user-1")).toBe("false");
      await act(async () => root.unmount());

      // Re-mount: the remembered collapse is honoured.
      root = await renderSidebar();
      expect(findToggle()?.getAttribute("aria-expanded")).toBe("false");
      expect(agentHrefs()).toEqual([]);

      // Expanding again is remembered too.
      await clickToggle();
      expect(agentHrefs()).toEqual(["/agents/maya", "/agents/priya"]);
      expect(localStorage.getItem("agentdash.sidebarTeamAgentsExpanded:company-1:user-1")).toBe("true");
      await act(async () => root.unmount());
    });

    it("still honours the expanded value older builds stored", async () => {
      localStorage.setItem("agentdash.sidebarTeamAgentsExpanded:company-1:user-1", "true");
      const root = await renderSidebar();
      expect(findToggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(agentHrefs()).toEqual(["/agents/maya", "/agents/priya"]);
      await act(async () => root.unmount());
    });

    it("does not apply another user's remembered collapse", async () => {
      localStorage.setItem("agentdash.sidebarTeamAgentsExpanded:company-1:user-2", "false");
      localStorage.setItem("agentdash.sidebarTeamAgentsExpanded:company-2:user-1", "false");
      const root = await renderSidebar();
      expect(findToggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(agentHrefs()).toEqual(["/agents/maya", "/agents/priya"]);
      await act(async () => root.unmount());
    });

    it("falls back to expanded when storage throws", async () => {
      const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      const root = await renderSidebar();
      expect(findToggle()?.getAttribute("aria-expanded")).toBe("true");
      getItem.mockRestore();
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

  // Sidebar IA: "Advanced" is gone. One collapsed "More" group with exactly
  // four items; configuration lives in the Settings hub, help behind "?".
  describe("More group", () => {
    beforeEach(() => {
      mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    });

    it("is collapsed by default and there is no Advanced group", async () => {
      const root = await renderSidebar();
      const trigger = findMoreTrigger();
      expect(trigger).toBeDefined();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Advanced")).toBe(false);
      const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      for (const href of ["/goals", "/routines", "/costs", "/activity"]) {
        expect(hrefs).not.toContain(href);
      }
      await act(async () => root.unmount());
    });

    it("holds exactly Goals, Routines, Costs and Activity", async () => {
      const root = await renderSidebar();
      await toggleMore();
      const contentId = findMoreTrigger()?.getAttribute("aria-controls");
      const content = contentId ? document.getElementById(contentId) : null;
      expect(content).not.toBeNull();
      const links = [...content!.querySelectorAll("a")];
      expect(links.map((a) => a.textContent)).toEqual(["Goals", "Routines", "Costs", "Activity"]);
      expect(links.map((a) => a.getAttribute("href"))).toEqual(["/goals", "/routines", "/costs", "/activity"]);
      await act(async () => root.unmount());
    });

    it("remembers the expanded state per user per company", async () => {
      let root = await renderSidebar();
      await toggleMore();
      expect(localStorage.getItem("agentdash.sidebarMoreExpanded:company-1:user-1")).toBe("true");
      await act(async () => root.unmount());

      root = await renderSidebar();
      expect(findMoreTrigger()?.getAttribute("aria-expanded")).toBe("true");
      await toggleMore();
      expect(findMoreTrigger()?.getAttribute("aria-expanded")).toBe("false");
      expect(localStorage.getItem("agentdash.sidebarMoreExpanded:company-1:user-1")).toBeNull();
      await act(async () => root.unmount());
    });

    it("does not apply another user's remembered state", async () => {
      localStorage.setItem("agentdash.sidebarMoreExpanded:company-1:user-2", "true");
      const root = await renderSidebar();
      expect(findMoreTrigger()?.getAttribute("aria-expanded")).toBe("false");
      await act(async () => root.unmount());
    });

    it("opens itself on one of its own pages, without changing the remembered state", async () => {
      mockLocation.pathname = "/PAP/costs";
      const root = await renderSidebar();
      expect(findMoreTrigger()?.getAttribute("aria-expanded")).toBe("true");
      const costs = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/costs");
      expect(costs).toBeDefined();
      expect(localStorage.getItem("agentdash.sidebarMoreExpanded:company-1:user-1")).toBeNull();
      // A hand collapse there is respected.
      await toggleMore();
      expect(findMoreTrigger()?.getAttribute("aria-expanded")).toBe("false");
      await act(async () => root.unmount());
      mockLocation.pathname = "/PAP/dashboard";
    });

    it("recognises its routes with or without the company prefix", () => {
      expect(isSidebarMoreRoute("/PAP/goals")).toBe(true);
      expect(isSidebarMoreRoute("/PAP/goals/g-1")).toBe(true);
      expect(isSidebarMoreRoute("/activity")).toBe(true);
      expect(isSidebarMoreRoute("/PAP/dashboard")).toBe(false);
      expect(isSidebarMoreRoute("/PAP/goalsx")).toBe(false);
    });

    it("falls back to collapsed when storage throws", async () => {
      const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
      const root = await renderSidebar();
      expect(findMoreTrigger()?.getAttribute("aria-expanded")).toBe("false");
      spy.mockRestore();
      await act(async () => root.unmount());
    });
  });

  // Everything that used to sit under Advanced is out of the sidebar, even
  // expanded, and for an instance admin.
  it("offers nothing else: no settings, help, instance or per-project links", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    mockCapabilitiesApi.get.mockResolvedValue({ capabilities: {}, membershipRole: "owner", isInstanceAdmin: true });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const root = await renderSidebar();
    await toggleMore();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const href of [
      "/my-agent", "/inbox/override", "/guides", "/org", "/skills", "/evaluation", "/billing",
      "/company/import", "/company/export", "/company/settings/environments", "/company/settings/health",
      "/workspaces",
    ]) {
      expect(hrefs, `unexpected ${href}`).not.toContain(href);
    }
    expect(hrefs.some((h) => h?.startsWith("/instance/"))).toBe(false);
    expect(hrefs.some((h) => h?.startsWith("/projects"))).toBe(false);
    // Six primary + four More + Settings (plus the per-agent rows under Team).
    expect(hrefs.filter((h) => !h?.startsWith("/agents/"))).toEqual([
      "/dashboard", "/cos", "/issues", "/decisions", "/shipped", "/agents",
      "/goals", "/routines", "/costs", "/activity",
      "/company/settings",
    ]);
    await act(async () => root.unmount());
  });

  describe("footer", () => {
    beforeEach(() => {
      mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    });

    it("pins Settings to the Settings hub", async () => {
      const root = await renderSidebar();
      const settings = [...container.querySelectorAll("a")].find((a) => a.textContent === "Settings");
      expect(settings?.getAttribute("href")).toBe("/company/settings");
      await act(async () => root.unmount());
    });

    it("opens a Help menu with Guides, Changelog and Health", async () => {
      const root = await renderSidebar();
      const help = container.querySelector('button[aria-label="Help"]');
      expect(help).not.toBeNull();
      expect(document.body.querySelector('[role="menu"]')).toBeNull();
      // The shared DropdownMenu opens on pointerdown (mouse) or Enter/Space.
      await act(async () => {
        help!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await flushReact();
      const menu = document.body.querySelector('[role="menu"]');
      expect(menu).not.toBeNull();
      const items = [...menu!.querySelectorAll('[role="menuitem"]')];
      expect(items.map((a) => a.textContent)).toEqual(["Guides", "Changelog", "Health"]);
      expect(items.map((a) => a.getAttribute("href"))).toEqual([
        "/guides",
        "/instance/settings/changelog",
        "/company/settings/health",
      ]);
      await act(async () => root.unmount());
    });
  });

  // /org is the Team page's Org chart tab, so Team stays highlighted there.
  it("highlights Team on the org chart", async () => {
    mockCompany.current = { id: "company-1", issuePrefix: "PAP", name: "Paperclip" };
    mockLocation.pathname = "/PAP/org";
    const root = await renderSidebar();
    const team = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/agents");
    expect(team?.className).toContain("bg-accent");
    await act(async () => root.unmount());
  });
});
