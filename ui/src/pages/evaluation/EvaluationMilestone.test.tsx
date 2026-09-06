// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationOverview, ScoredCard } from "@paperclipai/shared";
import type React from "react";
import { EvaluationMilestone } from "./EvaluationMilestone";

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
    { actorKey: "agent:b", actorType: "agent", actorId: "b", name: "Builder", metrics: { P1: metric("P1", { name: "Autonomy", unit: "share of items with zero interventions", detail: { interventions: 2 } }), P8: metric("P8", { name: "Token and cost efficiency", unit: "cents per accepted item", value: 45.5, displayOnly: true, detail: { runs: 34, metered: 3, totalCents: 1234, medianRunCents: 400 } }) }, composite: { ...composite(55), kind: "operating" } },
    { actorKey: "agent:t", actorType: "agent", actorId: "t", name: "Tester", metrics: { P1: metric("P1", { name: "Autonomy", unit: "share of items with zero interventions", detail: { interventions: 0 } }) }, composite: { ...composite(91), kind: "operating" } },
    { actorKey: "agent:z", actorType: "agent", actorId: "z", name: "Zed", metrics: { P1: metric("P1", { name: "Autonomy" }), P9: metric("P9", { name: "Duplicate and rework rate", unit: "duplicates and rework per delivered item", value: 0.4, lowerIsBetter: true }) }, composite: { ...composite(null, ["fewer than 3 metrics have evidence"]), kind: "operating" } },
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

