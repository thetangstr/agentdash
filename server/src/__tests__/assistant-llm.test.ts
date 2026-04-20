import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveAssistantConfig, streamChat, type AssistantLLMConfig } from "../services/assistant-llm.js";

describe("assistant-llm", () => {
  describe("resolveAssistantConfig", () => {
    beforeEach(() => {
      delete process.env.ASSISTANT_API_KEY;
      delete process.env.ASSISTANT_MODEL;
      delete process.env.ASSISTANT_BASE_URL;
    });

    it("throws 503 when no API key", () => {
      expect(() => resolveAssistantConfig()).toThrow("ASSISTANT_API_KEY");
    });

    it("returns config with defaults", () => {
      process.env.ASSISTANT_API_KEY = "test-key";
      const config = resolveAssistantConfig();
      expect(config.apiKey).toBe("test-key");
      expect(config.model).toBe("claude-sonnet-4-20250514");
      expect(config.baseUrl).toBe("https://api.anthropic.com");
      expect(config.maxTokens).toBe(4096);
    });

    it("respects env overrides", () => {
      process.env.ASSISTANT_API_KEY = "key";
      process.env.ASSISTANT_MODEL = "claude-opus-4-20250514";
      process.env.ASSISTANT_BASE_URL = "https://custom.api.com";
      const config = resolveAssistantConfig();
      expect(config.model).toBe("claude-opus-4-20250514");
      expect(config.baseUrl).toBe("https://custom.api.com");
    });
  });

  describe("streamChat", () => {
    const mockConfig: AssistantLLMConfig = {
      apiKey: "test-key",
      model: "claude-sonnet-4-20250514",
      baseUrl: "https://api.anthropic.com",
      maxTokens: 4096,
    };

    it("yields text chunks from SSE stream", async () => {
      const sseData = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":5}}',
        'data: {"type":"message_stop"}',
      ].join("\n") + "\n";

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const chunks: any[] = [];
      for await (const chunk of streamChat(mockConfig, "system", [{ role: "user", content: "hi" }])) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
      ]);

      vi.unstubAllGlobals();
    });

    it("yields tool_use chunks", async () => {
      const sseData = [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"create_agent"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"name\\": \\"Test\\"}"}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":8}}',
        'data: {"type":"message_stop"}',
      ].join("\n") + "\n";

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sseData));
            controller.close();
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const chunks: any[] = [];
      for await (const chunk of streamChat(mockConfig, "system", [{ role: "user", content: "create an agent" }])) {
        chunks.push(chunk);
      }

      expect(chunks[0]).toEqual({
        type: "tool_use",
        id: "tu_1",
        name: "create_agent",
        input: { name: "Test" },
      });

      vi.unstubAllGlobals();
    });

    it("yields error on HTTP failure", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });
      vi.stubGlobal("fetch", mockFetch);

      const chunks: any[] = [];
      for await (const chunk of streamChat(mockConfig, "system", [{ role: "user", content: "hi" }])) {
        chunks.push(chunk);
      }

      expect(chunks[0].type).toBe("error");
      expect(chunks[0].code).toBe("http_401");

      vi.unstubAllGlobals();
    });

    it("yields error on network failure", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", mockFetch);

      const chunks: any[] = [];
      for await (const chunk of streamChat(mockConfig, "system", [{ role: "user", content: "hi" }])) {
        chunks.push(chunk);
      }

      expect(chunks[0].type).toBe("error");
      expect(chunks[0].code).toBe("fetch_error");

      vi.unstubAllGlobals();
    });
  });
});
