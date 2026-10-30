// @vitest-environment jsdom
//
// Agent Performance Management gate 4 (P4.2): on the Performance tab, the
// performance manager's recommendations about an agent — kind, reason, cited
// evidence (each one opens), and decision state as text — with a decision
// action (accept or decline, with a note) offered only when the list's
// `viewer.canDecide` (the decision route's guard) is true; a refusal the
// server still returns is shown as written. "Pause" reads "Recommends
// pausing — the agent keeps running until you pause it", and an accepted
// pause pauses nothing. The profile changes the manager proposed are listed
// and marked from each revision's `proposedByCapacity` (no approval is
// fetched); the manager's own page links its record.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRecommendationDto, PerformanceManagerView } from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockManagerApi = vi.hoisted(() => ({ recommendations: vi.fn(), decide: vi.fn() }));
const mockProfilesApi = vi.hoisted(() => ({ revisions: vi.fn() }));
const mockApprovalsApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../api/performance-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/performance-manager")>();
  return { ...actual, performanceManagerApi: mockManagerApi };
});
vi.mock("../../api/agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-profiles")>();
  return { ...actual, agentProfilesApi: mockProfilesApi };
});
vi.mock("../../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
// The ledger event drawer is the evaluation surface's own; here it only has to open on the right event.
vi.mock("@/pages/evaluation/shared", () => ({
  EventDrawer: ({ eventId }: { eventId: string | null }) =>
    eventId ? <div data-testid="event-drawer">{eventId}</div> : null,
}));

const {
  AgentRecommendationsSection,
  ManagerProposalsSection,
  ManagerRoleBanner,
  RECOMMENDATIONS_EMPTY_TEXT,
  DECIDER_HINT_TEXT,
  NOT_DECIDER_TEXT,
  PAUSE_NOT_APPLIED_TEXT,
  MANAGER_PROPOSALS_EMPTY_TEXT,
} = await import("./AgentRecommendations");
const { PERFORMANCE_MANAGER_ADVISORY_TEXT } = await import("./manager-shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EVENT = "44444444-4444-4444-8444-444444444441";
const CASE_EVENT = "44444444-4444-4444-8444-444444444442";

/** The list's `viewer` for the accountable person or an admin. */
const DECIDER = { canDecide: true };

const MANAGER_VIEW: PerformanceManagerView = {
  kind: "performance_manager",
  companyId: "company-1",
  designatedAgentId: null,
  designated: null,
  effective: { agentId: "agent-cos", name: "Clara", role: "chief_of_staff", status: "active" },
  source: "chief_of_staff",
  viewer: { canChange: false },
};

function rec(overrides: Partial<AgentRecommendationDto> = {}): AgentRecommendationDto {
  return {
    id: "rec-1",
    companyId: "company-1",
    agentId: "agent-1",
    kind: "repair",
    reason: "Two Monday reports were late.",
    evidence: [
      { kind: "card", ref: "3" },
      { kind: "event", ref: EVENT },
      { kind: "case", ref: `obligations:${CASE_EVENT}` },
      { kind: "case", ref: "occurrence-77" },
    ],
    proposalApprovalId: "approval-7",
    recommendedByAgentId: "agent-cos",
    recommendedAt: "2026-10-29T09:00:00.000Z",
    eventId: "55555555-5555-4555-8555-555555555555",
    advisory: true,
    decision: null,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
const onShowCardVersion = vi.fn();

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  });
  await flush();
  return container;
}

function renderSection() {
  return render(
    <AgentRecommendationsSection
      companyId="company-1"
      agentId="agent-1"
      managerView={MANAGER_VIEW}
      personName={(id) => (id === "user-acc" ? "Ana Accountable" : `Person ${id}`)}
      onShowCardVersion={onShowCardVersion}
    />,
  );
}

function byTestId<T extends HTMLElement = HTMLElement>(node: ParentNode, id: string): T | null {
  return node.querySelector<T>(`[data-testid='${id}']`);
}

function button(node: ParentNode, label: string): HTMLButtonElement {
  const found = Array.from(node.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`No button ${label}`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await flush();
}

async function typeNote(node: ParentNode, value: string) {
  const textarea = node.querySelector<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  mockManagerApi.recommendations.mockResolvedValue({ agentId: "agent-1", recommendations: [rec()], restricted: false, viewer: DECIDER });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("Recommendations — the list", () => {
  it("shows kind, who filed it, reason, cited evidence, the proposal it goes with, and the decision state as text", async () => {
    const node = await renderSection();
    expect(mockManagerApi.recommendations).toHaveBeenCalledWith("company-1", "agent-1");
    const item = byTestId(node, "agent-recommendation")!;
    expect(byTestId(item, "agent-recommendation-kind")?.textContent).toBe("Recommends a repair");
    expect(item.textContent).toContain("From Clara, the performance manager");
    expect(byTestId(item, "agent-recommendation-reason")?.textContent).toBe("Reason: Two Monday reports were late.");
    const evidence = Array.from(byTestId(item, "agent-recommendation-evidence")!.querySelectorAll("li")).map((li) => li.textContent);
    expect(evidence[0]).toBe("Card version 3");
    expect(evidence[1]).toContain("Evaluator record");
    expect(evidence[2]).toContain("Case");
    expect(evidence[3]).toBe("Case occurrence-77 — listed under the card's numbers");
    expect(item.querySelector("a[href='/approvals/approval-7']")?.textContent).toBe("Open the profile change it goes with");
    expect(byTestId(item, "agent-recommendation-decision")?.textContent).toContain("Decision: None recorded yet");
  });

  it("opens each cited piece of evidence: the card version here, the event and the case's event in the drawer", async () => {
    const node = await renderSection();
    await click(button(node, "Card version 3"));
    expect(onShowCardVersion).toHaveBeenCalledWith(3);
    const [eventButton, caseButton] = Array.from(byTestId(node, "agent-recommendation-evidence")!.querySelectorAll("button")).slice(1);
    await click(eventButton!);
    expect(byTestId(node, "event-drawer")?.textContent).toBe(EVENT);
    await click(caseButton!);
    expect(byTestId(node, "event-drawer")?.textContent).toBe(CASE_EVENT);
  });

  it("words pause as advisory: the agent keeps running until a person pauses it", async () => {
    mockManagerApi.recommendations.mockResolvedValue({ agentId: "agent-1", recommendations: [rec({ kind: "pause" })], restricted: false, viewer: DECIDER });
    const node = await renderSection();
    expect(byTestId(node, "agent-recommendation-kind")?.textContent).toBe(
      "Recommends pausing — the agent keeps running until you pause it",
    );
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-decide")!);
    expect(byTestId(node, "agent-recommendation-decision-form")?.textContent).toContain(PAUSE_NOT_APPLIED_TEXT);
  });

  it("shows a recorded decision with who and when, its note, and no decision action", async () => {
    mockManagerApi.recommendations.mockResolvedValue({
      agentId: "agent-1",
      restricted: false,
      viewer: DECIDER,
      recommendations: [
        rec({
          kind: "pause",
          decision: { decision: "accepted", note: "Agreed; I'll pause it after Friday.", decidedByUserId: "user-acc", decidedAt: "2026-10-29T11:00:00.000Z", eventId: "e" },
        }),
      ],
    });
    const node = await renderSection();
    const item = byTestId(node, "agent-recommendation")!;
    expect(byTestId(item, "agent-recommendation-decision")?.textContent).toContain("Decision: Accepted");
    expect(byTestId(item, "agent-recommendation-decision")?.textContent).toContain("by Ana Accountable");
    expect(item.textContent).toContain("Note: Agreed; I'll pause it after Friday.");
    expect(byTestId(item, "agent-recommendation-pause-note")?.textContent).toBe(
      "Nothing was paused by accepting it. To pause the agent, use the agent's pause action.",
    );
    expect(byTestId(item, "agent-recommendation-decide")).toBeNull();
  });

  it("names a recommender who is not the performance manager now as such", async () => {
    mockManagerApi.recommendations.mockResolvedValue({
      agentId: "agent-1",
      restricted: false,
      viewer: DECIDER,
      recommendations: [rec({ recommendedByAgentId: "99999999-0000-4000-8000-000000000000" })],
    });
    const node = await renderSection();
    expect(byTestId(node, "agent-recommendation")?.textContent).toContain("From Agent 99999999, not the performance manager now");
  });

  it("says so when there are none, and when some may be hidden", async () => {
    mockManagerApi.recommendations.mockResolvedValue({ agentId: "agent-1", recommendations: [], restricted: true, viewer: DECIDER });
    const node = await renderSection();
    expect(byTestId(node, "agent-performance-recommendations")?.textContent).toContain(RECOMMENDATIONS_EMPTY_TEXT);
    expect(byTestId(node, "agent-recommendations-restricted")?.textContent).toContain("Some recommendations may be hidden from you");
  });

  it("explains a failed read", async () => {
    mockManagerApi.recommendations.mockRejectedValue(new ApiError("Agent not found", 404, { error: "Agent not found" }));
    const node = await renderSection();
    expect(byTestId(node, "agent-pm-error")?.textContent).toContain("Couldn't load this agent's recommendations.");
    expect(byTestId(node, "agent-pm-error")?.textContent).toContain("Agent not found");
  });

  it("has no gauge, score or ranking", async () => {
    const node = await renderSection();
    expect(node.querySelector("[role='meter'], [role='progressbar'], meter, progress")).toBeNull();
    expect(node.textContent?.toLowerCase()).not.toMatch(/\bscore\b|\brank(ing)?\b|\bgauge\b/);
  });
});

describe("Recommendations — recording a decision", () => {
  it("is keyboard-operable: a disclosure button, a labelled choice and a labelled note", async () => {
    const node = await renderSection();
    const toggle = byTestId<HTMLButtonElement>(node, "agent-recommendation-decide")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(node.textContent).toContain(DECIDER_HINT_TEXT);
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const form = byTestId(node, "agent-recommendation-decision-form")!;
    expect(form.id).toBe(toggle.getAttribute("aria-controls"));
    expect(form.querySelector("legend")?.textContent).toBe("Your decision on this recommendation");
    expect(form.querySelectorAll("input[type='radio']")).toHaveLength(2);
    const textarea = form.querySelector("textarea")!;
    expect(form.querySelector(`label[for='${textarea.id}']`)?.textContent).toBe("Note (optional)");
  });

  it("the accountable person or an admin: accepts with a note, hears the server's next step, and the list is re-read", async () => {
    mockManagerApi.decide.mockResolvedValue({
      recommendation: rec(),
      effect: "none",
      next: "Recorded. A recommendation changes nothing by itself.",
    });
    const node = await renderSection();
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-decide")!);
    await typeNote(node, "Fair — fix the Monday trigger.");
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-submit")!);
    expect(mockManagerApi.decide).toHaveBeenCalledWith("company-1", "agent-1", "rec-1", {
      decision: "accepted",
      note: "Fair — fix the Monday trigger.",
    });
    const status = byTestId(node, "agent-recommendations-status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Recorded. A recommendation changes nothing by itself.");
    expect(mockManagerApi.recommendations).toHaveBeenCalledTimes(2);
  });

  it("declines without a note by sending no note", async () => {
    mockManagerApi.decide.mockResolvedValue({ recommendation: rec(), effect: "none", next: "Recorded. A recommendation changes nothing by itself." });
    const node = await renderSection();
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-decide")!);
    await click(byTestId<HTMLInputElement>(node, "agent-recommendation-declined")!);
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-submit")!);
    expect(mockManagerApi.decide).toHaveBeenCalledWith("company-1", "agent-1", "rec-1", { decision: "declined" });
  });

  it("an accepted pause is announced as pausing nothing", async () => {
    mockManagerApi.recommendations.mockResolvedValue({ agentId: "agent-1", recommendations: [rec({ kind: "pause" })], restricted: false, viewer: DECIDER });
    mockManagerApi.decide.mockResolvedValue({
      recommendation: rec({ kind: "pause" }),
      effect: "none",
      next: "Recorded. Nothing was paused: to pause the agent, use the agent's pause action.",
    });
    const node = await renderSection();
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-decide")!);
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-submit")!);
    expect(byTestId(node, "agent-recommendations-status")?.textContent).toBe(
      "Recorded. Nothing was paused: to pause the agent, use the agent's pause action.",
    );
  });

  it("a reader the decision guard refuses (viewer.canDecide false) is offered no decision form, only who can decide", async () => {
    mockManagerApi.recommendations.mockResolvedValue({
      agentId: "agent-1",
      restricted: false,
      viewer: { canDecide: false },
      recommendations: [
        rec(),
        rec({
          id: "rec-2",
          decision: { decision: "declined", note: null, decidedByUserId: "user-acc", decidedAt: "2026-10-29T11:00:00.000Z", eventId: "e2" },
        }),
      ],
    });
    const node = await renderSection();
    const [open, decided] = Array.from(node.querySelectorAll<HTMLElement>("[data-testid='agent-recommendation']"));
    expect(byTestId(node, "agent-recommendation-decide")).toBeNull();
    expect(byTestId(node, "agent-recommendation-decision-form")).toBeNull();
    expect(node.textContent).not.toContain(DECIDER_HINT_TEXT);
    expect(byTestId(open!, "agent-recommendation-not-decider")?.textContent).toBe(NOT_DECIDER_TEXT);
    expect(byTestId(open!, "agent-recommendation-decision")?.textContent).toContain("None recorded yet");
    // A decided one just shows its decision.
    expect(byTestId(decided!, "agent-recommendation-not-decider")).toBeNull();
    expect(byTestId(decided!, "agent-recommendation-decision")?.textContent).toContain("Decision: Declined");
    expect(mockManagerApi.decide).not.toHaveBeenCalled();
  });

  it("no viewer flag (an older server): fails closed, offering no decision form", async () => {
    mockManagerApi.recommendations.mockResolvedValue({ agentId: "agent-1", recommendations: [rec()], restricted: false });
    const node = await renderSection();
    expect(byTestId(node, "agent-recommendation-decide")).toBeNull();
    expect(byTestId(node, "agent-recommendation-not-decider")?.textContent).toBe(NOT_DECIDER_TEXT);
  });

  it("another member the server still refuses: its reason is shown in an alert; nothing is recorded", async () => {
    mockManagerApi.decide.mockRejectedValue(
      new ApiError(
        "Only the agent's accountable person or a company admin can record a decision on a recommendation.",
        403,
        { error: "Only the agent's accountable person or a company admin can record a decision on a recommendation." },
      ),
    );
    const node = await renderSection();
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-decide")!);
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-submit")!);
    const alert = byTestId(node, "agent-recommendation-problem")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(
      "The server refused to record the decision: Only the agent's accountable person or a company admin can record a decision on a recommendation.",
    );
    expect(byTestId(node, "agent-recommendations-status")?.textContent).toBe("");
    expect(byTestId(node, "agent-recommendation-decision")?.textContent).toContain("None recorded yet");
    // The form stays open with the person's choice, so nothing they typed is lost.
    expect(byTestId(node, "agent-recommendation-decision-form")).not.toBeNull();
  });

  it("someone else decided first: says so and re-reads the list", async () => {
    mockManagerApi.decide.mockRejectedValue(
      new ApiError("This recommendation already has a decision", 409, {
        error: "This recommendation already has a decision",
        details: { code: "AGENT_RECOMMENDATION_ALREADY_DECIDED" },
      }),
    );
    const node = await renderSection();
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-decide")!);
    await click(byTestId<HTMLButtonElement>(node, "agent-recommendation-submit")!);
    expect(byTestId(node, "agent-recommendation-problem")?.textContent).toBe(
      "Couldn't record the decision: This recommendation already has a decision",
    );
    expect(mockManagerApi.recommendations).toHaveBeenCalledTimes(2);
  });
});

describe("Profile changes the performance manager proposed", () => {
  function summary(id: string, revisionNumber: number, state: string, approvalId: string | null, byManager = false) {
    return {
      id,
      companyId: "company-1",
      profileId: "profile-1",
      agentId: "agent-1",
      revisionNumber,
      basedOnRevisionId: null,
      state,
      bodyHash: "h",
      bases: null,
      createdByAgentId: "agent-cos",
      createdByUserId: null,
      createdByRunId: null,
      approvalId,
      proposedByCapacity: byManager ? ("performance_manager" as const) : null,
      createdAt: "2026-10-20T09:00:00.000Z",
      updatedAt: "2026-10-21T09:00:00.000Z",
    };
  }

  it("lists only the manager's proposals (from proposedByCapacity), newest first, each marked and linked, fetching no approval", async () => {
    mockProfilesApi.revisions.mockResolvedValue([
      summary("rev-1", 1, "applied", "approval-user"),
      summary("rev-2", 2, "rejected", "approval-pm-old", true),
      summary("rev-3", 3, "proposed", "approval-pm-new", true),
      summary("rev-4", 4, "draft", null),
    ]);
    const node = await render(<ManagerProposalsSection companyId="company-1" agentId="agent-1" />);
    await flush();
    expect(mockApprovalsApi.get).not.toHaveBeenCalled();
    const rows = Array.from(node.querySelectorAll<HTMLElement>("[data-testid='agent-manager-proposal']"));
    expect(rows.map((row) => row.textContent?.match(/Revision \d+/)?.[0])).toEqual(["Revision 3", "Revision 2"]);
    expect(rows[0]!.textContent).toContain("Waiting for a decision");
    expect(rows[0]!.textContent).toContain("Drafted");
    expect(rows[1]!.textContent).toContain("Rejected");
    for (const row of rows) {
      expect(byTestId(row, "agent-pm-manager-filed")?.textContent).toBe("Proposed by the performance manager");
    }
    expect(rows[0]!.querySelector("a[href='/approvals/approval-pm-new']")).not.toBeNull();
    expect(rows[0]!.querySelector("a[href='/agents/agent-1/profile']")).not.toBeNull();
  });

  it("says so when the manager proposed nothing", async () => {
    mockProfilesApi.revisions.mockResolvedValue([summary("rev-1", 1, "applied", "approval-user")]);
    const node = await render(<ManagerProposalsSection companyId="company-1" agentId="agent-1" />);
    await flush();
    expect(byTestId(node, "agent-performance-manager-proposals")?.textContent).toContain(MANAGER_PROPOSALS_EMPTY_TEXT);
  });
});

describe("The manager's own Performance tab", () => {
  it("says what the role is and links its record, only on the manager's page", async () => {
    const node = await render(<ManagerRoleBanner agentId="agent-cos" managerView={MANAGER_VIEW} />);
    expect(byTestId(node, "agent-performance-manager-banner")?.textContent).toContain(PERFORMANCE_MANAGER_ADVISORY_TEXT);
    expect(byTestId(node, "agent-performance-manager-record-link")?.getAttribute("href")).toBe("/agents/agent-cos/manager-record");
    act(() => root!.unmount());
    container!.remove();
    const other = await render(<ManagerRoleBanner agentId="agent-1" managerView={MANAGER_VIEW} />);
    expect(byTestId(other, "agent-performance-manager-banner")).toBeNull();
  });
});
