// @vitest-environment jsdom
//
// Agent Performance Management gate 3 (P3.5): the Performance tab shows the
// latest stored agent card (a version picker when several exist), a "Compute
// now" projection labelled not saved, and falls back to the gate 1 view when
// no card is stored. Potentially fatal flags come first, then the six
// questions in the overview LLD §1 order, then its reviews of others' work
// (separate), then gaps. A section the viewer can't read says "Not visible to
// you" with no counts. On a stored card every number with cases behind it
// opens them (state filter, links, unbound judgments shown as such). Actions
// follow the viewer: "Confirm use" for any person, "Attest criterion" for the
// named attester only, "Note disagreement" and "Take snapshot" for the
// accountable person or an admin.
//
// P3.7: what the viewer may do comes from the card's `viewer` flags (never
// inferred from roles), the version picker lists the server's stored
// versions, every drill-down filter is sent to the server (fact, criterion,
// judge, "no responsibility", "no criterion") and the list is not narrowed
// here, and an attestation cites the quality case's own records.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_CASE_FILTER_NONE,
  AGENT_OBLIGATION_END_STATES,
  evaluationCriterionRefKey,
  type AgentCardView,
  type AgentCardViewerPermissions,
  type AgentCaseList,
  type AgentCaseRow,
  type AgentObligationEndState,
  type AgentPerformanceProjection,
} from "@paperclipai/shared";

const mockApi = vi.hoisted(() => ({
  profile: vi.fn(),
  access: vi.fn(),
  projection: vi.fn(),
  card: vi.fn(),
  compute: vi.fn(),
  cases: vi.fn(),
  versions: vi.fn(),
  snapshot: vi.fn(),
  recordDisposition: vi.fn(),
  cards: vi.fn(),
}));
const session = vi.hoisted(() => ({ userId: "user-member" as string, role: "member" as "admin" | "member" }));
/** The server's `viewer` flags for the person looking (a plain member by default). */
const perms = vi.hoisted(() => ({
  value: { canSnapshot: false, canNoteDisagreement: false, canConfirmUse: true, attestableCriteria: [] as string[] },
}));

vi.mock("../../api/agent-performance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-performance")>();
  return { ...actual, agentPerformanceApi: mockApi };
});
vi.mock("../../api/auth", () => ({
  authApi: { getSession: async () => ({ user: { id: session.userId }, session: { userId: session.userId } }) },
}));
vi.mock("../../api/access", () => ({
  accessApi: {
    listMembers: async () => ({
      members: [
        { principalId: "user-acc", principalType: "user", user: { id: "user-acc", name: "Ana Accountable", email: null, image: null } },
      ],
      access: { currentUserRole: session.role, canManageMembers: false, canInviteUsers: false, canApproveJoinRequests: false },
    }),
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" } }),
}));
// AgentDash (APM gate 4): the tab also reads the performance manager, its recommendations and the revision history.
const mockManager = vi.hoisted(() => ({ recommendations: vi.fn(), get: vi.fn() }));
vi.mock("../../api/performance-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/performance-manager")>();
  return { ...actual, performanceManagerApi: mockManager };
});
vi.mock("../../api/agent-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/agent-profiles")>();
  return { ...actual, agentProfilesApi: { ...actual.agentProfilesApi, revisions: async () => [] } };
});

const { AgentPerformanceTab } = await import("./AgentPerformanceTab");
const { CARD_QUESTIONS, FATAL_TITLE, REVIEWER_TITLE } = await import("./AgentCardDisplay");
const { COMPUTED_NOT_SAVED_TEXT, NO_STORED_CARD_TEXT, NOT_VISIBLE_TEXT } = await import("./card-shared");
const { UNBOUND_TEXT } = await import("./AgentCaseDrilldown");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT = "11111111-1111-4111-8111-111111111111";
const CONTRACT_EVENT = "22222222-2222-4222-8222-222222222222";
const ISSUE_1 = "33333333-3333-4333-8333-333333333331";
const ISSUE_2 = "33333333-3333-4333-8333-333333333332";
const EV = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;
const CRIT_ATTEST = { contractEventId: CONTRACT_EVENT, responsibilityKey: "weekly-report", criterionId: "cites-sources", checkHash: "0123456789abcdef" };
const CRIT_RECORD = { contractEventId: CONTRACT_EVENT, responsibilityKey: "weekly-report", criterionId: "on-time", checkHash: "fedcba9876543210" };

function byEndState(values: Partial<Record<AgentObligationEndState, number>>): Record<AgentObligationEndState, number> {
  return Object.fromEntries(AGENT_OBLIGATION_END_STATES.map((s) => [s, values[s] ?? 0])) as Record<AgentObligationEndState, number>;
}

function tally(pass: number, fail: number, unknown: number) {
  return { pass, fail, unknown };
}

