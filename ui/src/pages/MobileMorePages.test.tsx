// @vitest-environment jsdom

// AgentDash: mobile redesign, lane C — the More pages switch to the shared
// phone list pattern at 390px and keep their desktop markup at 1280px.

import { act } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ActivityEvent, Goal } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockViewportWidth } from "../lib/test-viewport";
import { Projects } from "./Projects";
import { Activity } from "./Activity";
import { ActivityRow } from "../components/ActivityRow";
import { GoalTree } from "../components/GoalTree";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className, style }: { to: string; children: ReactNode; className?: string; style?: CSSProperties }) => (
    <a href={to} className={className} style={style}>
      {children}
    </a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", loading: false }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewProject: vi.fn(), openNewGoal: vi.fn() }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn(async () => [
      {
        id: "project-1",
        companyId: "company-1",
        urlKey: "website-relaunch",
        name: "Website relaunch with a deliberately long project name",
        description: "Rebuild the marketing site.",
        status: "in_progress",
        targetDate: null,
        archivedAt: null,
      },
    ]),
  },
}));

const EVENT: ActivityEvent = {
  id: "event-1",
  companyId: "company-1",
  actorType: "user",
  actorId: "user-1",
  action: "issue.created",
  entityType: "issue",
  entityId: "issue-1",
  agentId: null,
  runId: null,
  details: { identifier: "ACM-7", issueTitle: "Ship the pricing page" },
  createdAt: new Date(),
} as unknown as ActivityEvent;

vi.mock("../api/activity", () => ({
  activityApi: { list: vi.fn(async () => [EVENT]) },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    listUserDirectory: vi.fn(async () => ({
      users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Dana", email: "dana@example.com", image: null } }],
    })),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("More pages at phone and desktop widths", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(node: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("Projects: card rows on a phone", async () => {
    mockViewportWidth(390);
    render(<Projects />);
    await flush();
    const list = container.querySelector("[data-testid='projects-mobile-list']");
    expect(list).not.toBeNull();
    const row = list!.querySelector("a")!;
    expect(row.className).toContain("min-h-11");
    expect(row.textContent).toContain("Website relaunch with a deliberately long project name");
    expect(row.textContent).toContain("Rebuild the marketing site.");
  });

  it("Projects: the desktop entity rows are unchanged", async () => {
    mockViewportWidth(1280);
    render(<Projects />);
    await flush();
    expect(container.querySelector("[data-testid='projects-mobile-list']")).toBeNull();
    expect(container.textContent).toContain("Website relaunch with a deliberately long project name");
  });

  it("Activity: two-line rows on a phone, one-line rows on desktop", async () => {
    mockViewportWidth(390);
    render(<Activity />);
    await flush();
    expect(container.querySelector("[data-testid='activity-row-stacked']")).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    mockViewportWidth(1280);
    render(<Activity />);
    await flush();
    expect(container.querySelector("[data-testid='activity-row-stacked']")).toBeNull();
    expect(container.textContent).toContain("ACM-7");
  });

  it("ActivityRow stacked: actor + action first, target + time second", () => {
    render(
      <ActivityRow
        event={EVENT}
        agentMap={new Map()}
        entityNameMap={new Map([["issue:issue-1", "ACM-7"]])}
        entityTitleMap={new Map([["issue:issue-1", "Ship the pricing page"]])}
        layout="stacked"
      />,
    );
    const stacked = container.querySelector("[data-testid='activity-row-stacked']")!;
    const [lineOne, lineTwo] = Array.from(stacked.children);
    expect(lineOne!.textContent).toContain("Board");
    expect(lineOne!.textContent).not.toContain("ACM-7");
    expect(lineTwo!.textContent).toContain("ACM-7");
    expect(lineTwo!.textContent).toContain("Ship the pricing page");
    expect(lineTwo!.textContent).toContain("just now");
    expect(container.querySelector("a")!.className).toContain("min-h-11");
  });

  it("GoalTree: nested goals indent and titles may wrap on phones", () => {
    const goals = [
      { id: "g1", title: "Parent goal", level: "company", status: "active", parentId: null },
      { id: "g2", title: "A long child goal title that has to wrap on a phone", level: "team", status: "planned", parentId: "g1" },
    ] as unknown as Goal[];
    render(<GoalTree goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLElement).style.paddingLeft).toBe("12px");
    expect((links[1] as HTMLElement).style.paddingLeft).toBe("28px");
    expect(links[1]!.className).toContain("max-sm:min-h-11");
    const title = Array.from(links[1]!.querySelectorAll("span")).find((el) => el.textContent?.startsWith("A long child"))!;
    expect(title.className).toContain("max-sm:whitespace-normal");
    expect(container.querySelector("button[aria-label='Collapse Parent goal']")).not.toBeNull();
  });
});
