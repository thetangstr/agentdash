import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, api: mockApi };
});

const { agentBriefsApi } = await import("./agent-briefs");

// AgentDash (APM gate 5, P5.2): saving a brief and sending it to the planner are separate calls.
describe("agentBriefsApi (APM gate 5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(mockApi)) fn.mockResolvedValue({});
  });

  it("creates a brief with one POST and never submits it", async () => {
    await agentBriefsApi.create("c-1", { title: "Collections", markdown: "# Brief" });
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.post).toHaveBeenCalledWith("/companies/c-1/agent-briefs", { title: "Collections", markdown: "# Brief" });
  });

  it("submits on its own route", async () => {
    await agentBriefsApi.submit("c-1", "issue-1");
    expect(mockApi.post).toHaveBeenCalledWith("/companies/c-1/agent-briefs/issue-1/submit", {});
  });

  it("reads the brief, its revisions and the manifest as issue documents", async () => {
    await agentBriefsApi.brief("issue-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/issues/issue-1/documents/agent-work-brief");
    await agentBriefsApi.briefRevisions("issue-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/issues/issue-1/documents/agent-work-brief/revisions");
    await agentBriefsApi.manifest("issue-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/issues/issue-1/documents/scenario-manifest");
    await agentBriefsApi.list("c-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/c-1/issues?originKind=agent_work_brief");
  });

  it("edits the brief through the revision API with the loaded base revision", async () => {
    await agentBriefsApi.saveBrief("issue-1", { body: "# New", baseRevisionId: "rev-1", title: "Agent-work brief", changeSummary: "Brief edited" });
    expect(mockApi.put).toHaveBeenCalledWith("/issues/issue-1/documents/agent-work-brief", {
      format: "markdown",
      body: "# New",
      baseRevisionId: "rev-1",
      title: "Agent-work brief",
      changeSummary: "Brief edited",
    });
  });
});