function storedCard(version = 3): AgentCardView {
  return {
    kind: "agent_card_view",
    cardVersion: "agent-card/1",
    formulaVersion: "agent-metrics/1",
    companyId: "company-1",
    agentId: AGENT,
    agentName: "Scout",
    stored: { version, storedAt: "2026-10-29T10:00:00.000Z", cardHash: "a".repeat(64) },
    sideEffectFree: false,
    contract: {
      source: "declared",
      contractVersion: "v2",
      contractEventId: CONTRACT_EVENT,
      profileRevisionId: "55555555-5555-4555-8555-555555555555",
      declaredAt: "2026-10-01T00:00:00.000Z",
      accountableUserId: "user-acc",
      responsibilities: [
        {
          key: "weekly-report",
          criteria: [
            { ref: CRIT_ATTEST, text: "The report cites its sources", predicate: { kind: "human_attest", attesterUserId: "user-attester" } },
            { ref: CRIT_RECORD, text: "Delivered by Monday noon", predicate: { kind: "record", predicate: "obligation.on_time", coverage: null } },
          ],
          coverage: [],
          expectedHumanSteps: [],
          humanJudge: null,
        },
      ],
    },
    replay: {
      throughSeq: 812,
      asOf: "2026-10-29T10:00:00.000Z",
      window: { from: "2026-09-29T10:00:00.000Z", to: "2026-10-29T10:00:00.000Z" },
      dependencies: [],
    },
    restricted: true,
    fatal: {
      visibility: "visible",
      body: [
        {
          fatalClass: "fabrication",
          key: "fatal:fabrication:issue-1",
          status: "potential",
          item: { kind: "issue", id: ISSUE_1 },
          raisedAt: "2026-10-20T09:00:00.000Z",
          evidenceRefs: [EV(1)],
          note: "A price in the report appears in no source",
        },
      ],
    },
    worker: {
      obligations: {
        visibility: "visible",
        body: {
          responsibilities: [
            {
              responsibilityKey: "weekly-report",
              title: "Weekly pipeline report",
              profileRevisionId: "55555555-5555-4555-8555-555555555555",
              kind: "scheduled",
              owed: 3,
              byEndState: byEndState({ delivered_on_time: 2, cause_unknown: 1 }),
              deliveredByOtherProducer: 0,
              deliveredItems: [{ kind: "issue", id: ISSUE_1 }, { kind: "issue", id: ISSUE_2 }],
              deliveredItemCount: 2,
              note: null,
            },
          ],
          unmapped: { items: 1 },
        },
      },
      quality: {
        visibility: "visible",
        body: {
          criteria: [
            {
              criterion: CRIT_ATTEST,
              text: "The report cites its sources",
              predicate: { kind: "human_attest", attesterUserId: "user-attester" },
              items: 2,
              byJudge: { person: tally(1, 0, 1), independent_agent: tally(1, 1, 0), harness: tally(0, 0, 2), evaluator: tally(0, 0, 2), self: tally(0, 0, 2) },
            },
          ],
          judgeIndependence: { independent: 2, notIndependent: 0, unknown: 0 },
          sourceDiversity: { T1: 2 },
          unboundObservations: 1,
          rework: { items: 0, reopened: 0 },
        },
      },
      acceptance: {
        visibility: "visible",
        body: {
          facts: {
            automatedAcceptance: { yes: 1, no: 1, unknown: 0, of: 2 },
            humanAcceptance: { yes: 1, no: 0, unknown: 1, of: 2 },
            use: { yes: 0, no: 0, unknown: 2, of: 2 },
            outcome: { yes: 0, no: 0, unknown: 2, of: 2 },
          },
          accountable: [],
          delivered: { items: 2, byResponsibility: { "weekly-report": 2 } },
        },
      },
      cost: {
        visibility: "visible",
        body: {
          spendCents: 4200,
          unattributedSpendCents: null,
          runs: { total: 5, succeeded: 4, failed: 1, withoutIssue: 1 },
          questionsToPeople: { asked: 2, answered: 1, medianWaitMinutes: 30 },
          humanReviewActions: 1,
          humanCorrections: 0,
          selfReportedMinutes: null,
          byPerson: null,
        },
      },
      bounds: {
        visibility: "visible",
        body: {
          allowedUse: null,
          refusedAttempts: 2,
          repeatedAfterRefusal: 1,
          wouldRefuse: 0,
          unauthorizedExecution: 0,
          byDimension: { "talk.agents": { refused: 2, repeated: 1, wouldRefuse: 0, unauthorized: 0 } },
        },
      },
      decisions: {
        visibility: "visible",
        body: {
          exceptions: [
            {
              kind: "disagreement",
              key: "disagreement:x",
              severity: "routine",
              routeToUserId: "user-acc",
              item: { kind: "issue", id: ISSUE_2 },
              criterion: CRIT_ATTEST,
              raisedAt: "2026-10-22T09:00:00.000Z",
              evidenceRefs: [EV(2), EV(3)],
              note: "bound judgments disagree on this criterion; both stay, nothing is settled by vote",
            },
          ],
          disagreements: [
            {
              criterion: CRIT_ATTEST,
              item: { kind: "issue", id: ISSUE_2 },
              judgments: [
                { judge: "person", result: "pass", eventId: EV(2), at: "2026-10-21T09:00:00.000Z" },
                { judge: "independent_agent", result: "fail", eventId: EV(3), at: "2026-10-22T09:00:00.000Z" },
              ],
              notedEventId: null,
            },
          ],
          calibration: { sampled: 2, closed: 1, agreementByJudge: { independent_agent: { agree: 0, of: 1 } } },
          unownedWork: 1,
        },
      },
    },
    reviewer: {
      visibility: "visible",
      body: { reviews: { total: 0, bound: 0, unbound: 0, byOutcome: {} }, independence: { independent: 0, notIndependent: 0, unknown: 0 }, agreementWithPeople: { agree: 0, disagree: 0, of: 0 } },
    },
    gaps: { visibility: "visible", body: [{ code: "UNBOUND_JUDGMENTS", section: "quality", message: "One automated observation names no criterion." }] },
    markers: [],
    viewer: viewerFlags(),
  };
}

