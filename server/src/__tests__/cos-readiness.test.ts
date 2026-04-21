// AgentDash (AGE-50 Phase 1): tests for the CoS readiness precondition.

import { describe, it, expect, vi } from "vitest";
import { cosReadinessService } from "../services/cos-readiness.js";

type Row = { id: string; adapterType: string | null; status: string };

function makeDb(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.then = (onFulfilled: (v: Row[]) => unknown) => Promise.resolve(onFulfilled(rows));
  return { select: vi.fn().mockReturnValue(chain) };
}

describe("cosReadinessService.check", () => {
  it("reports ready when a Chief of Staff with a real adapter exists", async () => {
    const db = makeDb([
      { id: "cos-1", adapterType: "claude_api", status: "active" },
    ]);
    const result = await cosReadinessService(db as any).check("co-1");
    expect(result).toEqual({
      ready: true,
      hasChiefOfStaff: true,
      hasLlmAdapter: true,
      reasons: [],
      chiefOfStaffAgentId: "cos-1",
    });
  });

  it("reports not ready when no Chief of Staff exists at all", async () => {
    const db = makeDb([]);
    const result = await cosReadinessService(db as any).check("co-1");
    expect(result.ready).toBe(false);
    expect(result.hasChiefOfStaff).toBe(false);
    expect(result.hasLlmAdapter).toBe(false);
    expect(result.reasons[0]).toMatch(/No active Chief of Staff/);
  });

  it("reports not ready when CoS exists but is in a gated status", async () => {
    const db = makeDb([
      { id: "cos-1", adapterType: "claude_api", status: "paused" },
    ]);
    const result = await cosReadinessService(db as any).check("co-1");
    expect(result.ready).toBe(false);
    expect(result.hasChiefOfStaff).toBe(false);
  });

  it("treats idle and running CoS as ready alongside active", async () => {
    for (const status of ["idle", "running", "active"]) {
      const db = makeDb([{ id: "cos-1", adapterType: "claude_api", status }]);
      const result = await cosReadinessService(db as any).check("co-1");
      expect(result.ready, `status=${status}`).toBe(true);
    }
  });

  it("reports not ready when CoS exists but has placeholder adapter", async () => {
    const db = makeDb([
      { id: "cos-1", adapterType: "process", status: "active" },
    ]);
    const result = await cosReadinessService(db as any).check("co-1");
    expect(result.ready).toBe(false);
    expect(result.hasChiefOfStaff).toBe(true);
    expect(result.hasLlmAdapter).toBe(false);
    expect(result.reasons[0]).toMatch(/runtime adapter/);
    expect(result.chiefOfStaffAgentId).toBe("cos-1");
  });

  it("prefers a CoS with a real adapter over one with placeholder", async () => {
    const db = makeDb([
      { id: "cos-placeholder", adapterType: "process", status: "active" },
      { id: "cos-real", adapterType: "claude_local", status: "active" },
    ]);
    const result = await cosReadinessService(db as any).check("co-1");
    expect(result.ready).toBe(true);
    expect(result.chiefOfStaffAgentId).toBe("cos-real");
  });
});
