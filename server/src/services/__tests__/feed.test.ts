// AgentDash: Feed service tests
// Unions across approvals + event tables. Mocks Db so we don't need a real
// Postgres instance.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Mock Db builder — returns canned row arrays per "select/from" pair
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/**
 * Builds a mock Db whose select/from/where/orderBy/limit chain resolves to
 * the rows bucketed by table reference identity.
 *
 * Usage: makeMockDb(new Map([[approvals, [row1, row2]], [costEvents, []]]))
 */
function makeMockDb(tableRows: Map<unknown, Row[]>) {
  return {
    select: vi.fn().mockImplementation((_projection?: unknown) => {
      const chain: Record<string, unknown> = {};
      let currentTable: unknown = null;
      const resolve = (onFulfilled?: (v: Row[]) => unknown) => {
        const rows = tableRows.get(currentTable) ?? [];
        return onFulfilled ? Promise.resolve(onFulfilled(rows)) : Promise.resolve(rows);
      };
      chain.from = vi.fn().mockImplementation((t: unknown) => {
        currentTable = t;
        return chain;
      });
      chain.where = vi.fn().mockReturnValue(chain);
      chain.orderBy = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation(() => ({
        then: (onFulfilled: (v: Row[]) => unknown) => resolve(onFulfilled),
      }));
      chain.then = (onFulfilled: (v: Row[]) => unknown) => resolve(onFulfilled);
      return chain;
    }),
  } as unknown as import("@agentdash/db").Db;
}

// ---------------------------------------------------------------------------
// Source-inspection tests (prevent silent removal of sources)
// ---------------------------------------------------------------------------