function viewerFlags(): AgentCardViewerPermissions {
  return { ...perms.value, attestableCriteria: [...perms.value.attestableCriteria] };
}

function setViewer(over: Partial<AgentCardViewerPermissions>) {
  perms.value = { ...perms.value, ...over };
}

function versionList(latest: number) {
  return {
    agentId: AGENT,
    versions: Array.from({ length: latest }, (_, index) => latest - index).map((version) => ({
      version,
      cardHash: String(version).repeat(64).slice(0, 64),
      throughSeq: 800 + version,
      asOf: `2026-10-2${version}T10:00:00.000Z`,
      createdAt: `2026-10-2${version}T10:00:01.000Z`,
    })),
  };
}

function caseRow(over: Partial<AgentCaseRow>): AgentCaseRow {
  return {
    caseId: "case-1",
    section: "obligations",
    responsibilityKey: "weekly-report",
    state: "delivered_on_time",
    role: "responsible",
    item: { kind: "issue", id: ISSUE_1 },
    itemLabel: "PAP-12",
    occurrenceId: "scheduled:x:2026-10-06T09:00:00.000Z",
    criterion: null,
    judge: null,
    at: "2026-10-06T10:00:00.000Z",
    evidenceRefs: [EV(4)],
    note: null,
    ...over,
  };
}

function caseList(rows: AgentCaseRow[], total = rows.length): AgentCaseList {
  return { agentId: AGENT, version: 3, throughSeq: 812, rows, total, nextCursor: null, restricted: true };
}

