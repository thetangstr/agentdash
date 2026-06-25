import { describe, expect, it, vi } from "vitest";
import { PaperclipApi } from "./paperclip-api.js";
import { buildTools, findTool } from "./tools.js";
import { runAgentLoop, type LoopMessage } from "./loop.js";

// ---- helpers -------------------------------------------------------------
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  return {
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    statusText: ok ? "OK" : "ERR",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function assistantWithToolCall(name: string, args: object): unknown {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}
function assistantFinal(text: string): unknown {
  return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 8, completion_tokens: 3 } };
}

// ---- PaperclipApi / tools -----------------------------------------------
describe("PaperclipApi request shaping", () => {
  it("sends Bearer auth + run-id header and correct method/path/body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const api = new PaperclipApi({ baseUrl: "http://api.test", authToken: "jwt-123", runId: "run-9", fetchImpl });
    await api.updateIssue("iss-1", { status: "done" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://api.test/api/issues/iss-1");
    expect(calls[0]!.init.method).toBe("PATCH");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-123");
    expect(headers["X-Paperclip-Run-Id"]).toBe("run-9");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ status: "done" });
  });

  it("throws PaperclipApiError on non-ok with the server error message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "nope" }, { ok: false, status: 409 })) as unknown as typeof fetch;
    const api = new PaperclipApi({ baseUrl: "http://api.test", authToken: "t", fetchImpl });
    await expect(api.getIssue("x")).rejects.toMatchObject({ status: 409, message: "nope" });
  });
});

describe("tools route to the right endpoints", () => {
  function setup() {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method as string, body: init.body ? JSON.parse(init.body as string) : undefined });
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;
    const api = new PaperclipApi({ baseUrl: "http://api.test", authToken: "t", fetchImpl });
    const tools = buildTools({ api, agentId: "agent-1", companyId: "co-1", currentIssueId: "iss-1", autoApprove: false });
    return { calls, tools };
  }

  it("add_comment posts to the current issue", async () => {
    const { calls, tools } = setup();
    const r = await findTool(tools, "add_comment")!.execute({ body: "hello" });
    expect(r.isError).toBe(false);
    expect(calls[0]).toMatchObject({ url: "http://api.test/api/issues/iss-1/comments", method: "POST", body: { body: "hello" } });
  });

  it("set_dod PUTs to the company/issue dod path", async () => {
    const { calls, tools } = setup();
    await findTool(tools, "set_dod")!.execute({ summary: "s", criteria: [{ description: "c" }] });
    expect(calls[0]).toMatchObject({
      url: "http://api.test/api/companies/co-1/issues/iss-1/dod",
      method: "PUT",
      body: { summary: "s", criteria: [{ description: "c" }] },
    });
  });

  it("write_verdict posts a verdict with reviewerAgentId + entityType issue", async () => {
    const { calls, tools } = setup();
    await findTool(tools, "write_verdict")!.execute({ outcome: "passed", justification: "lgtm" });
    expect(calls[0]!.url).toBe("http://api.test/api/companies/co-1/verdicts");
    expect(calls[0]!.body).toMatchObject({
      companyId: "co-1",
      entityType: "issue",
      issueId: "iss-1",
      reviewerAgentId: "agent-1",
      outcome: "passed",
    });
  });

  it("get_quota GETs the company quota", async () => {
    const { calls, tools } = setup();
    await findTool(tools, "get_quota")!.execute({});
    expect(calls[0]).toMatchObject({ url: "http://api.test/api/companies/co-1/quota", method: "GET" });
  });

  it("validation errors come back as isError results, not throws", async () => {
    const { tools } = setup();
    const r = await findTool(tools, "update_issue_status")!.execute({});
    expect(r.isError).toBe(true);
    expect(r.content).toContain("status is required");
  });

  it("includes the 4 AgentDash-specific tools", () => {
    const { tools } = setup();
    for (const name of ["set_dod", "write_verdict", "create_interaction", "get_quota"]) {
      expect(findTool(tools, name)).not.toBeNull();
    }
  });
});

// ---- in-process loop -----------------------------------------------------
describe("runAgentLoop", () => {
  function fakeTool(name: string, onCall: (args: Record<string, unknown>) => void) {
    return {
      schema: { type: "function" as const, function: { name, description: "", parameters: { type: "object", properties: {} } } },
      execute: async (args: Record<string, unknown>) => {
        onCall(args);
        return { content: JSON.stringify({ ok: true }), isError: false };
      },
    };
  }

  it("executes a tool call then completes, accumulating usage", async () => {
    const seen: Record<string, unknown>[] = [];
    const responses = [assistantWithToolCall("add_comment", { body: "done" }), assistantFinal("All done")];
    let i = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(responses[i++])) as unknown as typeof fetch;

    const result = await runAgentLoop({
      baseUrl: "http://gw.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "sys",
      userPrompt: "task",
      tools: [fakeTool("add_comment", (a) => seen.push(a))],
      maxTurns: 5,
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(result.stopReason).toBe("completed");
    expect(result.finalText).toBe("All done");
    expect(result.toolCalls).toBe(1);
    expect(seen[0]).toEqual({ body: "done" });
    expect(result.usage).toEqual({ inputTokens: 18, outputTokens: 8, cachedInputTokens: 0 });
    // posts to {baseUrl}/chat/completions
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("http://gw.test/v1/chat/completions");
  });

  it("stops with max_turns if the model never stops calling tools", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(assistantWithToolCall("noop", {}))) as unknown as typeof fetch;
    const result = await runAgentLoop({
      baseUrl: "http://gw.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      tools: [fakeTool("noop", () => {})],
      maxTurns: 3,
      timeoutMs: 5000,
      fetchImpl,
    });
    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toBe(3);
  });

  it("returns error stopReason on a non-ok gateway response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, { ok: false, status: 401 })) as unknown as typeof fetch;
    const result = await runAgentLoop({
      baseUrl: "http://gw.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      tools: [],
      maxTurns: 3,
      timeoutMs: 5000,
      fetchImpl,
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("bad key");
  });

  it("feeds a tool result back as a role:tool message", async () => {
    const sentBodies: LoopMessage[][] = [];
    const responses = [assistantWithToolCall("noop", {}), assistantFinal("ok")];
    let i = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(init.body as string).messages);
      return jsonResponse(responses[i++]);
    }) as unknown as typeof fetch;

    await runAgentLoop({
      baseUrl: "http://gw.test/v1",
      apiKey: "k",
      model: "m",
      systemPrompt: "s",
      userPrompt: "u",
      tools: [fakeTool("noop", () => {})],
      maxTurns: 5,
      timeoutMs: 5000,
      fetchImpl,
    });

    // second request includes the assistant tool_call + the tool result
    const secondReqMessages = sentBodies[1]!;
    expect(secondReqMessages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
  });
});
