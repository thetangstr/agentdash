// AgentDash (AGE-50 Phase 1): tests for the CoS readiness precondition.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cosReadinessService } from "../services/cos-readiness.js";
import { __resetOmcDetectionCache } from "../services/omc-detection.js";

// AgentDash (AGE-50 Phase 4a): readiness now also reports OMC state.
// We mock `detectOmc` so these tests don't depend on the test host's
// actual ~/.claude filesystem.
vi.mock("../services/omc-detection.js", async () => {
  const actual = await vi.importActual<typeof import("../services/omc-detection.js")>(
    "../services/omc-detection.js",
  );
  return {
    ...actual,
    detectOmc: vi.fn().mockResolvedValue({ installed: true, path: "/mock/omc", checkedPaths: ["/mock/omc"] }),
  };
});

beforeEach(() => {
  __resetOmcDetectionCache();
});

type Row = { id: string; adapterType: string | null; status: string };

function makeDb(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.then = (onFulfilled: (v: Row[]) => unknown) => Promise.resolve(onFulfilled(rows));
  return { select: vi.fn().mockReturnValue(chain) };
}

describe("cosReadinessService.check", () => {
  it("reports ready when a Chief of Staff with a real adapter exists and OMC is installed", async () => {
    const db = makeDb([
      { id: "cos-1", adapterType: "claude_api", status: "active" },
    ]);
    const result = await cosReadinessService(db as any).check("co-1");
    expect(result).toEqual({
      ready: true,
      hasChiefOfStaff: true,
      hasLlmAdapter: true,
      hasOmc: true,
      reasons: [],
      chiefOfStaffAgentId: "cos-1",
    });
  });

  it("appends a soft warning reason when OMC is missing but does not gate readiness", async () => {
    const omcModule = await import("../services/omc-detection.js");
    vi.mocked(omcModule.detectOmc).mockResolvedValueOnce({
      installed: false,
      path: null,
      checkedPaths: ["/nope"],
    });
    const db = makeDb([
      { id: "cos-1", adapterType: "claude_api", status: "active" },
    ]);
    const result = await cosReadinessService(db as any).check("co-1");
    expect(result.ready).toBe(true);
    expect(result.hasOmc).toBe(false);
    expect(result.reasons).toEqual([
      expect.stringMatching(/oh-my-claudecode is not installed/),
    ]);
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