function projection(): AgentPerformanceProjection {
  return {
    kind: "agent_performance_projection",
    version: "agent-projection/0",
    companyId: "company-1",
    agentId: AGENT,
    generatedAt: "2026-10-29T12:00:00.000Z",
    asOf: "2026-10-29T12:00:00.000Z",
    window: { from: "2026-09-29T12:00:00.000Z", to: "2026-10-29T12:00:00.000Z" },
    throughSeq: null,
    sideEffectFree: true,
    owed: { source: "current_definitions", historyKnown: false, routines: [], assigned: { open: 0, inProgress: 0, inReview: 0, blocked: 0, done: 0, cancelled: 0 } },
    quality: { verdicts: { passed: 0, failed: 0, changesRequested: 0, escalated: 0, other: 0 }, byJudge: { person: 0, independentAgent: 0, nonIndependent: 0 } },
    acceptance: { automated: { value: 0, of: 0 }, human: { value: 0, of: 0 }, use: { value: null }, outcome: { value: null }, accountable: [] },
    cost: { spendCents: 0, runs: { total: 0, succeeded: 0, failed: 0, withoutIssue: 0 }, peopleProxies: { questionsAsked: 0, questionsAnswered: 0, medianAnswerWaitMinutes: null, humanCorrections: { value: 0 } } },
    bounds: { refusedAttempts: 0, byCode: {} },
    decisions: { pendingApprovals: 0, openQuestionsToPeople: 0 },
    gaps: [],
    withheld: [],
  };
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AgentPerformanceTab
            companyId="company-1"
            agentId={AGENT}
            accountable={{ userId: "user-acc", name: "Ana Accountable", email: null, via: "steward" }}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

/** Visible text: screen-reader-only hints on case-count buttons are left out. */
function text(node: ParentNode, testId: string): string {
  const el = node.querySelector(`[data-testid='${testId}']`);
  if (!el) return "";
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(".sr-only").forEach((hint) => hint.remove());
  return clone.textContent ?? "";
}

function buttonByText(node: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(node.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
}

/** The n-th case-count button in the fact row labelled `label` inside section `sectionId`. */
function countButton(node: ParentNode, sectionId: string, label: string, index = 0): HTMLButtonElement {
  const rows = Array.from(node.querySelectorAll(`[data-testid='${sectionId}'] dl > div`));
  const row = rows.find((el) => el.querySelector("dt")?.textContent === label);
  const button = row?.querySelectorAll<HTMLButtonElement>("[data-testid='agent-card-case-count']")[index];
  if (!button) throw new Error(`no case count for ${sectionId} / ${label} [${index}]`);
  return button;
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.click();
  });
  await flush();
}

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  session.userId = "user-member";
  session.role = "member";
  perms.value = { canSnapshot: false, canNoteDisagreement: false, canConfirmUse: true, attestableCriteria: [] };
  mockApi.card.mockImplementation(async (_c: string, _a: string, version: number | null) => ({ card: storedCard(version ?? 3), viewer: viewerFlags() }));
  mockApi.versions.mockImplementation(async () => versionList(3));
  mockApi.cases.mockResolvedValue(caseList([]));
  mockApi.projection.mockResolvedValue(projection());
  mockApi.recordDisposition.mockResolvedValue({ inserted: 1, skipped: 0, eventId: EV(9), status: "recorded" });
  mockManager.get.mockResolvedValue({
    kind: "performance_manager",
    companyId: "company-1",
    designatedAgentId: null,
    designated: null,
    effective: null,
    source: "none",
    viewer: { canChange: false },
  });
  mockManager.recommendations.mockResolvedValue({ agentId: AGENT, recommendations: [], restricted: false });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("AgentPerformanceTab — the stored agent card", () => {
  it("shows the latest stored card: fatal flags first, the six questions in order, reviews of others' work separate", async () => {
    const node = await render();
    expect(mockApi.card).toHaveBeenCalledWith("company-1", AGENT, null);
    expect(text(node, "agent-card-status")).toContain("Stored card, version 3 (latest), saved");
    const headings = Array.from(node.querySelectorAll("[data-testid='agent-card'] h3")).map((h) => h.textContent?.trim());
    expect(headings).toEqual([
      FATAL_TITLE,
      CARD_QUESTIONS.obligations,
      CARD_QUESTIONS.quality,
      CARD_QUESTIONS.acceptance,
      CARD_QUESTIONS.cost,
      CARD_QUESTIONS.bounds,
      CARD_QUESTIONS.decisions,
      REVIEWER_TITLE,
      "Gaps",
    ]);
    // A fatal flag is potential, not confirmed.
    const flag = text(node, "agent-card-fatal-flag");
    expect(flag).toContain("Fabricated facts, claims or prices");
    expect(flag).toContain("Potential — not confirmed by a person");
    expect(flag).not.toMatch(/Status: Confirmed/);
    // Denominators, and unknown is never 0.
    expect(text(node, "agent-card-obligations")).toContain("Delivered on time2 of 3");
    expect(text(node, "agent-card-obligations")).toContain("Cause unknown1 of 3");
    expect(text(node, "agent-card-bounds")).toContain("Allowed useUnknown — no record of allowed use");
    expect(text(node, "agent-card-cost")).toContain("Visible to company admins and the agent's accountable person.");
    expect(text(node, "agent-card-header")).toContain("ledger read through event 812");
    expect(text(node, "agent-card-header")).toContain("Numbers count only the records you can read.");
  });

  it("has no gauge, score or ranking", async () => {
    const node = await render();
    expect(node.querySelector("[role='meter'], [role='progressbar'], meter, progress")).toBeNull();
    expect(node.textContent?.toLowerCase()).not.toMatch(/\bscore\b|\brank(ing)?\b|\bgauge\b/);
  });

  it("offers a version picker when several versions are stored, from the server's version list, and reads the one chosen", async () => {
    // The stored versions need not be contiguous: the picker lists what the server has.
    mockApi.versions.mockResolvedValue({ agentId: AGENT, versions: versionList(3).versions.filter((v) => v.version !== 1).concat([]) });
    const node = await render();
    expect(mockApi.versions).toHaveBeenCalledWith("company-1", AGENT);
    const select = node.querySelector<HTMLSelectElement>("[data-testid='agent-card-version']")!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["3", "2"]);
    const labels = Array.from(select.options).map((o) => o.textContent ?? "");
    expect(labels[0]).toMatch(/^3 \(latest\) · as of /);
    expect(labels[1]).toMatch(/^2 · as of /);
    await selectValue(select, "2");
    expect(mockApi.card).toHaveBeenCalledWith("company-1", AGENT, 2);
    expect(text(node, "agent-card-status")).toContain("Stored card, version 2, saved");
  });

  it("has no version picker when only one version is stored", async () => {
    mockApi.card.mockResolvedValue({ card: storedCard(1), viewer: viewerFlags() });
    const node = await render();
    expect(node.querySelector("[data-testid='agent-card-version']")).toBeNull();
    expect(mockApi.versions).not.toHaveBeenCalled();
  });

  it("'Compute now' shows the card at the current records, labelled not saved, with no case drill-down", async () => {
    mockApi.compute.mockResolvedValue({ card: { ...storedCard(), stored: null, sideEffectFree: true } });
    const node = await render();
    await click(buttonByText(node, "Compute now"));
    expect(mockApi.compute).toHaveBeenCalledWith("company-1", AGENT, 30);
    expect(text(node, "agent-card-status")).toBe(COMPUTED_NOT_SAVED_TEXT);
    expect(text(node, "agent-card-compute-note")).toContain("Nothing was stored, no findings were added and no review items were created.");
    expect(node.querySelectorAll("[data-testid='agent-card-case-count']")).toHaveLength(0);
    expect(text(node, "agent-card-no-cases")).toContain("computed now and not stored");
    expect(text(node, "agent-card-obligations")).toContain("Delivered on time2 of 3");
    await click(buttonByText(node, "Back to the stored card"));
    expect(text(node, "agent-card-status")).toContain("Stored card, version 3");
  });

  it("with no stored card, says so and keeps the gate 1 projection as the fallback", async () => {
    mockApi.card.mockResolvedValue({ card: null, viewer: viewerFlags() });
    const node = await render();
    expect(text(node, "agent-card-status")).toBe(NO_STORED_CARD_TEXT);
    expect(text(node, "agent-card-none")).toContain("No stored card yet.");
    expect(mockApi.projection).toHaveBeenCalledWith("company-1", AGENT, 30);
    expect(node.querySelector("[data-testid='agent-performance-tab']")).not.toBeNull();
    expect(node.querySelector("[data-testid='agent-card']")).toBeNull();
    expect(buttonByText(node, "Take snapshot")).toBeUndefined();
  });

  it("with no stored card, offers a snapshot when the server's flags allow it", async () => {
    setViewer({ canSnapshot: true });
    mockApi.card.mockResolvedValue({ card: null, viewer: viewerFlags() });
    const node = await render();
    expect(text(node, "agent-card-none")).toContain("Take snapshot stores one.");
    expect(buttonByText(node, "Take snapshot")).toBeDefined();
  });

  it("says 'Not visible to you' for sections the viewer can't read, with no counts", async () => {
    const card = storedCard();
    card.fatal = { visibility: "not_visible", note: NOT_VISIBLE_TEXT };
    card.worker.cost = { visibility: "not_visible", note: NOT_VISIBLE_TEXT };
    mockApi.card.mockResolvedValue({ card, viewer: card.viewer });
    const node = await render();
    for (const id of ["agent-card-fatal", "agent-card-cost"]) {
      const section = text(node, id);
      expect(section).toContain(`${NOT_VISIBLE_TEXT}.`);
      expect(section.replace(/^[^.]*\?/, "")).not.toMatch(/\d/);
    }
    expect(node.querySelector("[data-testid='agent-card-fatal-flag']")).toBeNull();
    expect(text(node, "agent-card-cost")).not.toContain("$");
  });

  it("marks a partly visible section and counts only what the viewer reads", async () => {
    const card = storedCard();
    const obligations = card.worker.obligations as Extract<AgentCardView["worker"]["obligations"], { visibility: "visible" }>;
    card.worker.obligations = { visibility: "partial", body: obligations.body, note: "Some records behind this section are not visible to you; the numbers count only what you can see." };
    mockApi.card.mockResolvedValue({ card, viewer: card.viewer });
    const node = await render();
    expect(text(node, "agent-card-partial")).toContain("Partly visible.");
    expect(text(node, "agent-card-partial")).toContain("the numbers count only what you can see");
    expect(text(node, "agent-card-obligations")).toContain("Delivered on time2 of 3");
  });
});

