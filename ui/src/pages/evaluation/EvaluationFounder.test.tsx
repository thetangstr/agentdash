// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationOverview, ScoredCard } from "@paperclipai/shared";
import type React from "react";
import { EvaluationFounder } from "./EvaluationFounder";

const overviewMock = vi.hoisted(() => vi.fn());
const latestMock = vi.hoisted(() => vi.fn());
const versionsMock = vi.hoisted(() => vi.fn());
const eventsMock = vi.hoisted(() => vi.fn());
const eventMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/evaluation", () => ({
  evaluationApi: {
    overview: (companyId: string) => overviewMock(companyId),
    latest: (companyId: string, ref: unknown, verify?: boolean) => latestMock(companyId, ref, verify),
    versions: (companyId: string, ref: unknown) => versionsMock(companyId, ref),
    events: (companyId: string, opts: unknown) => eventsMock(companyId, opts),
    event: (companyId: string, id: string) => eventMock(companyId, id),
    replay: vi.fn(),
    snapshot: vi.fn(),
  },
}));
vi.mock("@/api/access", () => ({ accessApi: { listMembers: async () => ({ members: [], access: { currentUserRole: "admin", canManageMembers: true, canInviteUsers: true, canApproveJoinRequests: true, canManageAgents: true } }) } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: async () => [] } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }) }));
vi.mock("@/components/PageTabBar", () => ({
  PageTabBar: ({ items, onValueChange }: { items: Array<{ value: string; label: unknown }>; onValueChange?: (v: string) => void }) => (
    <div>
      {items.map((i) => (
        <button key={i.value} type="button" data-testid={`tab-${i.value}`} onClick={() => onValueChange?.(i.value)}>
          {String(i.label)}
        </button>
      ))}
    </div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const MILESTONE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

function metric(key: string, over: Record<string, unknown> = {}) {
  return {
    key,
    name: key,
    value: 0.75,
    unit: "share satisfied",
    n: 4,
    coverage: 1,
    confidence: "high",
    confidenceLabel: ({ high: "strong evidence", medium: "adequate evidence", low: "limited evidence", insufficient: "insufficient evidence" } as Record<string, string>)[String(over.confidence ?? "high")],
    breakdown: { satisfied: 3, failed: 1, undecidable: [] },
    headline: "satisfied 3 of 4 done; 1 failed",
    formulaVersion: "metrics/2",
    evidenceRefs: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"],
    evidenceRefCount: 2,
    tiers: ["T0"],
    lowerIsBetter: false,
    displayOnly: false,
    detail: {},
    notes: ["over the decidable population"],
    ...over,
  };
}

const composite = (score: number | null, reasons: string[] = []) => ({
  kind: "outcome",
  score,
  confidence: score == null ? null : "medium",
  coverage: score == null ? null : 0.7,
  included: score == null ? [] : [{ key: "O1", weight: 0.4, coverage: 1, scaled: 75, confidence: "high" }, { key: "O5", weight: 0.15, coverage: 0.6, scaled: 60, confidence: "medium" }],
  excluded: [{ key: "O2", reason: "insufficient evidence: no target date" }],
  flags: [],
  guard: { minIncluded: 2, coverageFloor: 0.5, maxConcentration: 0.75, concentration: 0.7, satisfied: reasons.length === 0, reasons, ...(reasons[0] ? { reason: reasons[0] } : {}) },
  formulaVersion: "composite/5",
});

const card = {
  formulaVersion: "m2-score/5",
  milestoneRef: { kind: "project", id: MILESTONE },
  milestoneName: "Launch",
  throughSeq: 42,
  throughEventId: null,
  asOf: "2026-09-05T12:00:00.000Z",
  markers: ["open milestone — denominators still moving"],
  contract: { source: "derived", contractVersion: "derived/1", declaredAt: null, declaredBy: null, accountableUserId: "founder-1", leadAgentId: null, requiredEvidence: ["dod_present", "neutral_verdict"], criteriaCount: 0, measurableCriteria: 0, exceptions: [], founderLocks: [], excludedReviewers: [], targetDate: null, eventId: null, invalidVersions: 0 },
  membership: { items: 4, done: 3, cancelled: 0, open: 1, excludedEvaluatorItems: 0, movedIn: 0, movedOut: 0 },
  outcome: { O1: metric("O1", { name: "Acceptance satisfied" }), O5: metric("O5", { name: "Evidence hygiene", value: 0.6, coverage: 0.6, confidence: "medium" }) },
  outcomeComposite: composite(68.1),
  actors: [
    { actorKey: "agent:b", actorType: "agent", actorId: "b", name: "Builder", metrics: { P1: metric("P1", { name: "Autonomy", unit: "share of items with zero interventions", detail: { interventions: 2 } }), P8: metric("P8", { name: "Token and cost efficiency", unit: "cents per O1-satisfied item", value: 0.5, displayOnly: true, detail: { runs: 34, metered: 3, totalCents: 1234, medianRunCents: 400 } }) }, composite: { ...composite(55), kind: "operating" } },
    { actorKey: "agent:t", actorType: "agent", actorId: "t", name: "Tester", metrics: { P1: metric("P1", { name: "Autonomy", unit: "share of items with zero interventions", detail: { interventions: 0 } }) }, composite: { ...composite(91), kind: "operating" } },
    { actorKey: "agent:z", actorType: "agent", actorId: "z", name: "Zed", metrics: { P1: metric("P1", { name: "Autonomy" }) }, composite: { ...composite(null, ["fewer than 3 metrics have evidence"]), kind: "operating" } },
    { actorKey: "company:c", actorType: "company", actorId: "company-1", name: null, metrics: {}, composite: null },
  ],
  exceptions: [
    { id: "E4", title: "self-review", severity: "immediate", routes: ["founder_view", "manager"], key: "E4:issue:x", subject: { kind: "issue", id: "x", identifier: "PAP-7" }, routing: { accountableUserId: "founder-1", managerAgentIds: [], founderView: true }, actorAgentId: "b", raisedAt: "2026-09-04T10:00:00.000Z", evidenceRefs: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"], note: "the contributor reviewed their own work", markers: [] },
  ],
  exceptionsTotal: 1,
  exceptionCounts: { E4: 1 },
  flags: [],
  excludedMetrics: [{ key: "O4", scope: "milestone", reason: "shown, never scored" }],
  missingSources: ["CI evidence: no structured regression gates and no GitHub check runs"],
  maxIngestLagMs: 120000,
  eventCount: 40,
  byType: { "issue.created": 4, "verdict.recorded": 3 },
  byActorType: {},
  bySource: {},
  issueIds: [],
  issueCount: 4,
  actorKeys: [],
  firstEventTime: "2026-09-01T00:00:00.000Z",
  lastEventTime: "2026-09-05T00:00:00.000Z",
  state: { open: true, retrospective: false },
} as unknown as ScoredCard;

const overview: EvaluationOverview = {
  milestones: [
    {
      ref: { kind: "project", id: MILESTONE },
      name: "Launch",
      status: "in_progress",
      latest: {
        version: 3,
        storedAt: "2026-09-05T12:00:00.000Z",
        formulaVersion: "m2-score/5",
        throughSeq: 42,
        outcome: { score: 72.4, confidence: "medium", coverage: 0.68, reason: null },
        operatingActors: 2,
        exceptions: { total: 3, immediate: 1, material: 0, routine: 2 },
        markers: ["open milestone — denominators still moving"],
        missingSources: 1,
        interventions: { count: 2, population: 4, caveat: "synthetic human identities: interventions are countable, not attributable" },
        cost: { cents: 1234, meteredRuns: 3, runs: 34 },
        trend: [{ version: 1, score: 60, storedAt: "2026-09-03T00:00:00.000Z" }, { version: 2, score: null, storedAt: "2026-09-04T00:00:00.000Z" }, { version: 3, score: 72.4, storedAt: "2026-09-05T12:00:00.000Z" }],
      },
    },
    {
      ref: { kind: "project", id: OTHER },
      name: "Baseline",
      status: "in_progress",
      latest: {
        version: 1,
        storedAt: "2026-09-05T11:00:00.000Z",
        formulaVersion: "m2-score/5",
        throughSeq: 40,
        outcome: { score: null, confidence: null, coverage: 0.47, reason: "O3 alone would supply 82% of the score; no single metric may supply more than 75%" },
        operatingActors: 0,
        exceptions: { total: 0, immediate: 0, material: 0, routine: 0 },
        markers: [],
        missingSources: 3,
        interventions: null,
        cost: null,
        trend: [{ version: 1, score: null, storedAt: "2026-09-05T11:00:00.000Z" }],
      },
    },
    { ref: { kind: "goal", id: "44444444-4444-4444-8444-444444444444" }, name: "Revenue", status: "active", latest: null },
  ],
  reviewProjectId: null,
  principal: { provisioned: true, agentId: "e1" },
  ledger: { maxSeq: 42 },
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  overviewMock.mockReset().mockResolvedValue(overview);
  latestMock.mockReset().mockResolvedValue({ latest: { id: "s1", companyId: "company-1", milestoneKind: "project", milestoneId: MILESTONE, version: 3, contractVersion: "derived/1", formulaVersion: "m2-score/5", throughSeq: 42, throughEventId: null, card, cardHash: "h".repeat(64), createdAt: "2026-09-05T12:00:00.000Z" }, verify: null });
  versionsMock.mockReset().mockResolvedValue({ versions: [] });
  eventsMock.mockReset().mockResolvedValue({ events: [], count: 0 });
  eventMock.mockReset().mockResolvedValue({ event: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", seq: 1, companyId: "company-1", projectId: null, goalId: null, actorType: "agent", actorId: "b", sourceTable: "issues", sourceId: "x", sourceVersion: "v", eventType: "issue.created", eventTime: "2026-09-01T00:00:00.000Z", ingestTime: "2026-09-01T00:00:01.000Z", payload: { title: "x" }, correlationId: null } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(path: string, element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/evaluation" element={element} />
            <Route path="/evaluation/founder" element={element} />
            <Route path="/evaluation/:kind/:id" element={element} />
            <Route path="/evaluation/:kind/:id/:tab" element={element} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}


describe("EvaluationFounder", () => {
  it("shows decisions waiting and rejected corrections from the ledger, material risk per card, and founder-view exceptions; loading and failures are said, never a false None", async () => {
    eventsMock.mockResolvedValue({
      events: [
        { id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1", seq: 50, companyId: "company-1", projectId: null, goalId: null, actorType: "user", actorId: "founder-1", sourceTable: "evaluation_corrections", sourceId: "x", sourceVersion: "v", eventType: "evaluation.correction", eventTime: "2026-09-05T13:00:00.000Z", ingestTime: "2026-09-05T13:00:00.000Z", payload: { disputedEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", claimedFact: "the item was reviewed by Tester" }, correlationId: null },
        { id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2", seq: 48, companyId: "company-1", projectId: null, goalId: null, actorType: "user", actorId: "founder-1", sourceTable: "evaluation_corrections", sourceId: "y", sourceVersion: "v", eventType: "evaluation.correction", eventTime: "2026-09-04T13:00:00.000Z", ingestTime: "2026-09-04T13:00:00.000Z", payload: { disputedEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", claimedFact: "this was a duplicate, not rework" }, correlationId: null },
        { id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1", seq: 49, companyId: "company-1", projectId: null, goalId: null, actorType: "user", actorId: "admin-1", sourceTable: "evaluation_dispositions", sourceId: "y", sourceVersion: "v", eventType: "evaluation.disposition", eventTime: "2026-09-04T15:00:00.000Z", ingestTime: "2026-09-04T15:00:00.000Z", payload: { kind: "correction_decided", correctionEventId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2", decision: "rejected" }, correlationId: null },
      ],
      count: 3,
      scope: null,
    });
    // the second milestone's card fails to load
    latestMock.mockImplementation(async (_c: string, ref: { id: string }) => {
      if (ref.id === OTHER) throw new Error("boom");
      return { latest: { id: "s1", companyId: "company-1", milestoneKind: "project", milestoneId: MILESTONE, version: 3, contractVersion: "derived/1", formulaVersion: "m2-score/5", throughSeq: 42, throughEventId: null, card, cardHash: "h".repeat(64), createdAt: "2026-09-05T12:00:00.000Z" }, verify: null };
    });
    render("/evaluation/founder", <EvaluationFounder />);
    await flush();
    await flush();
    const text = container.textContent ?? "";
    expect(eventsMock).toHaveBeenCalledWith("company-1", expect.objectContaining({ order: "desc" }));
    expect(text).toContain("Decisions waiting");
    expect(text).toContain("the item was reviewed by Tester"); // pending: no disposition
    expect(text).toContain("Rejected corrections");
    expect(text).toContain("this was a duplicate, not rework"); // rejected stays visible without a second filing
    expect(text).toContain("Material risk");
    expect(text).toContain("Launch");
    expect(text).toContain("72"); // the overview's latest score for Launch
    expect(text).toContain("withheld — O3 alone would supply 82%"); // Baseline's withheld score, in words
    expect(container.querySelector('[data-testid="founder-exceptions-failed"]')?.textContent).toContain("1 of 2 cards could not be loaded");
    expect(text).toContain("E4 self-review"); // immediate exception from the card that did load
    expect(text).not.toContain("None on the latest cards");
    // nothing operating: no agent rows, no ranking
    expect(text).not.toContain("Builder");
  });
});
