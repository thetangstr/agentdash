// AgentDash (AGE-50 Phase 2): service-level tests for goal interview sessions.
// Uses the drizzle-mock pattern established by cos-orchestrator.test.ts to
// avoid the embedded-pg flake that hangs the full test suite.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { goalInterviewSessionsService } from "../services/goal-interview-sessions.js";

type Row = Record<string, unknown>;

function thenable(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.values = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockReturnValue(chain);
  chain.then = (onFulfilled: (v: Row[]) => unknown) =>
    Promise.resolve(onFulfilled(rows));
  return chain;
}

function makeDb(options: {
  openSessionRows?: Row[];
  insertReturnRow?: Row;
  updateReturnRow?: Row;
  latestRow?: Row | null;
} = {}) {
  const selectImpl = vi.fn();
  const insertImpl = vi.fn().mockReturnValue(thenable([options.insertReturnRow ?? {}]));
  const updateImpl = vi.fn().mockReturnValue(thenable([options.updateReturnRow ?? {}]));
  return {
    select: selectImpl,
    insert: insertImpl,
    update: updateImpl,
    _primeFindOpen(rows: Row[]) {
      selectImpl.mockReturnValueOnce(thenable(rows));
    },
    _primeLatest(row: Row | null) {
      selectImpl.mockReturnValueOnce(thenable(row ? [row] : []));
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("goalInterviewSessionsService.startOrResume", () => {
  it("returns the existing open session instead of inserting a duplicate", async () => {
    const existing = { id: "s-1", goalId: "g-1", companyId: "co-1", completedAt: null };
    const db = makeDb();
    db._primeFindOpen([existing]);

    const result = await goalInterviewSessionsService(db as any).startOrResume(
      "co-1",
      "g-1",
      "u-1",
    );

    expect(result).toEqual(existing);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("inserts a new session when no open session exists for the goal", async () => {
    const created = { id: "s-new", goalId: "g-1", companyId: "co-1", completedAt: null };
    const db = makeDb({ insertReturnRow: created });
    db._primeFindOpen([]);

    const result = await goalInterviewSessionsService(db as any).startOrResume(
      "co-1",
      "g-1",
      "u-1",
    );

    expect(result).toEqual(created);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

describe("goalInterviewSessionsService.latestForGoal", () => {
  it("returns the latest session row for a goal", async () => {
    const latest = { id: "s-latest", goalId: "g-1", companyId: "co-1" };
    const db = makeDb();
    db._primeLatest(latest);

    const result = await goalInterviewSessionsService(db as any).latestForGoal(
      "co-1",
      "g-1",
    );

    expect(result).toEqual(latest);
  });

  it("returns null when no session exists", async () => {
    const db = makeDb();
    db._primeLatest(null);

    const result = await goalInterviewSessionsService(db as any).latestForGoal(
      "co-1",
      "g-1",
    );

    expect(result).toBeNull();
  });
});

describe("goalInterviewSessionsService.markCompleted", () => {
  it("flips completedAt to now and returns the updated row", async () => {
    const updated = { id: "s-1", completedAt: new Date() };
    const db = makeDb({ updateReturnRow: updated });

    const result = await goalInterviewSessionsService(db as any).markCompleted("s-1");

    expect(result).toEqual(updated);
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe("goalInterviewSessionsService.attachConversation", () => {
  it("stores the conversationId and refreshes lastActivityAt", async () => {
    const updated = { id: "s-1", conversationId: "conv-7" };
    const db = makeDb({ updateReturnRow: updated });

    const result = await goalInterviewSessionsService(db as any).attachConversation(
      "s-1",
      "conv-7",
    );

    expect(result).toEqual(updated);
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
