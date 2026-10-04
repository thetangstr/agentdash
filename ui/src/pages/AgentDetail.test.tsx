// @vitest-environment jsdom
//
// OBS-2 (#695): the ceiling status line is the pause's visibility surface. A
// steward has to be able to read, at a glance, that the agent stopped waking
// itself — and that assigned work still runs — or the ceiling reads as a bug.

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import type { AgentRunHealth, AgentTokenCeilingStatus, HeartbeatRun } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";

// AgentDetail's import graph reaches `@mdxeditor/editor` via AgentConfigForm →
// MarkdownEditor, and its Sandpack dependency throws inside jsdom's CSS
// parser. The status line never renders the editor, so it is mocked to a stub.
vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

// MarkdownBody needs ThemeProvider and the editor stack; rendered text is all
// these tests assert on, so it is a passthrough.
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

// ScrollToBottom reads the page panel context; there is no panel in a bare
// component render.
vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ togglePanelVisible: vi.fn() }),
}));

// The app router resolves company prefixes through CompanyContext; these
// tests assert rendered content, not navigation, so navigation primitives
// are stubs.
vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  const StubLink = ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  );
  return {
    ...actual,
    Link: StubLink,
    CompanyLink: StubLink,
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    Navigate: () => null,
    useBeforeUnload: () => undefined,
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TokenCeilingStatusLine, agentBilledByProvider, AgentRunHealthSummary, RunStderrExcerpt, CostsSection, RunDetail, LatestRunCard } = await import("./AgentDetail");

function statusFixture(overrides: Partial<AgentTokenCeilingStatus> = {}): AgentTokenCeilingStatus {
  return {
    ceiling: 5_000_000,
    isDefault: true,
    tokensToday: 1_250_000,
    meteredRuns: 12,
    unmeteredRuns: 0,
    unmeteredPausableRuns: 0,
    paused: false,
    pauseReason: null,
    liftsAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function render(status: AgentTokenCeilingStatus, onSave = vi.fn(), pending = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <TooltipProvider>
        <TokenCeilingStatusLine status={status} pending={pending} onSave={onSave} />
      </TooltipProvider>,
    );
  });
  return onSave;
}

