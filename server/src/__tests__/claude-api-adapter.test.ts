import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Anthropic SDK before importing execute
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

import { execute } from "../adapters/claude-api/execute.js";
import { testEnvironment } from "../adapters/claude-api/test.js";
import { claudeApiAdapter } from "../adapters/claude-api/index.js";

const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
  }
  vi.clearAllMocks();
});

// ── Adapter module ──────────────────────────────────────────────────────

describe("claude_api adapter module", () => {
  it("exports type claude_api", () => {
    expect(claudeApiAdapter.type).toBe("claude_api");
  });

  it("exports execute and testEnvironment functions", () => {
    expect(typeof claudeApiAdapter.execute).toBe("function");
    expect(typeof claudeApiAdapter.testEnvironment).toBe("function");
  });

  it("lists available models", () => {
    expect(claudeApiAdapter.models).toEqual([
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
      { id: "claude-haiku-3-5-20241022", label: "Claude Haiku 3.5" },
    ]);
  });
});

// ── testEnvironment ─────────────────────────────────────────────────────

describe("claude_api testEnvironment", () => {
  it("fails when no API key is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_api",
      config: {},
    });

    expect(result.status).toBe("fail");
    expect(result.adapterType).toBe("claude_api");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ANTHROPIC_API_KEY_MISSING",
          level: "error",
        }),
      ]),
    );
  });

  it("passes when ANTHROPIC_API_KEY is in environment", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-env";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_api",
      config: {},
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ANTHROPIC_API_KEY_PRESENT",
          level: "info",
        }),
      ]),
    );
  });

  it("passes when apiKey is in adapter config", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_api",
      config: { apiKey: "sk-test-config" },
    });

    expect(result.status).toBe("pass");
  });

  it("prefers config apiKey over env", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_api",
      config: { apiKey: "sk-config" },
    });

    expect(result.status).toBe("pass");
  });

  it("returns ISO timestamp in testedAt", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "claude_api",
      config: {},
    });

    expect(result.testedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── execute ─────────────────────────────────────────────────────────────

describe("claude_api execute", () => {
  const baseCtx = {
    config: { apiKey: "sk-test-execute" },
    context: {
      issueTitle: "Fix login bug",
      issueDescription: "The login page crashes on submit",
      wakeReason: "heartbeat",
      additionalContext: "",
      paperclipCoordinationPrompt: "",
    },
    agent: { name: "DebugBot" },
    onLog: vi.fn(),
  };

  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("calls Anthropic API with correct parameters", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Fixed the login bug." }],
      usage: { input_tokens: 100, output_tokens: 50 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    await execute(baseCtx as any);

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-sonnet-4-20250514");
    expect(callArgs.max_tokens).toBe(4096);
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0].role).toBe("user");
    expect(callArgs.messages[0].content).toContain("Fix login bug");
  });

  it("returns successful result with usage and cost", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 200, output_tokens: 100 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    const result = await execute(baseCtx as any);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      cachedInputTokens: 0,
    });
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
    expect(result.billingType).toBe("api");
    expect(typeof result.costUsd).toBe("number");
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("computes correct cost for sonnet", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hi" }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    const result = await execute(baseCtx as any);

    // Sonnet: $3/M input + $15/M output = $3 + $15 = $18
    expect(result.costUsd).toBeCloseTo(18, 1);
  });

  it("computes correct cost for opus", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hi" }],
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      model: "claude-opus-4-20250514",
      stop_reason: "end_turn",
    });

    const result = await execute({
      ...baseCtx,
      config: { ...baseCtx.config, model: "claude-opus-4-20250514" },
    } as any);

    // Opus: $15/M input + $75/M output = $15 + $75 = $90
    expect(result.costUsd).toBeCloseTo(90, 1);
  });

  it("includes cached tokens in cost calculation", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hi" }],
      usage: {
        input_tokens: 500_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 500_000,
      },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    const result = await execute(baseCtx as any);

    // 1M total input * $3/M + 100K output * $15/M = $3 + $1.5 = $4.5
    expect(result.costUsd).toBeCloseTo(4.5, 1);
  });

  it("logs output text via onLog", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Task completed successfully." }],
      usage: { input_tokens: 50, output_tokens: 20 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    await execute(baseCtx as any);

    expect(baseCtx.onLog).toHaveBeenCalledWith("stdout", "Task completed successfully.");
  });

  it("uses custom model from config", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hi" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-haiku-3-5-20241022",
      stop_reason: "end_turn",
    });

    await execute({
      ...baseCtx,
      config: { ...baseCtx.config, model: "claude-haiku-3-5-20241022" },
    } as any);

    expect(mockCreate.mock.calls[0][0].model).toBe("claude-haiku-3-5-20241022");
  });

  it("uses custom maxTokens from config", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hi" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    await execute({
      ...baseCtx,
      config: { ...baseCtx.config, maxTokens: 8192 },
    } as any);

    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(8192);
  });

  it("builds user message from issue context", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Done" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    await execute(baseCtx as any);

    const userMsg = mockCreate.mock.calls[0][0].messages[0].content;
    expect(userMsg).toContain("Task: Fix login bug");
    expect(userMsg).toContain("Description:");
    expect(userMsg).toContain("The login page crashes on submit");
    expect(userMsg).toContain("Wake reason: heartbeat");
  });

  it("uses agent name in default system prompt", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Done" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    await execute(baseCtx as any);

    const systemMsg = mockCreate.mock.calls[0][0].system;
    expect(systemMsg).toContain("DebugBot");
  });

  it("uses systemPrompt override from config", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Done" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    await execute({
      ...baseCtx,
      config: { ...baseCtx.config, systemPrompt: "You are a helpful assistant." },
    } as any);

    expect(mockCreate.mock.calls[0][0].system).toBe("You are a helpful assistant.");
  });

  it("returns error result on API failure", async () => {
    mockCreate.mockRejectedValue(new Error("Rate limit exceeded"));

    const result = await execute(baseCtx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("Rate limit exceeded");
    expect(baseCtx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Rate limit exceeded"),
    );
  });

  it("handles non-Error thrown values", async () => {
    mockCreate.mockRejectedValue("unexpected string error");

    const result = await execute(baseCtx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("unexpected string error");
  });

  it("truncates summary to 200 characters", async () => {
    const longText = "A".repeat(500);
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: longText }],
      usage: { input_tokens: 10, output_tokens: 200 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    const result = await execute(baseCtx as any);

    expect(result.summary!.length).toBe(200);
  });

  it("returns resultJson with content and stopReason", async () => {
    const content = [{ type: "text", text: "Hello" }];
    mockCreate.mockResolvedValue({
      content,
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
    });

    const result = await execute(baseCtx as any);

    expect(result.resultJson).toEqual({
      content: content as any,
      stopReason: "end_turn",
    });
  });
});
