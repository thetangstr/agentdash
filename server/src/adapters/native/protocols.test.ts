import { describe, expect, it, vi } from "vitest";
import { anthropicProtocol, getProtocol, openaiProtocol, type NeutralMessage } from "./protocols.js";
import { runAgentLoop } from "./loop.js";
import type { Tool, ToolSchema } from "./tools.js";

const schema: ToolSchema = {
  type: "function",
  function: { name: "get_time", description: "current time", parameters: { type: "object", properties: {} } },
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
}

describe("getProtocol", () => {
  it("maps names to implementations", () => {
    expect(getProtocol("openai").name).toBe("openai");
    expect(getProtocol("anthropic").name).toBe("anthropic");
  });
});

describe("anthropic protocol wire format", () => {
  const history: NeutralMessage[] = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "let me check", toolCalls: [{ id: "tu_1", name: "get_time", argsJson: "{}" }] },
    { role: "tool_results", results: [{ id: "tu_1", content: '{"now":"x"}' }] },
  ];

  it("builds a Messages API body (system top-level, tool_use / tool_result blocks, input_schema tools)", () => {
    const body = anthropicProtocol.buildBody({ model: "MiniMax-M3", systemPrompt: "sys", history, toolSchemas: [schema], maxTokens: 1024 });
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(1024);
    expect(body.tools).toEqual([{ name: "get_time", description: "current time", input_schema: { type: "object", properties: {} } }]);
    const messages = body.messages as Array<Record<string, unknown>>;
    // assistant tool_use block
    const assistant = messages[1]!.content as Array<Record<string, unknown>>;
    expect(assistant).toContainEqual({ type: "tool_use", id: "tu_1", name: "get_time", input: {} });
    // tool result is a user message with tool_result block
    const toolResult = messages[2]!.content as Array<Record<string, unknown>>;
    expect(toolResult).toContainEqual({ type: "tool_result", tool_use_id: "tu_1", content: '{"now":"x"}' });
  });

  it("parses content blocks + usage", () => {
    const turn = anthropicProtocol.parse({
      content: [
        { type: "text", text: "thinking" },
        { type: "tool_use", id: "tu_2", name: "get_time", input: { tz: "utc" } },
      ],
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
    });
    expect(turn.text).toBe("thinking");
    expect(turn.toolCalls).toEqual([{ id: "tu_2", name: "get_time", argsJson: JSON.stringify({ tz: "utc" }) }]);
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 7, cachedInputTokens: 3 });
  });

  it("sends x-api-key + anthropic-version headers and the /v1/messages endpoint", () => {
    expect(anthropicProtocol.endpoint("https://api.minimaxi.com/anthropic")).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    const h = anthropicProtocol.headers("k");
    expect(h["x-api-key"]).toBe("k");
    expect(h["anthropic-version"]).toBeDefined();
  });
});

describe("runAgentLoop over the anthropic protocol", () => {
  it("drives a tool call then completes against Anthropic-shaped responses", async () => {
    let called = false;
    const tool: Tool = {
      schema,
      execute: async () => {
        called = true;
        return { content: '{"now":"2026"}', isError: false };
      },
    };
    const responses = [
      // turn 1: a tool_use block
      { content: [{ type: "tool_use", id: "tu_9", name: "get_time", input: {} }], usage: { input_tokens: 10, output_tokens: 4 } },
      // turn 2: final text
      { content: [{ type: "text", text: "It is 2026." }], usage: { input_tokens: 6, output_tokens: 2 } },
    ];
    let i = 0;
    const fetchImpl = vi.fn(async () => jsonResponse(responses[i++])) as unknown as typeof fetch;

    const result = await runAgentLoop({
      protocol: anthropicProtocol,
      baseUrl: "https://api.minimaxi.com/anthropic",
      apiKey: "k",
      model: "MiniMax-M3",
      systemPrompt: "s",
      userPrompt: "what time is it?",
      tools: [tool],
      maxTurns: 5,
      timeoutMs: 5000,
      fetchImpl,
    });

    expect(result.stopReason).toBe("completed");
    expect(result.finalText).toBe("It is 2026.");
    expect(called).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 16, outputTokens: 6, cachedInputTokens: 0 });
    // hit the Anthropic /v1/messages endpoint
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  });
});

describe("openai protocol still serializes role:tool history", () => {
  it("emits a tool message for tool_results", () => {
    const body = openaiProtocol.buildBody({
      model: "m",
      systemPrompt: "s",
      history: [{ role: "tool_results", results: [{ id: "c1", content: "ok" }] }],
      toolSchemas: [schema],
      maxTokens: 100,
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toContainEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
  });
});