function renderNode(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

function runHealthFixture(overrides: Partial<AgentRunHealth> = {}): AgentRunHealth {
  return {
    total: 0,
    succeeded: 0,
    failed: 0,
    succeededWithoutEvidence: 0,
    neverRan: true,
    chatTurns: 0,
    chatTurnsThisMonth: 0,
    tokenCeilingPause: null,
    last: null,
    ...overrides,
  };
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("TokenCeilingStatusLine", () => {
  it("shows the daily ceiling and today's usage", () => {
    render(statusFixture());
    const text = container!.textContent ?? "";
    expect(text).toContain("Daily token ceiling");
    expect(text).toContain("(default)");
    // Scan 4 lane O1: the ceiling count includes cached reads; it says so.
    expect(text).toContain("counted toward it today (counts cached reads)");
    expect(text).not.toContain("used today");
    expect(text).not.toContain("paused");
  });

  it("announces the pause with the UTC lift time and what still runs", () => {
    render(statusFixture({ paused: true, tokensToday: 5_200_000 }));
    const text = container!.textContent ?? "";
    expect(text).toContain("Timer and comment wakes are paused until");
    expect(text).toContain("UTC");
    expect(text).toContain("assigned work and manual wakes still run");
    // The paused affordance is the recovery path, not a bare Edit.
    expect(text).toContain("Raise or clear");
  });

  it("names the unmetered runaway guard when it caused the pause", () => {
    render(
      statusFixture({
        paused: true,
        pauseReason: "unmetered runaway guard",
        unmeteredPausableRuns: 49,
        unmeteredRuns: 49,
      }),
    );
    const text = container!.textContent ?? "";
    expect(text).toContain("unmetered runaway guard");
    expect(text).toContain("49 unmetered unattended runs");
    expect(text).toContain("assigned work and manual wakes still run");
  });

  it("says off when the ceiling is disabled", () => {
    render(statusFixture({ ceiling: null, isDefault: false }));
    expect(container!.textContent).toContain("Daily token ceiling: off");
  });

  it("shows the unmetered-run count when metering is off", () => {
    render(statusFixture({ unmeteredRuns: 3 }));
    expect(container!.textContent).toContain("3 runs unmetered");
  });

  it("saves a typed ceiling and turns the ceiling off", () => {
    const onSave = render(statusFixture());
    const editButton = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Edit",
    )!;
    act(() => editButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const input = container!.querySelector("input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "8000000");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const save = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    act(() => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith(8_000_000);

    // Reopen and turn off.
    const editAgain = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Edit",
    )!;
    act(() => editAgain.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const off = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Turn off",
    )!;
    act(() => off.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSave).toHaveBeenCalledWith(0);
  });

  it("keeps Save disabled on a non-numeric draft", () => {
    render(statusFixture());
    const editButton = [...container!.querySelectorAll("button")].find(
      (b) => b.textContent === "Edit",
    )!;
    act(() => editButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const save = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    expect(save.disabled).toBe(true);
  });
});

// Scan 4 lane O1: on BYOK the agent page said "Spend this month $0.00" next to
// real usage; it now says the model provider bills it.
describe("agentBilledByProvider", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const run = (inputTokens: number, outputTokens: number, createdAt = "2026-10-02T09:00:00.000Z", extra = {}) =>
    ({ usageJson: { inputTokens, outputTokens, ...extra }, resultJson: null, createdAt }) as never;

  it("is true when this month's runs used tokens but no dollars were metered", () => {
    expect(agentBilledByProvider({ spentMonthlyCents: 0 }, [run(32_000, 2_900)], now)).toBe(true);
  });

  it("is false when dollars were metered, or nothing ran", () => {
    expect(agentBilledByProvider({ spentMonthlyCents: 120 }, [run(32_000, 2_900)], now)).toBe(false);
    expect(agentBilledByProvider({ spentMonthlyCents: 0 }, [], now)).toBe(false);
    expect(
      agentBilledByProvider({ spentMonthlyCents: 0 }, [{ usageJson: null, resultJson: null, createdAt: "2026-10-02T09:00:00.000Z" } as never], now),
    ).toBe(false);
  });

  it("counts only this month's runs", () => {
    expect(agentBilledByProvider({ spentMonthlyCents: 0 }, [run(32_000, 2_900, "2026-09-28T09:00:00.000Z")], now)).toBe(false);
  });

  it("is false when a run this month shows a dollar cost", () => {
    expect(
      agentBilledByProvider({ spentMonthlyCents: 0 }, [run(32_000, 2_900), run(1_000, 100, "2026-10-03T09:00:00.000Z", { costUsd: 0.12 })], now),
    ).toBe(false);
  });

  it("is true when this month's usage was only chat turns (CoS does no runs)", () => {
    expect(
      agentBilledByProvider(
        { spentMonthlyCents: 0, runHealth: { chatTurnsThisMonth: 14 } },
        [],
        now,
      ),
    ).toBe(true);
  });
});

// Batch 2 canary: "This agent has never run" + "$0.00" sat on a Chief of Staff
// that had run the whole chat; chat turns count as activity.
describe("AgentRunHealthSummary", () => {
  it("says the agent never ran only when it truly did nothing", () => {
    renderNode(<AgentRunHealthSummary runHealth={runHealthFixture()} />);
    expect(container!.textContent).toContain("This agent has never run");
  });

  it("names chat activity instead of claiming the agent never ran", () => {
    renderNode(<AgentRunHealthSummary runHealth={runHealthFixture({ chatTurns: 12 })} />);
    const text = container!.textContent ?? "";
    expect(text).toContain("answered 12 chat messages");
    expect(text).not.toContain("never run");
  });

  it("shows an operator-stopped run neutrally, not as a red control-plane error", () => {
    renderNode(
      <AgentRunHealthSummary
        runHealth={runHealthFixture({
          neverRan: false,
          total: 3,
          succeeded: 2,
          last: {
            status: "cancelled",
            error: "Cancelled by control plane",
            errorCode: "cancelled_by_operator",
            finishedAt: "2026-10-02T10:00:00.000Z",
            leftEvidence: false,
          },
        })}
      />,
    );
    const text = container!.textContent ?? "";
    expect(text).toContain("stopped manually");
    expect(text).not.toContain("Cancelled by control plane");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a system cancellation's real reason, neutral — not 'stopped manually'", () => {
    renderNode(
      <AgentRunHealthSummary
        runHealth={runHealthFixture({
          neverRan: false,
          total: 3,
          succeeded: 2,
          last: {
            status: "cancelled",
            error: "Cancelled due to budget pause",
            errorCode: "cancelled",
            finishedAt: "2026-10-02T10:00:00.000Z",
            leftEvidence: false,
          },
        })}
      />,
    );
    const text = container!.textContent ?? "";
    expect(text).not.toContain("stopped manually");
    expect(text).not.toContain("stopped by you");
    expect(text).toContain("Last run cancelled: Cancelled due to budget pause");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("keys manual-stop detection on the error code, not the message text", () => {
    // A cancelled run whose code is the generic "cancelled" is a system
    // cancellation even when the message happens to match the operator text —
    // subtree-hold and comment-interrupt cancels share that generic code.
    renderNode(
      <AgentRunHealthSummary
        runHealth={runHealthFixture({
          neverRan: false,
          total: 3,
          succeeded: 2,
          last: {
            status: "cancelled",
            error: "Interrupted: the issue was held by a subtree pause",
            errorCode: "cancelled",
            finishedAt: "2026-10-02T10:00:00.000Z",
            leftEvidence: false,
          },
        })}
      />,
    );
    const text = container!.textContent ?? "";
    expect(text).not.toContain("stopped manually");
    expect(text).toContain(
      "Last run cancelled: Interrupted: the issue was held by a subtree pause",
    );
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a failed last run as an error", () => {
    renderNode(
      <AgentRunHealthSummary
        runHealth={runHealthFixture({
          neverRan: false,
          total: 3,
          succeeded: 2,
          failed: 1,
          last: {
            status: "failed",
            error: "process exited 1",
            errorCode: "adapter_error",
            finishedAt: "2026-10-02T10:00:00.000Z",
            leftEvidence: false,
          },
        })}
      />,
    );
    expect(container!.querySelector('[role="alert"]')).not.toBeNull();
    expect(container!.textContent).toContain("Last run failed (adapter_error): process exited 1");
  });
});

// Batch 2 canary: a succeeded run's stderr is adapter chatter, not an error —
// and host paths stay masked.
describe("RunStderrExcerpt", () => {
  it("hides a succeeded run's stderr behind Technical details, unred", () => {
    renderNode(
      <RunStderrExcerpt
        censorUsernameInLogs={true}
        run={{
          status: "succeeded",
          stderrExcerpt: "SyntaxWarning at /Users/operator/.hermes/run.py",
        }}
      />,
    );
    const details = container!.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.textContent).toContain("Technical details");
    expect(details!.textContent).toContain("/Users/o*******/.hermes/run.py");
    expect(details!.textContent).not.toContain("operator");
    expect(container!.querySelector(".text-red-700")).toBeNull();
  });

  it("follows the instance setting: shows the raw path when censoring is off", () => {
    renderNode(
      <RunStderrExcerpt
        censorUsernameInLogs={false}
        run={{
          status: "succeeded",
          stderrExcerpt: "SyntaxWarning at /Users/operator/.hermes/run.py",
        }}
      />,
    );
    expect(container!.textContent).toContain("/Users/operator/.hermes/run.py");
  });

  it("keeps the red stderr box for failed runs, still path-masked", () => {
    renderNode(
      <RunStderrExcerpt
        censorUsernameInLogs={true}
        run={{
          status: "failed",
          stderrExcerpt: "Traceback at /home/ubuntu/.hermes/run.py",
        }}
      />,
    );
    expect(container!.querySelector("details")).toBeNull();
    expect(container!.textContent).toContain("stderr");
    expect(container!.textContent).toContain("/home/u*****/.hermes/run.py");
    expect(container!.querySelector(".text-red-700")).not.toBeNull();
  });

  it("renders nothing when the excerpt is empty", () => {
    renderNode(<RunStderrExcerpt censorUsernameInLogs={true} run={{ status: "succeeded", stderrExcerpt: "  " }} />);
    expect(container!.textContent).toBe("");
  });
});

// AgentDash (batch 2): the agent page's "Total cost" tile must not print
// $0.00 on a BYOK workspace — the owner's provider billed real money the
// control plane cannot see.
describe("CostsSection on BYOK", () => {
  function runtimeState(overrides: Record<string, unknown> = {}) {
    return {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "hermes_local",
      sessionId: null,
      stateJson: {},
      lastRunId: null,
      lastRunStatus: null,
      totalInputTokens: 36_100,
      totalOutputTokens: 1_200,
      totalCachedInputTokens: 50_000,
      totalCostCents: 0,
      lastError: null,
      createdAt: new Date("2026-10-02T10:00:00.000Z"),
      updatedAt: new Date("2026-10-02T10:02:49.000Z"),
      ...overrides,
    } as never;
  }

  function renderCosts(runtimeState?: Record<string, unknown>) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<CostsSection runtimeState={runtimeState as never} runs={[]} />);
    });
    return container.textContent ?? "";
  }

  it("says 'Billed by your model provider' instead of $0.00 when usage is unpriced", () => {
    const text = renderCosts(runtimeState());
    expect(text).toContain("Total cost");
    expect(text).toContain("Billed by your model provider");
    expect(text).not.toContain("$0.00");
    // The token figures still render — they are the honest number.
    expect(text).toContain("36.1k");
  });

  it("shows real dollars when spend is priced", () => {
    const text = renderCosts(runtimeState({ totalCostCents: 4200 }));
    expect(text).toContain("$42.00");
    expect(text).not.toContain("Billed by your model provider");
  });

  it("shows a dash when nothing ran at all", () => {
    const text = renderCosts(
      runtimeState({ totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0 }),
    );
    expect(text).not.toContain("Billed by your model provider");
    expect(text).not.toContain("$0.00");
  });
});

