// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agents } from "./Agents";
import { PHONE_WIDTH, mockViewportWidth } from "../lib/test-viewport";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  org: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/agents/all", search: "", hash: "", state: null }),
  useNavigate: () => vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  selectedCompany: undefined as { id: string } | undefined,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: companyState.selectedCompany }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewAgent: mockOpenNewAgent }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterLabel: (type: string) => type,
  plainRuntimeLabel: (type: string) => (type.endsWith("_local") ? "Runs on your server" : type),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    adapterType: "codex_local",
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

describe("Agents", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ adapterConfig: { model: "gpt-5.4" } }),
    ]);
    mockAgentsApi.org.mockResolvedValue([
      {
        id: "agent-1",
        name: "Alpha",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ]);
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

  it("marks an agent with no heartbeat schedule, which otherwise looks identical to a working one", async () => {
    // runtimeConfig.heartbeat.enabled defaults absent and the heartbeat service
    // reads missing-or-false as never-run-this-agent. The agent sits at idle
    // and does nothing forever; MKThink's instance recorded zero runs for days
    // that way, with nothing on this page to say so.
    mockAgentsApi.list.mockResolvedValue([makeAgent({ runtimeConfig: {} })]);

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Agents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Runs when asked");
  });

  it("says nothing about scheduling for an agent that does wake on its own", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ runtimeConfig: { heartbeat: { enabled: true, intervalSec: 1800 } } }),
    ]);

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Agents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Runs when asked");
  });

  it("shows the configured model beside the adapter on the all agents page", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Agents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Runs on your server");
    expect(container.textContent).toContain("gpt-5.4");
  });

  it("names the list/org view toggle (c3-a11y)", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Agents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const group = container.querySelector('[role="group"][aria-label="Agents view"]');
    expect(group).not.toBeNull();
    expect(group!.querySelector('button[aria-label="List view"][aria-pressed]')).not.toBeNull();
    expect(group!.querySelector('button[aria-label="Org chart view"][aria-pressed]')).not.toBeNull();
  });

  it("points an empty Team page at Ask for a hire for every company (UX-11)", async () => {
    mockAgentsApi.list.mockResolvedValue([]);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Agents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain(
      "Your Chief of Staff hires agents when an issue needs them. You can also ask for one.",
    );
    const ask = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "Ask for a hire");
    expect(ask?.getAttribute("href")).toBe("/cos");
    expect(mockOpenNewAgent).not.toHaveBeenCalled();
  });

  describe("on a phone (390px)", () => {
    let restoreViewport: () => void;
    beforeEach(() => {
      restoreViewport = mockViewportWidth(PHONE_WIDTH);
    });
    afterEach(() => {
      restoreViewport();
    });

    async function renderAgents() {
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <Agents />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();
    }

    it("renders two-line cards with the full, untruncated name and the chips on their own line", async () => {
      mockAgentsApi.list.mockResolvedValue([
        makeAgent({ name: "Chief of Staff with a long name", role: "general", title: "deployment_lead", runtimeConfig: {} }),
      ]);
      await renderAgents();

      const cards = container.querySelectorAll('[data-testid="agent-phone-card"]');
      expect(cards).toHaveLength(1);
      const name = container.querySelector('[data-testid="agent-phone-name"]')!;
      expect(name.textContent).toBe("Chief of Staff with a long name");
      expect(name.className).not.toContain("truncate");
      expect(name.className).toContain("break-words");
      // Kind, status and schedule chips share the second line, at 12px.
      const kind = cards[0]!.querySelector('[data-testid^="agent-kind-"]')!;
      expect(kind.className).toContain("text-xs");
      expect(kind.className).not.toContain("text-[10px]");
      expect(cards[0]!.textContent).toContain("Runs when asked");
      expect(cards[0]!.textContent).toContain("Deployment Lead");
    });

    it("collapses the toolbar to a primary New agent button and a ⋯ menu", async () => {
      await renderAgents();

      const toolbar = container.querySelector('[data-testid="agents-phone-toolbar"]')!;
      expect(toolbar).not.toBeNull();
      const newAgent = Array.from(toolbar.querySelectorAll("button")).find((b) => b.textContent?.includes("New agent"));
      expect(newAgent?.className).toContain("h-11");
      expect(toolbar.querySelector('[aria-label="More agent actions"]')).not.toBeNull();
      // Filters and "Set up a role" moved into the menu.
      expect(container.textContent).not.toContain("Filters");
      expect(container.textContent).not.toContain("Set up a role");

      await act(async () => {
        newAgent!.click();
      });
      expect(mockOpenNewAgent).toHaveBeenCalledTimes(1);
    });
  });
});
