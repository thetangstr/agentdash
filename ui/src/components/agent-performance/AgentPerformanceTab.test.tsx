// @vitest-environment jsdom
//
// Agent Performance Management gate 1: the Performance tab answers six
// questions in order (overview LLD §1), each with counts and what they are
// out of. Unknown counts render "Unknown" and why — never 0 — and there is no
// gauge, score or ranking. The window, as-of time, the "current definitions;
// history unknown" label and the withheld sections are always shown.
// Gate 3: this view is the fallback when no agent card is stored yet ("No
// stored card yet"); the card itself is covered by AgentPerformanceCard.test.tsx.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPerformanceProjection } from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockApi = vi.hoisted(() => ({ profile: vi.fn(), access: vi.fn(), projection: vi.fn(), card: vi.fn(), compute: vi.fn() }));

vi.mock("../../api/agent-performance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-performance")>();
  return { ...actual, agentPerformanceApi: mockApi };
});
vi.mock("../../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" }, session: { userId: "user-1" } }) } }));
// AgentDash (APM gate 4): the tab also reads the performance manager, its recommendations and the revision history.
vi.mock("../../api/performance-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/performance-manager")>();
  return {
    ...actual,
    performanceManagerApi: {
      get: async () => ({ kind: "performance_manager", companyId: "company-1", designatedAgentId: null, designated: null, effective: null, source: "none", viewer: { canChange: false } }),
      recommendations: async () => ({ agentId: "agent-1", recommendations: [], restricted: false }),
    },
  };
});
vi.mock("../../api/agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-profiles")>();
  return { ...actual, agentProfilesApi: { ...actual.agentProfilesApi, revisions: async () => [] } };
});
vi.mock("../../api/access", () => ({
  accessApi: { listMembers: async () => ({ members: [], access: { currentUserRole: "member", canManageMembers: false, canInviteUsers: false, canApproveJoinRequests: false } }) },
}));