function heartbeatRunFixture(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "cancelled",
    startedAt: new Date("2026-10-03T10:00:00.000Z"),
    finishedAt: new Date("2026-10-03T10:00:05.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: null,
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
    processGroupId: null,
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
    createdAt: new Date("2026-10-03T10:00:00.000Z"),
    updatedAt: new Date("2026-10-03T10:00:05.000Z"),
    ...overrides,
  };
}

describe("RunDetail on a cancelled run", () => {
  function renderRunDetail(run: HeartbeatRun) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    renderNode(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ToastProvider>
            <TooltipProvider>
              <RunDetail run={run} agentRouteId="agent-1" adapterType="process" adapterConfig={{}} />
            </TooltipProvider>
          </ToastProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return container!.textContent ?? "";
  }

  it("hides the harness-recovery panel and the red exit code left by the killed adapter", () => {
    // The stale-failure canary: the adapter's post-kill write left a failed
    // classification in resultJson and exit 130 on the row, but the run is
    // cancelled — none of that is red failure chrome.
    const text = renderRunDetail(heartbeatRunFixture({
      error: "Stopped manually",
      errorCode: "cancelled_by_operator",
      exitCode: 130,
      signal: "SIGTERM",
      resultJson: {
        failureClassification: {
          category: "unknown",
          severity: "operator_action_required",
          title: "Run failed",
          detail: "The run ended unexpectedly.",
          nextActions: ["retry"],
        },
      },
    }));
    expect(text).not.toContain("Harness recovery");
    expect(text).not.toContain("Exit code");
    expect(text).toContain("Stopped manually");
  });

  it("still shows failure chrome on a genuinely failed run", () => {
    const text = renderRunDetail(heartbeatRunFixture({
      status: "failed",
      error: "adapter exited",
      exitCode: 1,
      resultJson: {
        failureClassification: {
          category: "unknown",
          severity: "operator_action_required",
          title: "Run failed",
          detail: "The run ended unexpectedly.",
          nextActions: ["retry"],
        },
      },
    }));
    expect(text).toContain("Harness recovery");
    expect(text).toContain("Exit code 1");
  });
});

describe("LatestRunCard on a cancelled run", () => {
  it("shows the recorded stop reason when no summary was written", () => {
    renderNode(
      <MemoryRouter>
        <LatestRunCard
          agentId="agent-1"
          runs={[heartbeatRunFixture({
            status: "cancelled",
            error: "Stopped manually",
            errorCode: "cancelled_by_operator",
          })]}
        />
      </MemoryRouter>,
    );
    const text = container!.textContent ?? "";
    expect(text).toContain("Stopped manually");
  });
});
