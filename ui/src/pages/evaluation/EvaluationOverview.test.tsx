// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationOverview, ScoredCard } from "@paperclipai/shared";
import type React from "react";
import { EvaluationOverviewPage as OverviewPage } from "./EvaluationOverview";

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
    valueKind: ({ O1: "share", O2: "share", O3: "index", O4: "status", O5: "share", P1: "share", P2: "share", P3: "share", P4: "share", P5: "duration", P6: "count", P7: "duration", P8: "currency", P9: "index" } as Record<string, string>)[key],
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
    { actorKey: "agent:b", actorType: "agent", actorId: "b", name: "Builder", metrics: { P1: metric("P1", { name: "Autonomy", unit: "share of items with zero interventions", detail: { interventions: 2 } }) }, composite: { ...composite(55), kind: "operating" } },
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
        outcome: { score: null, confidence: null, coverage: 0.47, reason: "Downstream risk index alone would supply 82% of the score; no single metric may supply more than 75%" },
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

describe("EvaluationOverview", () => {
  it("shows each milestone's latest card: score with confidence and coverage, the withheld reason in words, exceptions, interventions and cost", async () => {
    render("/evaluation", <OverviewPage />);
    await flush();
    const text = container.textContent ?? "";
    expect(overviewMock).toHaveBeenCalledWith("company-1");
    expect(text).toContain("Launch");
    expect(text).toContain("The evaluator's read-only reviewer is set up.");
    expect(text).not.toContain("implementation m2-score"); // engine versions live on the versions tab, not the dashboard
    expect(text).toContain("72"); // 72.4 rounded, never a decimal the reader has to interpret
    expect(text).toContain("adequate evidence");
    expect(text).toContain("coverage 68%");
    expect(text).toContain("1 immediate · 0 material · 2 routine");
    expect(text).toContain("$12.34");
    expect(text).toContain("metered on 3 of 34 runs — the rest is unmetered, not free"); // a bare figure would misstate the milestone's cost
    expect(text).toContain("across 4 agent-owned items that reached review or done · synthetic human identities: interventions are countable, not attributable");
    expect(text).toContain("withheld — Downstream risk index alone would supply 82% of the score");
    expect(text).toContain("not on this card"); // interventions and cost absent on the baseline card are said, not zeroed
    expect(text).toContain("Without a card yet");
    expect(text).toContain("Revenue");
    // the trend is drawn, and its title names every version
    const svg = container.querySelector(`[data-testid="milestone-${MILESTONE}"] svg`);
    expect(svg?.getAttribute("aria-label")).toContain("v2: withheld");
    expect(container.querySelector(`[data-testid="milestone-${MILESTONE}"] a[href*="${MILESTONE}"]`)).not.toBeNull();
  });
});
