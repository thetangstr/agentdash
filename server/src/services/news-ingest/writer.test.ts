import { describe, it, expect, vi } from "vitest";
import { recordEvent } from "./writer.js";

function fakeDb(insertedRows: unknown[]) {
  return {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => insertedRows,
        }),
      }),
    }),
  } as never;
}

describe("recordEvent", () => {
  const base = {
    companyId: "c1", agentId: "a1", beat: "armed-conflict", clockchainTool: "attest_action",
    item: { title: "T", link: "https://ex.com/a", summary: "s", publishedAt: new Date(), outlet: "BBC" },
    extracted: { entities: ["X"], geo: {}, confidence: 0.8, inflection: {} },
    receipt: { ledgerId: "l1", blockHeight: "5", clockchainTime: "t" },
  };
  it("logs activity authored by the agent when a row is inserted", async () => {
    const log = vi.fn().mockResolvedValue(undefined);
    const res = await recordEvent(fakeDb([{ id: "e1" }]) , base, { logActivity: log });
    expect(res.inserted).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    const arg = log.mock.calls[0][1];
    expect(arg.actorType).toBe("agent");
    expect(arg.actorId).toBe("a1");
    expect(arg.agentId).toBe("a1");
    expect(arg.action).toBe("news.event.logged");
    expect(arg.entityType).toBe("news_event");
  });
  it("does not log activity on duplicate (no row returned)", async () => {
    const log = vi.fn();
    const res = await recordEvent(fakeDb([]), base, { logActivity: log });
    expect(res.inserted).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });
});
