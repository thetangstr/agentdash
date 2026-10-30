// @vitest-environment jsdom
//
// Agent Performance Management gate 4 (P4.2): the performance manager's own
// record, reached from its agent page. Proposals filed, waiting, approved,
// rejected, withdrawn, edited by a person before the decision and applied
// (each out of those filed); recommendations by kind with their decisions;
// and for each applied proposal the affected responsibilities' card sections
// before and after, side by side. Descriptive only: no causal claim, no
// score or ranking, unknown is "Unknown" and a hidden section says so.

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PerformanceManagerRecord, PerformanceManagerSectionSnapshot } from "@paperclipai/shared";
import { ApiError } from "../../api/client";

const mockManagerApi = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock("../../api/performance-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/performance-manager")>();
  return { ...actual, performanceManagerApi: mockManagerApi };
});
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const { PerformanceManagerRecordView, RECORD_DESCRIPTIVE_TEXT } = await import("./PerformanceManagerRecordView");
const { PERFORMANCE_MANAGER_ADVISORY_TEXT } = await import("./manager-shared");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER_NOTE =
  "Descriptive only: for each applied change, the affected responsibilities' card sections from the last stored card before it was applied and the first stored after are shown side by side. This does not say the change caused any difference, and there is no score.";

function snapshot(version: number, overrides: Partial<PerformanceManagerSectionSnapshot> = {}): PerformanceManagerSectionSnapshot {
  return {
    cardVersion: version,
    storedAt: "2026-10-20T09:00:00.000Z",
    obligations: {
      visibility: "visible",
      rows: [{ profileRevisionId: "rev-a", owed: 4, byEndState: { delivered_on_time: 2, missed: 2, in_progress: 0 }, deliveredItemCount: 2 }],
    },
    quality: {
      visibility: "partial",
      criteria: [{ criterionId: "cites-sources", text: "The report cites its sources", items: 2, byJudge: { person: { pass: 1, fail: 1, unknown: 0 } } }],
    },
    delivered: { visibility: "visible", items: 2 },
    ...overrides,
  };
}

