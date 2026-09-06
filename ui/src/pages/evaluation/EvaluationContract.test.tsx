// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScoredCard } from "@paperclipai/shared";
import scoredCard from "./__fixtures__/scored-card.json";
import { EvaluationMilestone } from "./EvaluationMilestone";

// The card here is a real one, scored by the server from its fixture window
// and kept byte-identical by server/src/__tests__/evaluation-card-contract.test.ts.
// Rendering it proves the pages read the shape the engine actually writes.

const latestMock = vi.hoisted(() => vi.fn());
const eventMock = vi.hoisted(() => vi.fn());
vi.mock("@/api/evaluation", () => ({
  evaluationApi: {
    overview: vi.fn(),
    latest: (companyId: string, ref: unknown, verify?: boolean) => latestMock(companyId, ref, verify),
    versions: vi.fn().mockResolvedValue({ versions: [] }),
    events: vi.fn().mockResolvedValue({ events: [], count: 0, scope: null }),
    event: (companyId: string, id: string) => eventMock(companyId, id),
    replay: vi.fn(),
    snapshot: vi.fn(),
  },
}));
vi.mock("@/api/access", () => ({ accessApi: { listMembers: async () => ({ members: [], access: { currentUserRole: "member" } }) } }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: async () => [] } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" } }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/components/PageTabBar", () => ({ PageTabBar: () => <div /> }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const card = scoredCard as unknown as ScoredCard;
const ref = card.milestoneRef;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  latestMock.mockReset().mockResolvedValue({ latest: { id: "s1", companyId: "company-1", milestoneKind: ref.kind, milestoneId: ref.id, version: 1, contractVersion: card.contract.contractVersion, formulaVersion: card.formulaVersion, throughSeq: card.throughSeq, throughEventId: card.throughEventId, card, cardHash: "h".repeat(64), createdAt: "2026-09-05T12:00:00.000Z" }, verify: null });
  eventMock.mockReset().mockResolvedValue({ event: { id: "e1", seq: 1, companyId: "company-1", projectId: null, goalId: null, actorType: "agent", actorId: "a", sourceTable: "issues", sourceId: "x", sourceVersion: "v", eventType: "issue.created", eventTime: "2026-08-01T10:00:00.000Z", ingestTime: "2026-08-01T10:01:00.000Z", payload: {}, correlationId: null } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/evaluation/:kind/:id" element={<EvaluationMilestone />} />
            <Route path="/evaluation/:kind/:id/:tab" element={<EvaluationMilestone />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe("a real scored card renders on every tab", () => {
  it("scorecard: every outcome metric on the card has a row that opens to a formula and its evidence count", async () => {
    render(`/evaluation/${ref.kind}/${ref.id}`);
    await flush();
    expect(container.textContent).toContain(card.milestoneName ?? "");
    for (const m of Object.values(card.outcome)) {
      if (!m) continue;
      const row = container.querySelector(`[data-testid="metric-${m.key}"]`) as HTMLButtonElement | null;
      expect(row, m.key).not.toBeNull();
      await act(async () => { row!.click(); });
      expect(container.querySelector(`[data-testid="formula-${m.key}"]`)?.textContent, m.key).toContain(`Implementation ${m.formulaVersion}`);
      const evidence = m.evidenceRefCount ?? m.evidenceRefs.length;
      expect(container.textContent, m.key).toContain(evidence === 0 ? "no events cited" : `${evidence} ${evidence === 1 ? "event" : "events"}:`);
    }
    // the composite is either a number with confidence or the words for why not — never a bare null
    const c = card.outcomeComposite;
    if (c.score == null) expect(container.textContent).toContain("withheld");
    else expect(container.textContent).toContain(String(Math.round(c.score)));
  });

  it("operating: every actor the card carries renders, with no raw actor keys", async () => {
    render(`/evaluation/${ref.kind}/${ref.id}/operating`);
    await flush();
    for (const a of card.actors) expect(container.querySelector(`[data-testid="actor-${a.actorKey}"]`), a.actorKey).not.toBeNull();
    expect(container.textContent).not.toMatch(/company:[0-9a-f-]{8}/);
    expect(container.textContent).toContain("Company and platform");
    // the company row reuses agent keys for different metrics: its P2 is a count with its own name, never a percentage
    const companyRow = card.actors.find((a) => a.actorType === "company")!;
    const show = [...container.querySelectorAll(`[data-testid="actor-${companyRow.actorKey}"] button`)].find((b) => /Show \d+ metrics/.test(b.textContent ?? "")) as HTMLButtonElement;
    await act(async () => { show.click(); });
    const p2Row = container.querySelector(`[data-testid="actor-${companyRow.actorKey}"] [data-testid="metric-P2"]`)!;
    expect(p2Row.textContent).toContain("Questions owed by the company");
    const p2Value = p2Row.querySelector(".tabular-nums")?.textContent ?? "";
    expect(p2Value).toContain(`${companyRow.metrics.P2!.value} questions unanswered past 48 h`);
    expect(p2Value).not.toMatch(/%/); // a count, never a percentage — the coverage column is the only percent on the row
    // and every metric on every row declares its kind
    for (const a of card.actors) for (const m of Object.values(a.metrics)) expect(m?.valueKind, `${a.actorKey} ${m?.key}`).toBeTruthy();
  });

  it("exceptions: every exception the card carries renders under its severity", async () => {
    render(`/evaluation/${ref.kind}/${ref.id}/exceptions`);
    await flush();
    expect(card.exceptions.length).toBeGreaterThan(0); // the fixture window carries a refusal and a human reopen
    for (const e of card.exceptions) expect(container.querySelector(`[data-testid="exception-${e.key}"]`), e.key).not.toBeNull();
  });
});
