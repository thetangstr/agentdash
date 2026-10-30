import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, api: mockApi };
});

const { agentProfilesApi, agentAccessEnforcementApi, issueResponsibilityApi, unboundAgentProfilesApi } = await import("./agent-profiles");

const BASE = "/companies/c-1/agents/a-1/profile";

describe("agentProfilesApi (APM gate 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(mockApi)) fn.mockResolvedValue({});
  });

  it("saves a draft with PATCH and a quoted If-Match of the loaded body hash", async () => {
    const input = { body: { profileVersion: 1 } as never };
    await agentProfilesApi.saveDraft("c-1", "a-1", "rev-1", "abc123", input);
    expect(mockApi.patch).toHaveBeenCalledWith(`${BASE}/revisions/rev-1`, input, { "If-Match": '"abc123"' });
    // A save is a save: nothing else is asked of the server.
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("creates a draft with an empty body so the server seeds it", async () => {
    await agentProfilesApi.createDraft("c-1", "a-1");
    expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/revisions`, {});
  });

  it("proposes, withdraws and resumes on their own routes", async () => {
    await agentProfilesApi.propose("c-1", "a-1", "rev-1", { reason: "why" });
    expect(mockApi.post).toHaveBeenLastCalledWith(`${BASE}/revisions/rev-1/propose`, { reason: "why" });
    await agentProfilesApi.withdraw("c-1", "a-1", "rev-1");
    expect(mockApi.post).toHaveBeenLastCalledWith(`${BASE}/revisions/rev-1/withdraw`, {});
    await agentProfilesApi.resumeApplication("c-1", "a-1", "app-1");
    expect(mockApi.post).toHaveBeenLastCalledWith(`${BASE}/applications/app-1/resume`, {});
  });

  it("reads history, one revision, a diff and applications", async () => {
    await agentProfilesApi.revisions("c-1", "a-1");
    expect(mockApi.get).toHaveBeenLastCalledWith(`${BASE}/revisions`);
    await agentProfilesApi.revision("c-1", "a-1", "rev-1");
    expect(mockApi.get).toHaveBeenLastCalledWith(`${BASE}/revisions/rev-1`);
    await agentProfilesApi.diff("c-1", "a-1", "rev-2");
    expect(mockApi.get).toHaveBeenLastCalledWith(`${BASE}/revisions/rev-2/diff?against=active`);
    await agentProfilesApi.diff("c-1", "a-1", "rev-2", "rev-1");
    expect(mockApi.get).toHaveBeenLastCalledWith(`${BASE}/revisions/rev-2/diff?against=rev-1`);
    await agentProfilesApi.applications("c-1", "a-1");
    expect(mockApi.get).toHaveBeenLastCalledWith(`${BASE}/applications`);
  });

  it("exports Markdown as a plain link under /api", () => {
    expect(agentProfilesApi.exportMarkdownUrl("c 1", "a-1", "rev-1")).toBe(
      "/api/companies/c%201/agents/a-1/profile/revisions/rev-1/export.md",
    );
  });

  it("reads and sets the company enforcement mode", async () => {
    await agentAccessEnforcementApi.get("c-1");
    expect(mockApi.get).toHaveBeenLastCalledWith("/companies/c-1/agent-access-enforcement");
    await agentAccessEnforcementApi.set("c-1", "shadow");
    expect(mockApi.patch).toHaveBeenLastCalledWith("/companies/c-1/agent-access-enforcement", { mode: "shadow" });
  });

  it("maps an issue to a responsibility", async () => {
    await issueResponsibilityApi.map("c-1", "i-1", { agentId: "a-1", responsibilityKey: "weekly" });
    expect(mockApi.post).toHaveBeenLastCalledWith("/companies/c-1/issues/i-1/responsibility", {
      agentId: "a-1",
      responsibilityKey: "weekly",
    });
  });
});

describe("api.patch with extra headers", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the JSON content type when If-Match is added", async () => {
    const { api } = await vi.importActual<typeof import("./client")>("./client");
    await api.patch("/x", { a: 1 }, { "If-Match": '"h"' });
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("If-Match")).toBe('"h"');
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("is unchanged without extra headers", async () => {
    const { api } = await vi.importActual<typeof import("./client")>("./client");
    await api.patch("/x", { a: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(init.headers).get("If-Match")).toBeNull();
  });
});

// AgentDash (APM gate 5, P5.2): unbound drafts — a profile for a role not hired yet.
describe("unboundAgentProfilesApi (APM gate 5)", () => {
  const UNBOUND = "/companies/c-1/agent-profiles";

  beforeEach(() => {
    vi.clearAllMocks();
    for (const fn of Object.values(mockApi)) fn.mockResolvedValue({});
  });

  it("saves a draft with PATCH and a quoted If-Match, and asks nothing else", async () => {
    const input = { body: { profileVersion: 1 } as never };
    await unboundAgentProfilesApi.saveDraft("c-1", "p-1", "rev-1", "abc123", input);
    expect(mockApi.patch).toHaveBeenCalledWith(`${UNBOUND}/p-1/revisions/rev-1`, input, { "If-Match": '"abc123"' });
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("requests a hire and withdraws it on their own routes", async () => {
    await unboundAgentProfilesApi.propose("c-1", "p-1", "rev-1", { role: "general", sourceIssueId: null });
    expect(mockApi.post).toHaveBeenLastCalledWith(`${UNBOUND}/p-1/revisions/rev-1/propose`, { role: "general", sourceIssueId: null });
    await unboundAgentProfilesApi.withdraw("c-1", "p-1", "rev-1");
    expect(mockApi.post).toHaveBeenLastCalledWith(`${UNBOUND}/p-1/revisions/rev-1/withdraw`, {});
  });

  it("creates a profile, or a new draft seeded by the server", async () => {
    await unboundAgentProfilesApi.create("c-1", { body: { profileVersion: 1 } as never });
    expect(mockApi.post).toHaveBeenLastCalledWith(UNBOUND, { body: { profileVersion: 1 } });
    await unboundAgentProfilesApi.createDraft("c-1", "p-1");
    expect(mockApi.post).toHaveBeenLastCalledWith(`${UNBOUND}/p-1/revisions`, {});
  });

  it("lists, reads one, reads a revision and diffs", async () => {
    await unboundAgentProfilesApi.list("c-1");
    expect(mockApi.get).toHaveBeenLastCalledWith(UNBOUND);
    await unboundAgentProfilesApi.get("c-1", "p 1");
    expect(mockApi.get).toHaveBeenLastCalledWith(`${UNBOUND}/p%201`);
    await unboundAgentProfilesApi.revision("c-1", "p-1", "rev-1");
    expect(mockApi.get).toHaveBeenLastCalledWith(`${UNBOUND}/p-1/revisions/rev-1`);
    await unboundAgentProfilesApi.diff("c-1", "p-1", "rev-2");
    expect(mockApi.get).toHaveBeenLastCalledWith(`${UNBOUND}/p-1/revisions/rev-2/diff?against=none`);
  });

  it("exports a draft's Markdown as a plain link under /api", () => {
    expect(unboundAgentProfilesApi.exportMarkdownUrl("c 1", "p-1", "rev-1")).toBe("/api/companies/c%201/agent-profiles/p-1/revisions/rev-1/export.md");
  });
});