describe("feedService source structure", () => {
  const src = readFileSync(join(__dirname, "../feed.ts"), "utf-8");

  it("aggregates approvals table", () => {
    expect(src).toContain("approvals");
  });
  it("aggregates cost_events table", () => {
    expect(src).toContain("costEvents");
  });
  it("aggregates finance_events table", () => {
    expect(src).toContain("financeEvents");
  });
  it("aggregates kill_switch_events table", () => {
    expect(src).toContain("killSwitchEvents");
  });
  it("aggregates skill_usage_events table", () => {
    expect(src).toContain("skillUsageEvents");
  });
  it("aggregates heartbeat_run_events table", () => {
    expect(src).toContain("heartbeatRunEvents");
  });
  it("uses desc() for DESC sort", () => {
    expect(src).toContain("desc");
  });
  it("exposes nextCursor in return", () => {
    expect(src).toContain("nextCursor");
  });
  it("decodes base64 cursor", () => {
    expect(src).toContain("atob");
  });
  it("encodes cursor as base64", () => {
    expect(src).toContain("btoa");
  });
  it("enforces a max limit of 200", () => {
    expect(src).toContain("200");
  });
});

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe("feedService module exports", () => {
  it("exports a feedService function", async () => {
    const mod = await import("../feed.js");
    expect(typeof mod.feedService).toBe("function");
  });

  it("feedService returns an object with a list method", async () => {
    const { feedService } = await import("../feed.js");
    const mockDb = makeMockDb(new Map());
    const svc = feedService(mockDb);
    expect(typeof svc.list).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Behavioral tests
// ---------------------------------------------------------------------------

describe("feedService.list", () => {
  it("unions events from at least 2 source tables", async () => {
    const { feedService } = await import("../feed.js");
    const { approvals, costEvents } = await import("@agentdash/db");

    const mockDb = makeMockDb(
      new Map<unknown, Row[]>([
        [
          approvals,
          [
            {
              id: "ap-1",
              companyId: "co-1",
              type: "tool_call",
              status: "approved",
              requestedByAgentId: "agent-1",
              decidedByUserId: "user-1",
              decisionNote: null,
              payload: { foo: "bar" },
              createdAt: new Date("2024-01-02T00:00:00Z"),
              updatedAt: new Date("2024-01-02T00:00:00Z"),
              decidedAt: new Date("2024-01-02T00:00:00Z"),
            },
          ],
        ],
        [
          costEvents,
          [
            {
              id: "ce-1",
              companyId: "co-1",
              agentId: "agent-1",
              provider: "anthropic",
              model: "claude-3",
              costCents: 42,
              occurredAt: new Date("2024-01-03T00:00:00Z"),
              createdAt: new Date("2024-01-03T00:00:00Z"),
            },
          ],
        ],
      ]),
    );

    const svc = feedService(mockDb);
    const res = await svc.list("co-1");
    const types = new Set(res.events.map((e) => e.type));
    expect(types.has("approval_decision")).toBe(true);
    expect(types.has("cost_event")).toBe(true);
    expect(res.events.length).toBeGreaterThanOrEqual(2);
  });

  it("sorts events by `at` descending", async () => {
    const { feedService } = await import("../feed.js");
    const { approvals, costEvents, killSwitchEvents } = await import("@agentdash/db");

    const older = new Date("2024-01-01T00:00:00Z");
    const middle = new Date("2024-01-05T00:00:00Z");
    const newer = new Date("2024-01-10T00:00:00Z");

    const mockDb = makeMockDb(
      new Map<unknown, Row[]>([
        [
          approvals,
          [
            {
              id: "ap-older",
              companyId: "co-1",
              type: "tool_call",
              status: "approved",
              requestedByAgentId: null,
              decidedByUserId: null,
              decisionNote: null,
              payload: {},
              createdAt: older,
              updatedAt: older,
              decidedAt: older,
            },
          ],
        ],
        [
          costEvents,
          [
            {
              id: "ce-middle",
              companyId: "co-1",
              agentId: "agent-1",
              provider: "openai",
              model: "gpt-4",
              costCents: 10,
              occurredAt: middle,
              createdAt: middle,
            },
          ],
        ],
        [
          killSwitchEvents,
          [
            {
              id: "ks-newer",
              companyId: "co-1",
              scope: "company",
              scopeId: "co-1",
              action: "pause",
              reason: null,
              triggeredByUserId: "user-1",
              triggeredAt: newer,
            },
          ],
        ],
      ]),
    );

    const svc = feedService(mockDb);
    const res = await svc.list("co-1");
    const times = res.events.map((e) => e.at.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
    expect(res.events[0].id).toBe("ks-newer");
    expect(res.events[res.events.length - 1].id).toBe("ap-older");
  });

  it("paginates with base64 cursor across pages", async () => {
    const { feedService } = await import("../feed.js");
    const { approvals, costEvents } = await import("@agentdash/db");

    const rows: Row[] = [];
    for (let i = 0; i < 5; i++) {
      rows.push({
        id: `ap-${i}`,
        companyId: "co-1",
        type: "tool_call",
        status: "approved",
        requestedByAgentId: null,
        decidedByUserId: null,
        decisionNote: null,
        payload: {},
        createdAt: new Date(Date.UTC(2024, 0, 10 - i)),
        updatedAt: new Date(Date.UTC(2024, 0, 10 - i)),
        decidedAt: new Date(Date.UTC(2024, 0, 10 - i)),
      });
    }

    const mockDb = makeMockDb(
      new Map<unknown, Row[]>([
        [approvals, rows],
        [costEvents, []],
      ]),
    );

    const svc = feedService(mockDb);
    const page1 = await svc.list("co-1", { limit: 2 });
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.events[0].id).toBe("ap-0"); // newest (Jan 10)

    // Cursor structure: base64("at|id")
    const decoded = Buffer.from(page1.nextCursor!, "base64").toString("utf-8");
    expect(decoded).toContain("|");

    const page2 = await svc.list("co-1", { limit: 2, cursor: page1.nextCursor });
    expect(page2.events.length).toBeGreaterThan(0);
    const lastOfPage1 = page1.events[page1.events.length - 1];
    expect(page2.events[0].at.getTime()).toBeLessThanOrEqual(lastOfPage1.at.getTime());
    expect(page2.events.map((e) => e.id)).not.toContain(page1.events[0].id);
  });

  it("handles an empty feed without throwing and returns null cursor", async () => {
    const { feedService } = await import("../feed.js");
    const { approvals, costEvents } = await import("@agentdash/db");

    const mockDb = makeMockDb(
      new Map<unknown, Row[]>([
        [approvals, []],
        [costEvents, []],
      ]),
    );

    const svc = feedService(mockDb);
    const res = await svc.list("co-1", { limit: 9999 });
    expect(res.events).toEqual([]);
    expect(res.nextCursor).toBeNull();
  });
});