const {
  AgentPerformanceTab,
  PERFORMANCE_QUESTIONS,
  NO_OBSERVED_CASES_TEXT,
  CURRENT_DEFINITIONS_LABEL,
  SPEND_NOT_VISIBLE_TEXT,
} = await import("./AgentPerformanceTab");
const { RESTRICTED_VIEW_TEXT } = await import("./shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WITHHELD = { section: "paired-harness assessments", reason: "Shown once evidence access rules ship (gate 3)" };
const SPEND_WITHHELD = { section: "agent spend", reason: "Spend is shown to company admins and members who can manage agents" };
const PROJECTS_WITHHELD = {
  section: "work in projects you can't see",
  reason: "Issues, verdicts, runs, spend and questions in restricted projects you can't read are left out of every count",
};

function emptyProjection(): AgentPerformanceProjection {
  return {
    kind: "agent_performance_projection",
    version: "agent-projection/0",
    companyId: "company-1",
    agentId: "agent-1",
    generatedAt: "2026-10-29T12:00:00.000Z",
    asOf: "2026-10-29T12:00:00.000Z",
    window: { from: "2026-09-29T12:00:00.000Z", to: "2026-10-29T12:00:00.000Z" },
    throughSeq: null,
    sideEffectFree: true,
    owed: {
      source: "current_definitions",
      historyKnown: false,
      routines: [],
      assigned: { open: 0, inProgress: 0, inReview: 0, blocked: 0, done: 0, cancelled: 0 },
    },
    quality: {
      verdicts: { passed: 0, failed: 0, changesRequested: 0, escalated: 0, other: 0 },
      byJudge: { person: 0, independentAgent: 0, nonIndependent: 0 },
    },
    acceptance: {
      automated: { value: 0, of: 0 },
      human: { value: 0, of: 0 },
      use: { value: null, note: "No use records yet" },
      outcome: { value: null, note: "Goal metric history arrives in gate 3" },
      accountable: [],
    },
    cost: {
      spendCents: 0,
      runs: { total: 0, succeeded: 0, failed: 0, withoutIssue: 0 },
      peopleProxies: {
        questionsAsked: 0,
        questionsAnswered: 0,
        medianAnswerWaitMinutes: null,
        humanCorrections: { value: 0 },
      },
    },
    bounds: { refusedAttempts: 0, byCode: {} },
    decisions: { pendingApprovals: 0, openQuestionsToPeople: 0 },
    gaps: [{ code: "ATTRIBUTION_CURRENT_ASSIGNEE", message: "Verdicts are counted for the agent assigned now." }],
    withheld: [WITHHELD],
  };
}

function busyProjection(): AgentPerformanceProjection {
  const base = emptyProjection();
  return {
    ...base,
    throughSeq: 4821,
    owed: {
      ...base.owed,
      routines: [
        {
          routineId: "routine-1",
          title: "Monday pipeline report",
          triggerId: "trigger-1",
          triggerKind: "schedule",
          cronExpression: "0 9 * * 1",
          timezone: "America/Los_Angeles",
          enabled: true,
          owedInWindow: 5,
          note: "Trigger created inside the window",
          runs: { total: 5, issueCreated: 4, completed: 2, failed: 1, skipped: 1, coalesced: 1 },
          linkedIssues: { done: 3, open: 1, cancelled: 0 },
        },
        {
          routineId: "routine-2",
          title: "Inbound lead webhook",
          triggerId: "trigger-2",
          triggerKind: "webhook",
          cronExpression: null,
          timezone: null,
          enabled: true,
          owedInWindow: null,
          note: "Webhook triggers fire on request; nothing is owed on a schedule",
          runs: { total: 9, issueCreated: 9, completed: 9, failed: 0, skipped: 0, coalesced: 0 },
          linkedIssues: { done: 8, open: 1, cancelled: 0 },
        },
        {
          routineId: "routine-3",
          title: "Paused digest",
          triggerId: "trigger-3",
          triggerKind: "schedule",
          cronExpression: "0 8 * * *",
          timezone: "UTC",
          enabled: false,
          owedInWindow: null,
          runs: { total: 0, issueCreated: 0, completed: 0, failed: 0, skipped: 0, coalesced: 0 },
          linkedIssues: { done: 0, open: 0, cancelled: 0 },
        },
      ],
      assigned: { open: 2, inProgress: 1, inReview: 1, blocked: 1, done: 4, cancelled: 1 },
    },
    quality: {
      verdicts: { passed: 6, failed: 1, changesRequested: 2, escalated: 1, other: 0 },
      byJudge: { person: 3, independentAgent: 5, nonIndependent: 2 },
    },
    acceptance: {
      ...base.acceptance,
      automated: { value: 5, of: 10 },
      human: { value: 3, of: 10 },
      accountable: [
        {
          kind: "project",
          id: "project-1",
          title: "Q4 pipeline",
          status: "in_progress",
          outcome: null,
          note: "No evaluator card",
        },
      ],
    },
    cost: {
      spendCents: 12345,
      runs: { total: 40, succeeded: 35, failed: 5, withoutIssue: 7 },
      peopleProxies: {
        questionsAsked: 4,
        questionsAnswered: 3,
        medianAnswerWaitMinutes: 42,
        humanCorrections: { value: null, note: "Corrections are not recorded for this agent" },
      },
    },
    bounds: { refusedAttempts: 3, byCode: { AGENT_CROSS_COMPANY: 2, SOME_FUTURE_CODE: 1 } },
    decisions: { pendingApprovals: 1, openQuestionsToPeople: 2 },
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AgentPerformanceTab companyId="company-1" agentId="agent-1" />
      </QueryClientProvider>,
    );
  });
  // The card read resolves first; the fallback projection is read after it.
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

function block(node: HTMLElement, id: string): string {
  return node.querySelector(`[data-testid='${id}']`)?.textContent ?? "";
}

function factRow(node: HTMLElement, blockId: string, label: string): string {
  const rows = Array.from(node.querySelectorAll(`[data-testid='${blockId}'] dl > div`));
  const row = rows.find((el) => el.querySelector("dt")?.textContent === label);
  return row?.querySelector("dd")?.textContent ?? "";
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  mockApi.projection.mockReset();
  mockApi.card.mockReset();
});