describe("AgentPerformanceTab — cases behind a number", () => {
  it("opens the cases: filtered by section, responsibility and state, with links and a state filter", async () => {
    mockApi.cases.mockResolvedValue(caseList([caseRow({ caseId: "c1" }), caseRow({ caseId: "c2", item: { kind: "issue", id: ISSUE_2 }, itemLabel: "PAP-13" })], 2));
    const node = await render();
    const button = countButton(node, "agent-card-obligations", "Delivered on time");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(mockApi.cases).toHaveBeenCalledWith("company-1", AGENT, {
      version: 3,
      section: "obligations",
      responsibility: "weekly-report",
      state: "delivered_on_time",
      limit: 50,
      cursor: null,
    });
    const drill = node.querySelector<HTMLElement>("[data-testid='agent-case-drilldown']")!;
    expect(button.getAttribute("aria-controls")).toBe(drill.id);
    expect(drill.textContent).toContain("Cases: delivered on time, Weekly pipeline report");
    expect(text(drill, "agent-case-total")).toBe("2 cases. Only cases you can read are listed and counted.");
    const links = Array.from(drill.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/PAP/issues/PAP-12", "/PAP/issues/PAP-13"]);
    expect(drill.textContent).toContain("State: Delivered on time");

    const filter = drill.querySelector<HTMLSelectElement>("[data-testid='agent-case-state-filter']")!;
    expect(filter.value).toBe("delivered_on_time");
    mockApi.cases.mockResolvedValue(caseList([caseRow({ caseId: "c3", state: "cause_unknown", note: "no run and no evidence of a block" })]));
    await selectValue(filter, "cause_unknown");
    expect(mockApi.cases).toHaveBeenLastCalledWith("company-1", AGENT, expect.objectContaining({ state: "cause_unknown", section: "obligations" }));
    expect(node.querySelector("[data-testid='agent-case-drilldown']")?.textContent).toContain("no run and no evidence of a block");

    await click(buttonByText(node, "Close cases"));
    expect(node.querySelector("[data-testid='agent-case-drilldown']")).toBeNull();
  });

  it("shows unbound judgments as such: they name no criterion and satisfy none (filtered by the server)", async () => {
    mockApi.cases.mockResolvedValue(
      caseList([caseRow({ caseId: "u1", section: "quality", state: "unknown", role: "producer", judge: "harness", criterion: null, note: "unbound automated observation" })]),
    );
    const node = await render();
    await click(countButton(node, "agent-card-quality", "Unbound observations"));
    expect(mockApi.cases).toHaveBeenCalledWith("company-1", AGENT, { version: 3, section: "quality", criterion: AGENT_CASE_FILTER_NONE, limit: 50, cursor: null });
    const drill = node.querySelector<HTMLElement>("[data-testid='agent-case-drilldown']")!;
    expect(drill.querySelectorAll("[data-testid='agent-case-row']")).toHaveLength(1);
    expect(text(drill, "agent-case-unbound")).toBe(UNBOUND_TEXT);
    expect(text(drill, "agent-case-total")).toBe("1 case. Only cases you can read are listed and counted.");
  });

  it("sends every narrowing to the server: a fact, a criterion and judge, work with no responsibility", async () => {
    const node = await render();
    await click(countButton(node, "agent-card-acceptance", "Accepted by a person"));
    expect(mockApi.cases).toHaveBeenLastCalledWith("company-1", AGENT, { version: 3, section: "acceptance", fact: "human", state: "pass", limit: 50, cursor: null });
    await click(countButton(node, "agent-card-quality", "An independent agent", 1));
    expect(mockApi.cases).toHaveBeenLastCalledWith("company-1", AGENT, {
      version: 3,
      section: "quality",
      responsibility: "weekly-report",
      criterion: evaluationCriterionRefKey(CRIT_ATTEST),
      judge: "independent_agent",
      state: "fail",
      limit: 50,
      cursor: null,
    });
    await click(countButton(node, "agent-card-obligations", "Work that maps to no responsibility"));
    expect(mockApi.cases).toHaveBeenLastCalledWith("company-1", AGENT, { version: 3, section: "obligations", responsibility: AGENT_CASE_FILTER_NONE, limit: 50, cursor: null });
    // Whatever the server returns is listed and counted as it is.
    mockApi.cases.mockResolvedValue(caseList([caseRow({ caseId: "x1" }), caseRow({ caseId: "x2", responsibilityKey: null })], 7));
    await click(countButton(node, "agent-card-decisions", "Work no responsibility owns"));
    const drill = node.querySelector<HTMLElement>("[data-testid='agent-case-drilldown']")!;
    expect(drill.querySelectorAll("[data-testid='agent-case-row']")).toHaveLength(2);
    expect(text(drill, "agent-case-total")).toBe("7 cases. Only cases you can read are listed and counted.");
  });

  it("opens refused attempts under bounds", async () => {
    mockApi.cases.mockResolvedValue(caseList([caseRow({ caseId: "r1", section: "bounds", state: "refused", role: "producer", note: "a refused attempt (an attempt, not misconduct)" })]));
    const node = await render();
    await click(countButton(node, "agent-card-bounds", "Refused attempts"));
    expect(mockApi.cases).toHaveBeenCalledWith("company-1", AGENT, expect.objectContaining({ section: "bounds", state: "refused" }));
    expect(node.querySelector("[data-testid='agent-case-drilldown']")?.textContent).toContain("State: Refused");
  });
});

describe("AgentPerformanceTab — actions per viewer", () => {
  it("a member: Confirm use on unconfirmed use, no Attest, no Note disagreement, no Take snapshot", async () => {
    mockApi.cases.mockImplementation(async (_c: string, _a: string, filter: { section: string }) =>
      filter.section === "acceptance"
        ? caseList([caseRow({ caseId: "use1", section: "acceptance", state: "unknown", role: "producer", fact: "use", note: "use", evidenceRefs: [] })])
        : caseList([caseRow({ caseId: "q1", section: "quality", state: "unknown", role: "producer", criterion: CRIT_ATTEST, evidenceRefs: [EV(5)] })]),
    );
    const node = await render();
    expect(buttonByText(node, "Take snapshot")).toBeUndefined();
    expect(node.querySelector("[data-testid='agent-card-note-disagreement']")).toBeNull();

    // 0 yes and 0 no open nothing; the 2 unknown open their cases.
    await click(countButton(node, "agent-card-acceptance", "Used"));
    expect(mockApi.cases).toHaveBeenLastCalledWith("company-1", AGENT, expect.objectContaining({ section: "acceptance", fact: "use", state: "unknown" }));
    expect(text(node, "agent-case-row")).toContain("Used");
    expect(node.querySelector("[data-testid='agent-case-confirm-use']")).not.toBeNull();
    await click(buttonByText(node, "Confirm use"));
    await click(buttonByText(node.querySelector("[data-testid='agent-case-confirm-use']")!, "Confirm use"));
    expect(mockApi.recordDisposition).toHaveBeenCalledWith("company-1", {
      kind: "use_confirmed",
      subjectRef: { kind: "agent", id: AGENT },
      item: { kind: "issue", id: ISSUE_1 },
      responsibilityKey: "weekly-report",
      evidenceRefs: [],
    });
    const status = node.querySelector("[data-testid='agent-case-confirm-use'] [role='status']");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toBe("Recorded. The next card reflects it.");

    await click(countButton(node, "agent-card-quality", "Work items in scope"));
    expect(node.querySelector("[data-testid='agent-case-attest']")).toBeNull();
  });

  it("the named attester can attest the criterion, bound to its tuple, the agent and the item, citing the case's own records", async () => {
    session.userId = "user-attester";
    setViewer({ attestableCriteria: [evaluationCriterionRefKey(CRIT_ATTEST)] });
    // The unjudged quality case carries the item's records itself.
    mockApi.cases.mockResolvedValue(caseList([caseRow({ caseId: "q1", section: "quality", state: "unknown", role: "producer", criterion: CRIT_ATTEST, evidenceRefs: [EV(5)] })]));
    const node = await render();
    expect(buttonByText(node, "Take snapshot")).toBeUndefined();
    await click(countButton(node, "agent-card-quality", "Work items in scope"));
    expect(mockApi.cases).toHaveBeenLastCalledWith("company-1", AGENT, expect.objectContaining({ section: "quality", criterion: evaluationCriterionRefKey(CRIT_ATTEST) }));
    const attest = node.querySelector<HTMLElement>("[data-testid='agent-case-attest']")!;
    expect(attest).not.toBeNull();
    await click(buttonByText(attest, "Attest criterion"));
    // No other case list is read to borrow evidence.
    expect(mockApi.cases.mock.calls.every(([, , filter]) => (filter as { section: string }).section === "quality")).toBe(true);
    await typeInto(attest.querySelector("textarea")!, "Checked each figure against the CRM export");
    await click(buttonByText(attest, "Record attestation"));
    expect(mockApi.recordDisposition).toHaveBeenCalledWith("company-1", {
      kind: "criterion_attest",
      binding: { criterion: CRIT_ATTEST, subjectRef: { kind: "agent", id: AGENT }, item: { kind: "issue", id: ISSUE_1 } },
      result: "satisfied",
      evidenceRefs: [EV(5)],
      note: "Checked each figure against the CRM export",
    });
    expect(attest.querySelector("[role='status']")?.textContent).toBe("Recorded. The next card reflects it.");
  });

  it("can't attest a case with no record to cite, and says so", async () => {
    session.userId = "user-attester";
    setViewer({ attestableCriteria: [evaluationCriterionRefKey(CRIT_ATTEST)] });
    mockApi.cases.mockResolvedValue(caseList([caseRow({ caseId: "q1", section: "quality", state: "unknown", role: "producer", criterion: CRIT_ATTEST, evidenceRefs: [] })]));
    const node = await render();
    await click(countButton(node, "agent-card-quality", "Work items in scope"));
    const attest = node.querySelector<HTMLElement>("[data-testid='agent-case-attest']")!;
    await click(buttonByText(attest, "Attest criterion"));
    expect(attest.textContent).toContain("There is no ledger record to cite for this item yet, so it can't be attested here.");
    expect(buttonByText(attest, "Record attestation")?.disabled).toBe(true);
  });

  it("does not offer Attest on a criterion the server's flags don't name for this viewer", async () => {
    session.userId = "user-attester";
    setViewer({ attestableCriteria: [evaluationCriterionRefKey(CRIT_ATTEST)] });
    mockApi.cases.mockResolvedValue(caseList([caseRow({ caseId: "q2", section: "quality", state: "unknown", role: "producer", criterion: CRIT_RECORD })]));
    const node = await render();
    await click(countButton(node, "agent-card-quality", "Work items in scope"));
    expect(node.querySelectorAll("[data-testid='agent-case-row']")).toHaveLength(1);
    expect(node.querySelector("[data-testid='agent-case-attest']")).toBeNull();
  });

  it("follows the server's flags, not the viewer's role", async () => {
    // A company admin by role whose card says otherwise sees no snapshot or note action…
    session.role = "admin";
    const node = await render();
    expect(buttonByText(node, "Take snapshot")).toBeUndefined();
    expect(node.querySelector("[data-testid='agent-card-note-disagreement']")).toBeNull();
    act(() => root!.unmount());
    container?.remove();
    // …and a member the server allows (an instance admin, say) gets both.
    session.role = "member";
    setViewer({ canSnapshot: true, canNoteDisagreement: true });
    const again = await render();
    expect(buttonByText(again, "Take snapshot")).toBeDefined();
    expect(again.querySelector("[data-testid='agent-card-note-disagreement']")).not.toBeNull();
  });

  it("the accountable person can take a snapshot and note a disagreement; results are announced", async () => {
    session.userId = "user-acc";
    setViewer({ canSnapshot: true, canNoteDisagreement: true });
    mockApi.snapshot.mockResolvedValue({
      snapshot: { version: 4, reused: false, throughSeq: 820, cardHash: "b".repeat(64), formulaVersion: "agent-metrics/1" },
      verify: { ok: true, status: "agree", version: 4 },
      card: storedCard(4),
    });
    const node = await render();
    expect(text(node, "agent-card-exception")).toContain("For: You");
    await click(buttonByText(node, "Take snapshot"));
    expect(mockApi.snapshot).toHaveBeenCalledWith("company-1", AGENT, 30);
    const announcement = node.querySelector("[data-testid='agent-card-announcement']")!;
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.getAttribute("aria-live")).toBe("polite");
    expect(announcement.textContent).toBe("Stored as version 4. Replaying it gave the same card.");

    const disagreement = node.querySelector<HTMLElement>("[data-testid='agent-card-disagreement']")!;
    expect(disagreement.textContent).toContain("Noted by a person: Not yet");
    await click(buttonByText(disagreement, "Note disagreement"));
    await typeInto(disagreement.querySelector("textarea")!, "The independent agent missed the appendix");
    await click(buttonByText(disagreement, "Record note"));
    expect(mockApi.recordDisposition).toHaveBeenCalledWith("company-1", {
      kind: "disagreement_noted",
      subjectRef: { kind: "agent", id: AGENT },
      item: { kind: "issue", id: ISSUE_2 },
      criterion: CRIT_ATTEST,
      judgmentEventIds: [EV(2), EV(3)],
      note: "The independent agent missed the appendix",
    });
  });

  it("an admin can take a snapshot; a kept version and a refusal are both said plainly", async () => {
    setViewer({ canSnapshot: true, canNoteDisagreement: true });
    mockApi.snapshot.mockResolvedValueOnce({
      snapshot: { version: 3, reused: true, throughSeq: 812, cardHash: "a".repeat(64), formulaVersion: "agent-metrics/1" },
      verify: { ok: true, status: "agree", version: 3 },
      card: storedCard(3),
    });
    const node = await render();
    await click(buttonByText(node, "Take snapshot"));
    expect(text(node, "agent-card-announcement")).toBe("No new records since version 3, so that version was kept. Replaying it gave the same card.");
    const { ApiError } = await import("../../api/client");
    mockApi.snapshot.mockRejectedValueOnce(new ApiError("Only the agent's accountable person or a company admin can snapshot or verify its card.", 403, {}));
    await click(buttonByText(node, "Take snapshot"));
    expect(node.querySelector("[data-testid='agent-card-problem']")?.getAttribute("role")).toBe("alert");
    expect(text(node, "agent-card-problem")).toContain("The server refused to take a snapshot");
  });
});

describe("AgentPerformanceTab — recommendations cite the card (APM gate 4)", () => {
  it("shows a cited stored card version when its evidence is chosen, and announces it", async () => {
    mockManager.recommendations.mockResolvedValue({
      agentId: AGENT,
      restricted: false,
      recommendations: [
        {
          id: "rec-1",
          companyId: "company-1",
          agentId: AGENT,
          kind: "repair",
          reason: "Two reports in a row were late.",
          evidence: [{ kind: "card", ref: "1" }],
          proposalApprovalId: null,
          recommendedByAgentId: "agent-cos",
          recommendedAt: "2026-10-29T09:00:00.000Z",
          eventId: EV(5),
          advisory: true,
          decision: null,
        },
      ],
    });
    const node = await render();
    await flush();
    expect(text(node, "agent-performance-recommendations")).toContain("Recommends a repair");
    await click(buttonByText(node, "Card version 1"));
    await flush();
    expect(mockApi.card).toHaveBeenCalledWith("company-1", AGENT, 1);
    expect(text(node, "agent-card-status")).toContain("Stored card, version 1, saved");
    expect(text(node, "agent-card-announcement")).toContain("Showing card version 1, cited by a recommendation.");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("agent-card-status");
  });
});