describe("EvaluationMilestone", () => {
  it("scorecard: the composite with its guard and included weights, and every metric opens to its formula, breakdown and events", async () => {
    render(`/evaluation/project/${MILESTONE}`, <EvaluationMilestone />);
    await flush();
    let text = container.textContent ?? "";
    expect(text).toContain("Launch");
    expect(text).toContain("68"); // outcome score
    expect(text).toContain("adequate evidence");
    expect(text).toContain("Acceptance satisfied (weight 0.4 × coverage 100% = 0.4, value 75)"); // names in prose, keys only in the Key column
    expect(text).toContain("Deadline adherence — insufficient evidence: no target date");
    expect(text).toContain("satisfied 3 of 4 done; 1 failed");
    expect(text).toContain("open milestone — denominators still moving");
    expect(text).toContain("CI evidence: no structured regression gates");
    expect(container.querySelector('[data-testid="formula-O1"]')).toBeNull(); // formula appears on demand
    const row = container.querySelector('[data-testid="metric-O1"]') as HTMLButtonElement;
    await act(async () => { row.click(); });
    text = container.textContent ?? "";
    expect(text).toContain("Done items whose every applicable contract criterion has a satisfied disposition");
    expect(text).toContain("Implementation metrics/2");
    expect(text).toContain("2 events:");
    // an event id opens the ledger event
    const chip = container.querySelector('[data-testid="formula-O1"]')!.parentElement!.querySelector("button[title^='aaaaaaaa']") as HTMLButtonElement;
    await act(async () => { chip.click(); });
    await flush();
    expect(eventMock).toHaveBeenCalledWith("company-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1");
  });

  it("operating: agents by name (never by score), each composite with its formula sentence and weights; a withheld one says why; the company row is named in words", async () => {
    render(`/evaluation/project/${MILESTONE}/operating`, <EvaluationMilestone />);
    await flush();
    const text = container.textContent ?? "";
    expect(container.querySelector('[data-testid="not-a-ranking"]')?.textContent).toContain("this is not a ranking");
    const order = [...container.querySelectorAll('[data-testid^="actor-agent:"]')].map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["actor-agent:b", "actor-agent:t", "actor-agent:z"]); // Tester scores 91 and still comes after Builder: alphabetical, not by score
    expect(text).toContain("55");
    expect(text).toContain("91");
    expect(text).toContain("withheld — fewer than 3 metrics have evidence");
    expect(text).toContain("Coverage-weighted mean of the included operating metrics");
    expect(text).toContain("Composite composite/5");
    expect(text).toContain("Included: Acceptance satisfied (weight 0.4 × coverage 100% = 0.4, value 75)");
    expect(text).toContain("Owed by the company or the platform");
    expect(text).toContain("Company and platform"); // the server sends no name for the company row
    expect(text).not.toContain("company:c");
    expect(text).toContain("no operating score");
    // a display-only metric keeps its value beside a not-scored badge, and its detail is shown on demand
    const show = [...container.querySelectorAll('[data-testid="actor-agent:b"] button')].find((b) => /Show \d+ metrics/.test(b.textContent ?? "")) as HTMLButtonElement;
    await act(async () => { show.click(); });
    expect(container.textContent).toContain("$0.46 per accepted item"); // currency renders in dollars, never as a percentage
    expect(container.textContent).toContain("not scored");
    const p8 = container.querySelector('[data-testid="metric-P8"]') as HTMLButtonElement;
    await act(async () => { p8.click(); });
    expect(container.querySelector('[data-testid="detail-P8"]')?.textContent).toContain("median run cents");
    // P9 is an index, never a percentage, and says lower is better
    const showZ = [...container.querySelectorAll('[data-testid="actor-agent:z"] button')].find((b) => /Show \d+ metrics/.test(b.textContent ?? "")) as HTMLButtonElement;
    await act(async () => { showZ.click(); });
    const p9 = container.querySelector('[data-testid="metric-P9"]')?.textContent ?? "";
    expect(p9).toBeTruthy();
    expect(p9).toContain("0.4 duplicates and rework per delivered item");
    expect(p9).toContain("lower is better");
    expect(p9).not.toContain("40%");
  });

  it("ledger: the events listed are the rows tagged with this milestone through the card's cut, newest first — never the whole company", async () => {
    eventsMock.mockResolvedValue({ events: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", seq: 40, companyId: "company-1", projectId: MILESTONE, goalId: null, actorType: "agent", actorId: "b", sourceTable: "issues", sourceId: "x", sourceVersion: "v", eventType: "issue.created", eventTime: "2026-09-02T00:00:00.000Z", ingestTime: "2026-09-02T00:00:01.000Z", payload: {}, correlationId: null }], count: 1, scope: { kind: "project", id: MILESTONE, throughSeq: 42 } });
    render(`/evaluation/project/${MILESTONE}/ledger`, <EvaluationMilestone />);
    await flush();
    expect(eventsMock).toHaveBeenCalledWith("company-1", expect.objectContaining({ ref: { kind: "project", id: MILESTONE }, throughSeq: 42, order: "desc" }));
    const text = container.textContent ?? "";
    expect(text).toContain("1 event tagged with this project through sequence 42, newest first");
    expect(text).toContain("company-level records");
    expect(text).not.toContain("40 events in this card's window");
  });

  it("a card stored before the scoring engine is said to be one, and no tab pretends to score it", async () => {
    latestMock.mockResolvedValue({ latest: { id: "s0", companyId: "company-1", milestoneKind: "project", milestoneId: MILESTONE, version: 1, contractVersion: "none", formulaVersion: "m1-digest/3", throughSeq: 9, throughEventId: null, card: { formulaVersion: "m1-digest/3", milestoneRef: { kind: "project", id: MILESTONE }, milestoneName: "Launch", throughSeq: 9, eventCount: 9, byType: {}, actors: ["agent:b"], markers: [], state: { open: true, retrospective: false } }, cardHash: "h".repeat(64), createdAt: "2026-09-01T00:00:00.000Z" }, verify: null });
    render(`/evaluation/project/${MILESTONE}/exceptions`, <EvaluationMilestone />);
    await flush();
    expect(container.querySelector('[data-testid="unscored-card"]')?.textContent).toContain("predates the scoring engine");
    expect(container.textContent).toContain("Store a new version and raise review items"); // the way out is offered where the message is
    expect(container.textContent).not.toMatch(/\b(68|72|91)\b/);
  });

  it("exceptions: grouped by severity with subject, note, routes and the events behind each", async () => {
    render(`/evaluation/project/${MILESTONE}/exceptions`, <EvaluationMilestone />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("E4 self-review");
    expect(text).toContain("PAP-7");
    expect(text).toContain("the contributor reviewed their own work");
    expect(text).toContain("routed to: the founder's view, the manager");
    expect(container.querySelector('[data-testid="exception-E4:issue:x"] button[title^="aaaaaaaa"]')).not.toBeNull();
  });

  it("without a stored card the page says so and offers an administrator a snapshot that names its side effect, never a number", async () => {
    latestMock.mockResolvedValue({ latest: null, verify: null });
    render(`/evaluation/project/${MILESTONE}`, <EvaluationMilestone />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("No card stored for this milestone yet");
    expect(text).toContain("Store a card and raise its review items");
    expect(text).toContain("the one write this page offers");
    expect(text).not.toMatch(/\b(68|72)\b/);
  });

  it("scorecard: a withheld outcome composite is the words for why, and the included weights show the coverage multiplication", async () => {
    latestMock.mockResolvedValue({ latest: { id: "s2", companyId: "company-1", milestoneKind: "project", milestoneId: MILESTONE, version: 2, contractVersion: "derived/1", formulaVersion: "m2-score/5", throughSeq: 41, throughEventId: null, card: { ...card, outcomeComposite: composite(null, ["Downstream risk index alone would supply 82% of the score; no single metric may supply more than 75%", "the included metrics rest on 47% of the decidable records; at least 50% is needed"]) }, cardHash: "h".repeat(64), createdAt: "2026-09-05T00:00:00.000Z" }, verify: null });
    render(`/evaluation/project/${MILESTONE}`, <EvaluationMilestone />);
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("withheld — Downstream risk index alone would supply 82% of the score");
    expect(container.querySelector('[data-testid="guard-reasons"]')?.textContent).toContain("at least 50% is needed");
    expect(text).not.toMatch(/Outcome score\s*\d/);
  });
});