describe("AgentPerformanceTab", () => {
  beforeEach(() => {
    // No agent card stored yet: the gate 1 projection is the fallback.
    mockApi.card.mockResolvedValue({ card: null, viewer: { canSnapshot: false, canNoteDisagreement: false, canConfirmUse: true, attestableCriteria: [] } });
  });

  it("shows a loading state while the projection is read", async () => {
    mockApi.projection.mockReturnValue(new Promise(() => {}));
    const node = await render();
    expect(node.querySelector("[data-testid='agent-pm-loading']")?.textContent).toContain("Loading performance");
  });

  it("says no stored card yet above the gate 1 view", async () => {
    mockApi.projection.mockResolvedValue(busyProjection());
    const node = await render();
    expect(mockApi.card).toHaveBeenCalledWith("company-1", "agent-1", null);
    expect(block(node, "agent-card-status")).toBe("No stored card yet");
    expect(block(node, "agent-card-none")).toContain("No stored card yet.");
    expect(block(node, "agent-card-none")).toContain("Compute now shows the card for the records as they are now without saving it.");
    // A member who doesn't answer for the agent is told who can store one, and gets no snapshot button.
    expect(block(node, "agent-card-none")).toContain("The agent's accountable person or a company admin can store one.");
    expect(Array.from(node.querySelectorAll("button")).map((b) => b.textContent)).not.toContain("Take snapshot");
    expect(node.querySelector("[data-testid='agent-performance-tab']")).not.toBeNull();
  });

  it("titles six blocks with the six questions, in order, for a 30-day window", async () => {
    mockApi.projection.mockResolvedValue(busyProjection());
    const node = await render();

    expect(mockApi.projection).toHaveBeenCalledWith("company-1", "agent-1", 30);
    const headings = Array.from(node.querySelectorAll("h3")).map((h) => h.textContent?.trim());
    expect(headings.slice(0, 6)).toEqual([
      PERFORMANCE_QUESTIONS.owed,
      PERFORMANCE_QUESTIONS.quality,
      PERFORMANCE_QUESTIONS.acceptance,
      PERFORMANCE_QUESTIONS.cost,
      PERFORMANCE_QUESTIONS.bounds,
      PERFORMANCE_QUESTIONS.decisions,
    ]);
    expect(headings.slice(0, 6)).toEqual([
      "Is the work it owes getting done?",
      "Is the work good?",
      "Is it accepted, used, and moving the result?",
      "What does it cost?",
      "Is it staying inside its boundaries?",
      "What needs my decision?",
    ]);
  });

  it("shows the window, as-of time, the current-definitions label and the withheld sections", async () => {
    mockApi.projection.mockResolvedValue(busyProjection());
    const node = await render();
    const header = block(node, "agent-performance-window");
    expect(header).toContain("Window:");
    expect(header).toContain("Sep 29, 2026");
    expect(header).toContain("As of:");
    expect(header).toContain("Evaluator ledger read through event 4821.");
    expect(header).toContain(CURRENT_DEFINITIONS_LABEL);
    expect(CURRENT_DEFINITIONS_LABEL).toBe("Current definitions; history unknown");
    expect(block(node, "agent-performance-withheld")).toContain(
      "paired-harness assessments — Shown once evidence access rules ship (gate 3)",
    );
    expect(node.textContent).toContain("ATTRIBUTION_CURRENT_ASSIGNEE");
  });

  it("shows counts with their denominators", async () => {
    mockApi.projection.mockResolvedValue(busyProjection());
    const node = await render();
    const routines = Array.from(node.querySelectorAll("[data-testid='agent-performance-routine']")).map(
      (el) => el.textContent ?? "",
    );
    expect(routines[0]).toContain("Owed in window5 runs — Trigger created inside the window");
    expect(routines[0]).toContain("Completed2 of 5");
    expect(routines[0]).toContain("Linked issues done3 of 4");
    expect(factRow(node, "agent-performance-owed", "Blocked")).toBe("1 of 10");
    expect(factRow(node, "agent-performance-quality", "Passed")).toBe("6 of 10");
    expect(factRow(node, "agent-performance-quality", "An independent agent")).toBe("5 of 10");
    expect(factRow(node, "agent-performance-acceptance", "Passed by an independent agent")).toBe("5 of 10");
    expect(factRow(node, "agent-performance-acceptance", "Accepted by a person")).toBe("3 of 10");
    expect(factRow(node, "agent-performance-cost", "Spend")).toBe("$123.45");
    expect(factRow(node, "agent-performance-cost", "Runs with no issue")).toBe("7 of 40");
    expect(factRow(node, "agent-performance-cost", "Questions answered")).toBe("3 of 4");
    expect(factRow(node, "agent-performance-cost", "Median wait for an answer")).toBe("42 minutes");
    expect(factRow(node, "agent-performance-bounds", "Tried to reach another company (AGENT_CROSS_COMPANY)")).toBe("2 of 3");
    expect(factRow(node, "agent-performance-bounds", "SOME_FUTURE_CODE")).toBe("1 of 3");
    expect(factRow(node, "agent-performance-decisions", "Approvals it requested, pending")).toBe("1");
  });

  it("renders null counts as Unknown with their note, never 0", async () => {
    mockApi.projection.mockResolvedValue(busyProjection());
    const node = await render();
    const use = factRow(node, "agent-performance-acceptance", "Used");
    expect(use).toBe("Unknown — No use records yet");
    expect(use).not.toMatch(/\b0\b/);
    expect(factRow(node, "agent-performance-acceptance", "Moved the result")).toBe(
      "Unknown — Goal metric history arrives in gate 3",
    );
    expect(factRow(node, "agent-performance-cost", "Corrections by people")).toBe(
      "Unknown — Corrections are not recorded for this agent",
    );
    const routines = Array.from(node.querySelectorAll("[data-testid='agent-performance-routine']")).map(
      (el) => el.textContent ?? "",
    );
    // The server's note wins; the client wording is only a fallback when the server sends none.
    expect(routines[1]).toContain(
      "Owed in windowUnknown — Webhook triggers fire on request; nothing is owed on a schedule",
    );
    expect(routines[2]).toContain("Owed in windowUnknown — The trigger is disabled");
    expect(block(node, "agent-performance-acceptance")).toContain("Outcome: Unknown — No evaluator card");
  });

  it("says spend is not visible, never $0, when the server withholds it", async () => {
    const projection = busyProjection();
    projection.cost.spendCents = null;
    projection.withheld = [WITHHELD, SPEND_WITHHELD, PROJECTS_WITHHELD];
    mockApi.projection.mockResolvedValue(projection);
    const node = await render();
    expect(factRow(node, "agent-performance-cost", "Spend")).toBe(SPEND_NOT_VISIBLE_TEXT);
    expect(SPEND_NOT_VISIBLE_TEXT).toBe("Not visible to you");
    expect(block(node, "agent-performance-cost")).not.toContain("$");
    const withheld = block(node, "agent-performance-withheld");
    expect(withheld).toContain("agent spend — Spend is shown to company admins and members who can manage agents");
    expect(withheld).toContain(`work in projects you can't see — ${PROJECTS_WITHHELD.reason}`);
  });

  it("keeps hidden spend visible as hidden in an otherwise empty window", async () => {
    const projection = emptyProjection();
    projection.cost.spendCents = null;
    projection.withheld = [WITHHELD, SPEND_WITHHELD];
    mockApi.projection.mockResolvedValue(projection);
    const node = await render();
    expect(block(node, "agent-performance-cost")).toContain(NO_OBSERVED_CASES_TEXT);
    expect(factRow(node, "agent-performance-cost", "Spend")).toBe("Not visible to you");
  });

  it("has no gauge, score or ranking", async () => {
    mockApi.projection.mockResolvedValue(busyProjection());
    const node = await render();
    expect(node.querySelector("[role='meter'], [role='progressbar'], meter, progress")).toBeNull();
    expect(node.textContent?.toLowerCase()).not.toMatch(/\bscore\b|\brank(ing)?\b|\bgauge\b/);
  });

  it("says no observed cases yet when the window has nothing, keeping unknowns unknown", async () => {
    mockApi.projection.mockResolvedValue(emptyProjection());
    const node = await render();
    for (const id of ["agent-performance-owed", "agent-performance-quality", "agent-performance-cost", "agent-performance-bounds"]) {
      expect(block(node, id)).toContain(NO_OBSERVED_CASES_TEXT);
    }
    expect(NO_OBSERVED_CASES_TEXT).toBe("No observed cases yet");
    expect(factRow(node, "agent-performance-acceptance", "Used")).toBe("Unknown — No use records yet");
    expect(block(node, "agent-performance-acceptance")).toContain("It leads no projects and owns no goals.");
    expect(block(node, "agent-performance-decisions")).toContain("Nothing from this agent is waiting for a decision.");
    expect(block(node, "agent-performance-window")).toContain("The evaluator ledger has no events for this company.");
    expect(block(node, "agent-performance-cost")).not.toContain("$0.00");
  });

  it("explains who can see it when the server refuses (403)", async () => {
    mockApi.projection.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));
    const node = await render();
    expect(block(node, "agent-pm-restricted")).toBe(RESTRICTED_VIEW_TEXT);
    expect(node.querySelector("[data-testid='agent-pm-error']")).toBeNull();
  });

  it("shows the server's message for any other failure", async () => {
    mockApi.projection.mockRejectedValue(new ApiError("windowDays must be 1-365", 400, { error: "windowDays must be 1-365" }));
    const node = await render();
    const alert = node.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("Couldn't load this agent's performance.");
    expect(alert?.textContent).toContain("windowDays must be 1-365");
  });
});
