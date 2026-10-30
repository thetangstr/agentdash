import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("./client", () => ({ api: mockApi }));

const { agentPerformanceApi, agentPerformanceQueryKeys } = await import("./agent-performance");

describe("agentPerformanceApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({});
  });

  it("reads the derived profile from the company-scoped agent route", async () => {
    await agentPerformanceApi.profile("company-1", "agent-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/agents/agent-1/profile");
  });

  it("reads the access inventory from the company-scoped agent route", async () => {
    await agentPerformanceApi.access("company-1", "agent-1");
    expect(mockApi.get).toHaveBeenCalledWith("/companies/company-1/agents/agent-1/access");
  });

  it("reads the projection with a 30-day window by default", async () => {
    await agentPerformanceApi.projection("company-1", "agent-1");
    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/evaluation/agents/agent-1/projection?windowDays=30",
    );
    await agentPerformanceApi.projection("company-1", "agent-1", 7);
    expect(mockApi.get).toHaveBeenLastCalledWith(
      "/companies/company-1/evaluation/agents/agent-1/projection?windowDays=7",
    );
  });

  it("the gate 1 views only ever issue GETs", async () => {
    await agentPerformanceApi.profile("c", "a");
    await agentPerformanceApi.access("c", "a");
    await agentPerformanceApi.projection("c", "a");
    expect(mockApi.get).toHaveBeenCalledTimes(3);
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  // Gate 3 (P3.5): the agent card routes.
  it("reads agent cards: the list, a stored version, Compute now and the cases", async () => {
    await agentPerformanceApi.cards("company-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/company-1/evaluation/agents");
    await agentPerformanceApi.card("company-1", "agent-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/company-1/evaluation/agents/agent-1");
    await agentPerformanceApi.card("company-1", "agent-1", 2);
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/company-1/evaluation/agents/agent-1?version=2");
    await agentPerformanceApi.compute("company-1", "agent-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/company-1/evaluation/agents/agent-1/compute?windowDays=30");
    await agentPerformanceApi.cases("company-1", "agent-1", { version: 3, section: "obligations", responsibility: "weekly-report", state: "missed", limit: 50, cursor: "50" });
    expect(mockApi.get).toHaveBeenLastCalledWith(
      "/companies/company-1/evaluation/agents/agent-1/cases?version=3&responsibility=weekly-report&state=missed&section=obligations&limit=50&cursor=50",
    );
    await agentPerformanceApi.cases("company-1", "agent-1", {});
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/company-1/evaluation/agents/agent-1/cases");
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  // P3.7: the stored versions, and the server-side fact, criterion and judge filters.
  it("reads the stored versions and sends fact, criterion and judge to the cases route", async () => {
    await agentPerformanceApi.versions("company-1", "agent-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/company-1/evaluation/agents/agent-1/versions");
    const criterion = JSON.stringify(["e1", "weekly-report", "cites", "0123456789abcdef"]);
    await agentPerformanceApi.cases("company-1", "agent-1", { section: "quality", criterion, judge: "person", state: "pass" });
    expect(mockApi.get).toHaveBeenLastCalledWith(
      `/companies/company-1/evaluation/agents/agent-1/cases?state=pass&section=quality&criterion=${encodeURIComponent(criterion).replace(/%20/g, "+")}&judge=person`,
    );
    await agentPerformanceApi.cases("company-1", "agent-1", { section: "acceptance", fact: "use" });
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/company-1/evaluation/agents/agent-1/cases?section=acceptance&fact=use");
    // the versions key sits under the card's, so a snapshot's invalidation refreshes it
    expect(agentPerformanceQueryKeys.versions("c", "a").slice(0, agentPerformanceQueryKeys.cardAll("c", "a").length)).toEqual([...agentPerformanceQueryKeys.cardAll("c", "a")]);
  });

  it("posts a snapshot and an agent disposition to their routes", async () => {
    mockApi.post.mockResolvedValue({});
    await agentPerformanceApi.snapshot("company-1", "agent-1");
    expect(mockApi.post).toHaveBeenLastCalledWith("/companies/company-1/evaluation/agents/agent-1/snapshot?windowDays=30", {});
    const body = {
      kind: "use_confirmed" as const,
      subjectRef: { kind: "agent" as const, id: "11111111-1111-4111-8111-111111111111" },
      item: { kind: "issue" as const, id: "33333333-3333-4333-8333-333333333333" },
      evidenceRefs: [],
    };
    await agentPerformanceApi.recordDisposition("company-1", body);
    expect(mockApi.post).toHaveBeenLastCalledWith("/companies/company-1/evaluation/dispositions", body);
  });

  it("keys each view per company, agent and window", () => {
    expect(agentPerformanceQueryKeys.projection("c", "a", 30)).not.toEqual(
      agentPerformanceQueryKeys.projection("c", "a", 7),
    );
    expect(agentPerformanceQueryKeys.access("c1", "a")).not.toEqual(agentPerformanceQueryKeys.access("c2", "a"));
  });
});