function record(overrides: Partial<PerformanceManagerRecord> = {}): PerformanceManagerRecord {
  const byKind = {
    continue: { total: 0, accepted: 0, declined: 0, undecided: 0 },
    narrow: { total: 1, accepted: 0, declined: 1, undecided: 0 },
    repair: { total: 2, accepted: 1, declined: 0, undecided: 1 },
    pause: { total: 1, accepted: 1, declined: 0, undecided: 0 },
    gather_evidence: { total: 0, accepted: 0, declined: 0, undecided: 0 },
  };
  return {
    kind: "performance_manager_record",
    companyId: "company-1",
    managerAgentId: "agent-cos",
    managerName: "Clara",
    isEffectiveManager: true,
    generatedAt: "2026-10-29T12:00:00.000Z",
    proposals: {
      filed: 3,
      pending: 1,
      approved: 1,
      rejected: 1,
      withdrawn: 0,
      editedByOwnerBeforeDeciding: 1,
      applied: 1,
      items: [
        {
          approvalId: "approval-1",
          agentId: "agent-scout",
          agentName: "Scout",
          revisionId: "rev-a",
          revisionNumber: 2,
          filedAt: "2026-10-10T09:00:00.000Z",
          approvalStatus: "approved",
          outcome: "applied",
          editedByOwnerBeforeDeciding: true,
          decidedAt: "2026-10-11T09:00:00.000Z",
          affectedResponsibilities: ["weekly-report"],
        },
        {
          approvalId: "approval-2",
          agentId: "agent-scout",
          agentName: "Scout",
          revisionId: "rev-b",
          revisionNumber: 3,
          filedAt: "2026-10-20T09:00:00.000Z",
          approvalStatus: "rejected",
          outcome: "rejected",
          editedByOwnerBeforeDeciding: false,
          decidedAt: "2026-10-21T09:00:00.000Z",
          affectedResponsibilities: [],
        },
        {
          approvalId: "approval-3",
          agentId: "agent-ivy",
          agentName: null,
          revisionId: "rev-c",
          revisionNumber: 1,
          filedAt: "2026-10-28T09:00:00.000Z",
          approvalStatus: "pending",
          outcome: "pending",
          editedByOwnerBeforeDeciding: false,
          decidedAt: null,
          affectedResponsibilities: ["triage"],
        },
      ],
    },
    recommendations: {
      total: 4,
      byKind,
      // Oldest first, as the server sends them.
      items: [
        { id: "rec-1", agentId: "agent-scout", agentName: "Scout", kind: "narrow", at: "2026-10-09T09:00:00.000Z", decision: "declined", decidedAt: "2026-10-10T09:00:00.000Z" },
        { id: "rec-2", agentId: "agent-scout", agentName: "Scout", kind: "repair", at: "2026-10-15T09:00:00.000Z", decision: "accepted", decidedAt: "2026-10-16T09:00:00.000Z" },
        { id: "rec-3", agentId: "agent-ivy", agentName: null, kind: "pause", at: "2026-10-22T09:00:00.000Z", decision: "accepted", decidedAt: "2026-10-23T09:00:00.000Z" },
        { id: "rec-4", agentId: "agent-ivy", agentName: null, kind: "repair", at: "2026-10-27T09:00:00.000Z", decision: null, decidedAt: null },
      ],
    },
    applied: [
      {
        approvalId: "approval-1",
        agentId: "agent-scout",
        agentName: "Scout",
        revisionId: "rev-a",
        appliedAt: "2026-10-12T09:00:00.000Z",
        affectedResponsibilities: ["weekly-report"],
        before: { version: 1, storedAt: "2026-10-05T09:00:00.000Z" },
        after: null,
        sections: [
          {
            responsibilityKey: "weekly-report",
            before: snapshot(1, { obligations: { visibility: "visible", rows: [{ profileRevisionId: null, owed: null, byEndState: {}, deliveredItemCount: 0 }] } }),
            after: null,
          },
        ],
      },
    ],
    restricted: true,
    note: SERVER_NOTE,
    ...overrides,
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
        <PerformanceManagerRecordView companyId="company-1" managerAgentId="agent-cos" />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

function byTestId(node: ParentNode, id: string): HTMLElement | null {
  return node.querySelector<HTMLElement>(`[data-testid='${id}']`);
}

function facts(section: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    Array.from(section.querySelectorAll("dl > div")).map((row) => [row.querySelector("dt")?.textContent ?? "", row.querySelector("dd")?.textContent ?? ""]),
  );
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("PerformanceManagerRecordView", () => {
  it("reads this agent's record and says what the role may do, with the server's descriptive note", async () => {
    mockManagerApi.record.mockResolvedValue(record());
    const node = await render();
    expect(mockManagerApi.record).toHaveBeenCalledWith("company-1", "agent-cos");
    expect(node.querySelector("h3")?.textContent).toBe("Record as performance manager: Clara");
    expect(node.textContent).toContain(PERFORMANCE_MANAGER_ADVISORY_TEXT);
    expect(byTestId(node, "pm-record-note")?.textContent).toBe(SERVER_NOTE);
    expect(byTestId(node, "pm-record-restricted")?.textContent).toContain("may be left out");
    expect(node.querySelector("a[href='/agents/agent-cos/performance']")?.textContent).toBe("Back to this agent's performance");
  });

  it("counts proposals by outcome, each out of those filed, and lists them newest first", async () => {
    mockManagerApi.record.mockResolvedValue(record());
    const node = await render();
    const section = byTestId(node, "pm-record-proposals")!;
    expect(facts(section)).toEqual({
      Filed: "3",
      "Waiting for a decision": "1 of 3",
      Approved: "1 of 3",
      Rejected: "1 of 3",
      Withdrawn: "0 of 3",
      "Edited by a person before the decision": "1 of 3",
      Applied: "1 of 3",
    });
    const items = Array.from(section.querySelectorAll<HTMLElement>("[data-testid='pm-record-proposal']"));
    expect(items.map((item) => item.textContent?.match(/Revision \d+/)?.[0])).toEqual(["Revision 1", "Revision 3", "Revision 2"]);
    expect(items[0]!.textContent).toContain("Agent agent-iv");
    expect(items[0]!.textContent).toContain("Waiting for a decision");
    expect(items[0]!.textContent).toContain("no decision yet");
    expect(items[1]!.textContent).toContain("Rejected");
    expect(items[2]!.textContent).toContain("Approved and applied");
    expect(byTestId(items[2]!, "pm-record-proposal-edited")?.textContent).toContain("A person edited the draft before it was decided");
    expect(items[2]!.querySelector("a[href='/approvals/approval-1']")).not.toBeNull();
    expect(items[2]!.querySelector("a[href='/agents/agent-scout/profile']")?.textContent).toBe("Scout");
  });

  it("tallies recommendations by kind with their decisions; pause is labelled advisory", async () => {
    mockManagerApi.record.mockResolvedValue(record());
    const node = await render();
    const section = byTestId(node, "pm-record-recommendations")!;
    const rows = facts(section);
    expect(rows["All kinds"]).toBe("4");
    expect(rows.Repair).toBe("2 filed — 1 accepted, 0 declined, 1 with no decision yet");
    expect(rows.Narrow).toBe("1 filed — 0 accepted, 1 declined, 0 with no decision yet");
    expect(rows["Pause (advisory)"]).toBe("1 filed — 1 accepted, 0 declined, 0 with no decision yet");
    expect(rows.Continue).toBe("0 filed");
    expect(section.textContent).toContain("a pause recommendation never paused anything");
  });

  it("lists each recommendation newest first: the agent it is about, its kind, when, and its decision", async () => {
    mockManagerApi.record.mockResolvedValue(record());
    const node = await render();
    const section = byTestId(node, "pm-record-recommendations")!;
    const items = Array.from(section.querySelectorAll<HTMLElement>("[data-testid='pm-record-recommendation']"));
    expect(items).toHaveLength(4);
    expect(items.map((item) => byTestId(item, "pm-record-recommendation-decision")?.textContent?.trim())).toEqual([
      "· No decision yet",
      "· Accepted",
      "· Accepted",
      "· Declined",
    ]);
    expect(items[0]!.textContent).toContain("Agent agent-iv · Repair");
    expect(items[0]!.textContent).not.toContain("decided");
    expect(items[1]!.textContent).toContain("Pause (advisory)");
    expect(items[1]!.textContent).toContain("decided");
    expect(items[3]!.querySelector("a[href='/agents/agent-scout/performance']")?.textContent).toBe("Scout");
    expect(items[3]!.textContent).toContain("Narrow");
  });

  it("shows the tallies alone when an older server sends no items", async () => {
    const base = record();
    const { items: _items, ...tallies } = base.recommendations;
    mockManagerApi.record.mockResolvedValue({ ...base, recommendations: tallies });
    const node = await render();
    const section = byTestId(node, "pm-record-recommendations")!;
    expect(facts(section)["All kinds"]).toBe("4");
    expect(section.querySelectorAll("[data-testid='pm-record-recommendation']")).toHaveLength(0);
  });

  it("sets the card sections before and after each applied proposal side by side, keeping unknown and missing honest", async () => {
    mockManagerApi.record.mockResolvedValue(record());
    const node = await render();
    const section = byTestId(node, "pm-record-applied")!;
    expect(section.textContent).toContain(RECORD_DESCRIPTIVE_TEXT);
    const applied = byTestId(section, "pm-record-applied")!;
    expect(applied.querySelector("h4")?.textContent).toContain("Scout, revision 2 — applied");
    expect(applied.textContent).toContain("Before: card version 1, stored");
    expect(applied.textContent).toContain("After: no card has been stored since it was applied");
    const before = byTestId(applied, "pm-record-before")!;
    expect(before.textContent).toContain("Card version 1, stored");
    // An owed count the card didn't record is Unknown, never 0.
    expect(before.textContent).toContain("Owed: Unknown — Not recorded");
    expect(before.textContent).toContain("No end states recorded");
    expect(before.textContent).toContain("Partly visible to you.");
    expect(before.textContent).toContain("The report cites its sources — 2 items");
    expect(before.textContent).toContain("A person: 1 passed, 1 failed, 0 unknown");
    expect(byTestId(applied, "pm-record-after")?.textContent).toContain("No card stored since it was applied.");
  });

  it("says a section is not visible, with the server's reason, instead of showing counts", async () => {
    const base = record();
    mockManagerApi.record.mockResolvedValue(
      record({
        applied: [
          {
            ...base.applied[0]!,
            after: { version: 2, storedAt: "2026-10-15T09:00:00.000Z" },
            sections: [
              {
                responsibilityKey: "weekly-report",
                before: null,
                after: snapshot(2, {
                  obligations: { visibility: "not_visible", note: "Work in a project you can't see" },
                  quality: { visibility: "not_visible", note: "Work in a project you can't see" },
                  delivered: { visibility: "not_visible", note: "Work in a project you can't see" },
                }),
              },
            ],
          },
        ],
      }),
    );
    const node = await render();
    const after = byTestId(node, "pm-record-after")!;
    expect(after.textContent).toContain("Not visible to you — Work in a project you can't see");
    expect(after.textContent).not.toMatch(/Owed:/);
    expect(byTestId(node, "pm-record-before")?.textContent).toContain("No stored card before it was applied.");
  });

  it("says so when nothing has been filed or applied", async () => {
    mockManagerApi.record.mockResolvedValue(
      record({
        isEffectiveManager: false,
        proposals: { filed: 0, pending: 0, approved: 0, rejected: 0, withdrawn: 0, editedByOwnerBeforeDeciding: 0, applied: 0, items: [] },
        recommendations: { total: 0, byKind: record().recommendations.byKind, items: [] },
        applied: [],
        restricted: false,
      }),
    );
    const node = await render();
    expect(facts(node.querySelector<HTMLElement>("section")!)["Performance manager now"]).toBe("No");
    expect(byTestId(node, "pm-record-proposals")?.textContent).toContain("It has proposed no profile changes.");
    expect(byTestId(node, "pm-record-recommendations")?.textContent).toContain("It has filed no recommendations.");
    expect(byTestId(node, "pm-record-applied")?.textContent).toContain("None of its proposals has been applied.");
    expect(byTestId(node, "pm-record-restricted")).toBeNull();
  });

  it("has no gauge, score or ranking of its own", async () => {
    mockManagerApi.record.mockResolvedValue(record());
    const node = await render();
    expect(node.querySelector("[role='meter'], [role='progressbar'], meter, progress")).toBeNull();
    const clone = node.cloneNode(true) as HTMLElement;
    clone.querySelector("[data-testid='pm-record-note']")?.remove();
    expect(clone.textContent?.toLowerCase()).not.toMatch(/\bscore\b|\brank(ing)?\b|\bgauge\b|\bcaused\b(?! it)/);
  });

  it("shows the server's refusal when the record can't be read", async () => {
    mockManagerApi.record.mockRejectedValue(
      new ApiError("The performance manager's record is read by people and by the manager itself.", 403, {
        error: "The performance manager's record is read by people and by the manager itself.",
      }),
    );
    const node = await render();
    const error = byTestId(node, "agent-pm-error")!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("Couldn't load this agent's record as performance manager.");
    expect(error.textContent).toContain("read by people and by the manager itself");
  });
});
