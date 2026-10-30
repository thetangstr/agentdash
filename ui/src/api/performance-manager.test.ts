import { beforeEach, describe, expect, it, vi } from "vitest";

// AgentDash (APM gate 4, P4.2): the performance manager calls hit the routes
// in server/src/routes/performance-manager.ts, and nothing else.

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, api: mockApi };
});

const { performanceManagerApi } = await import("./performance-manager");

describe("performanceManagerApi (APM gate 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(mockApi)) fn.mockResolvedValue({});
  });

  it("reads and sets the designation; null returns to the Chief of Staff default", async () => {
    await performanceManagerApi.get("c-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/c-1/performance-manager");
    await performanceManagerApi.set("c-1", "a-9");
    expect(mockApi.patch).toHaveBeenLastCalledWith("/companies/c-1/performance-manager", { agentId: "a-9" });
    await performanceManagerApi.set("c-1", null);
    expect(mockApi.patch).toHaveBeenLastCalledWith("/companies/c-1/performance-manager", { agentId: null });
  });

  it("lists recommendations and records a decision, and does nothing else", async () => {
    await performanceManagerApi.recommendations("c-1", "a-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/c-1/evaluation/agents/a-1/recommendations");
    await performanceManagerApi.decide("c-1", "a-1", "rec-1", { decision: "declined", note: "Not yet" });
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.post).toHaveBeenLastCalledWith("/companies/c-1/evaluation/agents/a-1/recommendations/rec-1/decision", {
      decision: "declined",
      note: "Not yet",
    });
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it("reads the effective manager's record, or a named agent's", async () => {
    await performanceManagerApi.record("c-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/c-1/evaluation/performance-manager/record");
    await performanceManagerApi.record("c-1", "a-7");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/c-1/evaluation/performance-manager/record?agentId=a-7");
  });
});
