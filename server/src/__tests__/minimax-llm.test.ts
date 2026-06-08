import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy on the Anthropic SDK constructor so we can assert it is NOT constructed
// in stub mode, and IS constructed (with MiniMax base URL) when a key is set.
const messagesCreate = vi.hoisted(() => vi.fn());
const AnthropicCtor = vi.hoisted(() =>
  vi.fn(function (this: Record<string, unknown>) {
    this.messages = { create: messagesCreate };
  }),
);

vi.mock("@anthropic-ai/sdk", () => ({ default: AnthropicCtor }));

import { minimaxLLM } from "../services/minimax-llm.js";

const ORIG = {
  key: process.env.MINIMAX_API_KEY,
  base: process.env.MINIMAX_BASE_URL,
  model: process.env.MINIMAX_MODEL,
};

const INPUT = {
  system: "You are a Chief of Staff.",
  messages: [{ role: "user" as const, content: "Help me hire agents." }],
};

describe("minimaxLLM", () => {
  beforeEach(() => {
    AnthropicCtor.mockClear();
    messagesCreate.mockReset();
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_BASE_URL;
    delete process.env.MINIMAX_MODEL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries({
      MINIMAX_API_KEY: ORIG.key,
      MINIMAX_BASE_URL: ORIG.base,
      MINIMAX_MODEL: ORIG.model,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns a stub and never constructs a client when MINIMAX_API_KEY is unset", async () => {
    const reply = await minimaxLLM(INPUT);
    expect(reply).toContain("stub reply");
    expect(AnthropicCtor).not.toHaveBeenCalled();
    expect(messagesCreate).not.toHaveBeenCalled();
  });

  it("calls the MiniMax Anthropic-compatible endpoint with the default model when keyed", async () => {
    process.env.MINIMAX_API_KEY = "mm-test-key";
    messagesCreate.mockResolvedValue({
      content: [{ type: "text", text: "What's your top goal?" }],
    });

    const reply = await minimaxLLM(INPUT);

    expect(reply).toBe("What's your top goal?");
    expect(AnthropicCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "mm-test-key",
        baseURL: "https://api.minimaxi.com/anthropic",
      }),
    );
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "MiniMax-M3", system: INPUT.system }),
    );
  });

  it("honors MINIMAX_MODEL and MINIMAX_BASE_URL overrides", async () => {
    process.env.MINIMAX_API_KEY = "mm-test-key";
    process.env.MINIMAX_MODEL = "MiniMax-M2.5";
    process.env.MINIMAX_BASE_URL = "https://example.test/anthropic";
    messagesCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    await minimaxLLM(INPUT);

    expect(AnthropicCtor).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://example.test/anthropic" }),
    );
    expect(messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "MiniMax-M2.5" }),
    );
  });

  it("ignores non-text (thinking) blocks and joins text output", async () => {
    process.env.MINIMAX_API_KEY = "mm-test-key";
    messagesCreate.mockResolvedValue({
      content: [
        { type: "thinking", thinking: "reasoning…" },
        { type: "text", text: "Line 1" },
        { type: "text", text: "Line 2" },
      ],
    });

    const reply = await minimaxLLM(INPUT);
    expect(reply).toBe("Line 1\nLine 2");
  });
});
