// @vitest-environment jsdom
//
// UX-14 (GH #795): agent detail leads with doing/shipped/spend, a health
// warning when recent runs keep leaving nothing, three top tabs with the
// detail views folded under Settings, and an honest "No summary." state —
// the same for every company (one UX).

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";

// AgentDetail's import graph reaches `@mdxeditor/editor` via AgentConfigForm →
// MarkdownEditor, and its Sandpack dependency throws inside jsdom's CSS parser.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

// The summary body renders through MarkdownBody, which needs ThemeProvider;
// these tests assert text content, not markdown rendering.
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

// Links are navigation affordances; the assertions care about hrefs, not the
// router's company-prefix resolution.
vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      className,
    }: {
      to: string;
      children: ReactNode;
      className?: string;
    }) => (
      <a href={to} className={className}>
        {children}
      </a>
    ),
  };
});

const listShippedMock = vi.fn(async () => ({
  items: [
    {
      id: "wp-1",
      title: "PR #42: agent vitals",
      createdAt: new Date("2026-09-28T10:00:00Z"),
      issue: {
        id: "issue-1",
        identifier: "AGE-12",
        title: "Agent vitals",
        status: "done",
        projectId: null,
      },
    },
  ],
  total: 1,
  nextCursor: null,
  monthTotal: { since: "2026-09-01T00:00:00Z", count: 1, pullRequests: 1 },
}));

vi.mock("../api/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/issues")>();
  return {
    ...actual,
    issuesApi: { ...actual.issuesApi, listShipped: listShippedMock },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  AgentRunHealthNote,
  AgentVitalsStrip,
  LatestRunCard,
  agentDetailInSettings,
  agentDetailTabValue,
  AGENT_DETAIL_TOP_TABS,
  runsLeftNothingShare,
} = await import("./AgentDetail");

function runFixture(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: null,
    status: "succeeded",
    startedAt: new Date("2026-09-28T10:00:00Z"),
    finishedAt: new Date("2026-09-28T10:01:00Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    createdAt: new Date("2026-09-28T10:00:00Z"),
    updatedAt: new Date("2026-09-28T10:01:00Z"),
    ...overrides,
  } as HeartbeatRun;
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function render(node: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("tab grouping (every company)", () => {
  it("reduces the top tabs to Overview, Runs, and Settings", () => {
    expect(AGENT_DETAIL_TOP_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Runs",
      "Settings",
    ]);
  });

  it("highlights Settings for every detail view", () => {
    for (const view of ["instructions", "skills", "configuration", "budget", "mandates"] as const) {
      expect(agentDetailTabValue(view)).toBe("settings");
      expect(agentDetailInSettings(view)).toBe(true);
    }
    expect(agentDetailTabValue("runs")).toBe("runs");
    expect(agentDetailTabValue("dashboard")).toBe("dashboard");
  });

  it("keeps the bare /settings URL inside the group", () => {
    expect(agentDetailInSettings("settings")).toBe(true);
    expect(agentDetailTabValue("settings")).toBe("settings");
  });
});

describe("runsLeftNothingShare", () => {
  it("counts no-op outcomes over evaluated runs", () => {
    const runs = [
      runFixture({ livenessState: "empty_response" }),
      runFixture({ livenessState: "empty_response" }),
      runFixture({ livenessState: "advanced" }),
      runFixture({ livenessState: "completed" }),
      runFixture({ livenessState: "plan_only" }),
    ];
    expect(runsLeftNothingShare(runs)).toEqual({ evaluated: 5, leftNothing: 3 });
  });

  it("ignores live runs and runs with no liveness verdict", () => {
    const runs = [
      runFixture({ status: "running" }),
      runFixture({ livenessState: null }),
      runFixture({ livenessState: "empty_response" }),
    ];
    expect(runsLeftNothingShare(runs)).toEqual({ evaluated: 1, leftNothing: 1 });
  });

  it("only looks at the ten most recent finished runs", () => {
    const runs = [
      ...Array.from({ length: 10 }, (_, i) =>
        runFixture({ livenessState: "advanced", createdAt: new Date(1000 + i) }),
      ),
      runFixture({ livenessState: "empty_response", createdAt: new Date(500) }),
    ];
    expect(runsLeftNothingShare(runs)).toEqual({ evaluated: 10, leftNothing: 0 });
  });
});

describe("AgentRunHealthNote", () => {
  it("warns when most recent runs left nothing behind", () => {
    const runs = [
      runFixture({ livenessState: "empty_response" }),
      runFixture({ livenessState: "empty_response" }),
      runFixture({ livenessState: "plan_only" }),
      runFixture({ livenessState: "advanced" }),
    ];
    render(<AgentRunHealthNote runs={runs} />);
    const note = container!.querySelector('[data-testid="agent-run-health-warning"]');
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("3 of the last 4 runs");
  });

  it("stays quiet below the warning fraction", () => {
    const runs = [
      runFixture({ livenessState: "empty_response" }),
      runFixture({ livenessState: "empty_response" }),
      runFixture({ livenessState: "advanced" }),
      runFixture({ livenessState: "completed" }),
      runFixture({ livenessState: "completed" }),
    ];
    render(<AgentRunHealthNote runs={runs} />);
    expect(container!.querySelector('[data-testid="agent-run-health-warning"]')).toBeNull();
  });

  it("stays quiet when too few runs have a verdict", () => {
    const runs = [
      runFixture({ livenessState: "empty_response" }),
      runFixture({ livenessState: "empty_response" }),
    ];
    render(<AgentRunHealthNote runs={runs} />);
    expect(container!.querySelector('[data-testid="agent-run-health-warning"]')).toBeNull();
  });
});

describe("LatestRunCard empty summary", () => {
  it("says 'No summary.' when asked to", () => {
    render(
      <LatestRunCard runs={[runFixture()]} agentId="agent-1" showEmptySummary />,
    );
    expect(container!.textContent).toContain("No summary.");
  });

  it("leaves the body blank by default", () => {
    render(<LatestRunCard runs={[runFixture()]} agentId="agent-1" />);
    expect(container!.textContent).not.toContain("No summary.");
  });
});

describe("AgentVitalsStrip", () => {
  const agent = {
    id: "agent-1",
    companyId: "company-1",
    name: "Maya",
    adapterType: "claude",
    budgetMonthlyCents: 5000,
    spentMonthlyCents: 1234,
    metadata: {},
    status: "active",
    role: "engineer",
    icon: "bot",
  } as never;

  it("shows doing, last shipped, and month spend", async () => {
    render(
      <AgentVitalsStrip
        agent={agent}
        runs={[]}
        assignedIssues={[
          { id: "issue-2", title: "Ship the vitals strip", status: "in_progress", identifier: "AGE-9" },
        ]}
      />,
    );
    await flush();
    expect(listShippedMock).toHaveBeenCalled();
    const text = container!.textContent ?? "";
    expect(text).toContain("Doing now");
    expect(text).toContain("Ship the vitals strip");
    expect(text).toContain("Last shipped");
    expect(text).toContain("PR #42: agent vitals");
    expect(text).toContain("Spend this month");
    expect(text).toContain("$12.34");
  });

  it("leads with the live run's issue when one is running", async () => {
    render(
      <AgentVitalsStrip
        agent={agent}
        runs={[
          runFixture({
            status: "running",
            contextSnapshot: { issueId: "issue-3" },
          }),
        ]}
        assignedIssues={[
          { id: "issue-3", title: "Live-run task", status: "in_progress", identifier: "AGE-7" },
        ]}
      />,
    );
    await flush();
    expect(container!.textContent).toContain("Live-run task");
  });
});
