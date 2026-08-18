import { beforeEach, describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";

/**
 * External testing produced one finding worth more than the bugs it found:
 * test through MCP, not through the source, because the tool surface IS the
 * product for anyone driving AgentDash from their own terminal.
 *
 * "Renaming an agent doesn't work" was reported as a bug. It was not one --
 * `PATCH /agents/:id` had always accepted a new name. The capability existed
 * and was unreachable, which from the customer's side is the same thing as
 * absent, and worse, because it looks like breakage rather than a gap.
 *
 * These tests pin the two capabilities that closed that gap, at the boundary
 * the customer actually touches.
 */

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function getTool(name: string) {
  const tool = createToolDefinitions(makeClient()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url: String(url),
    method: init.method,
    body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  };
}

describe("renaming an agent through MCP", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("is reachable as a tool, not only as a REST route", () => {
    // The whole point. If this name disappears, the capability is gone from
    // the customer's view no matter what the server can still do.
    expect(() => getTool("update_agent")).not.toThrow();
  });

  it("PATCHes the agent with only the fields that were passed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "agent-1", name: "Atlas" }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("update_agent").execute({ agentId: "agent-1", name: "Atlas" });

    const request = lastRequest(fetchMock);
    expect(request.url).toBe("http://localhost:3100/api/agents/agent-1");
    expect(request.method).toBe("PATCH");
    // A rename must not quietly restate every other field — a partial update
    // that ships undefined keys can blank a title the caller never mentioned.
    expect(request.body).toEqual({ name: "Atlas" });
  });

  it("keeps an explicit null, because that is how a title is cleared", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("update_agent").execute({ agentId: "agent-1", title: null });

    expect(lastRequest(fetchMock).body).toEqual({ title: null });
  });

  it("refuses a call that would change nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    // Returns the validation error as tool output rather than throwing, so an
    // agent reads why it failed instead of seeing an opaque transport error.
    const result = await getTool("update_agent").execute({ agentId: "agent-1" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toMatch(/at least one field/i);
  });
});

describe("filing a bug through MCP", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("posts the report to the instance's own endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ number: 42, url: "https://github.com/o/r/issues/42" }, 201),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getTool("report_issue").execute({
      kind: "bug",
      title: "Renaming an agent returns 404",
      description: "Ran update_agent with a new name and got a 404 back.",
    });

    const request = lastRequest(fetchMock);
    expect(request.url).toBe("http://localhost:3100/api/issue-reports");
    expect(request.method).toBe("POST");
    expect(request.body).toMatchObject({ kind: "bug" });
    // Repo, owner and labels are instance configuration. An agent that could
    // set them would file confidently into the wrong queue.
    expect(request.body).not.toHaveProperty("repo");
    expect(request.body).not.toHaveProperty("labels");
  });

  it("rejects a report too thin to act on before spending a network call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await getTool("report_issue").execute({ kind: "bug", title: "x", description: "broke" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can report whether reporting is configured at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ enabled: false, repo: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getTool("report_issue_status").execute({});

    const request = lastRequest(fetchMock);
    expect(request.url).toBe("http://localhost:3100/api/issue-reports/config");
    expect(request.method).toBe("GET");
  });
});
