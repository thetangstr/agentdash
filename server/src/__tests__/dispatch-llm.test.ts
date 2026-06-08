import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpError } from "../errors.js";

const anthropicLLM = vi.hoisted(() => vi.fn(async () => "anthropic fallback"));
const minimaxLLM = vi.hoisted(() => vi.fn(async () => "minimax reply"));
const openaiCompatLLM = vi.hoisted(() => vi.fn(async () => "openai_compat reply"));

vi.mock("../services/anthropic-llm.js", () => ({
  anthropicLLM,
}));

vi.mock("../services/minimax-llm.js", () => ({
  minimaxLLM,
}));

vi.mock("../services/openai-compat-llm.js", () => ({
  openaiCompatLLM,
}));

import { dispatchLLM } from "../services/dispatch-llm.js";

const originalAdapter = process.env.AGENTDASH_DEFAULT_ADAPTER;
const originalSkipLLM = process.env.PAPERCLIP_E2E_SKIP_LLM;

describe("dispatchLLM", () => {
  beforeEach(() => {
    anthropicLLM.mockClear();
    minimaxLLM.mockClear();
    minimaxLLM.mockResolvedValue("minimax reply");
    openaiCompatLLM.mockClear();
    openaiCompatLLM.mockResolvedValue("openai_compat reply");
    delete process.env.PAPERCLIP_E2E_SKIP_LLM;
  });

  afterEach(() => {
    if (originalAdapter === undefined) {
      delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    } else {
      process.env.AGENTDASH_DEFAULT_ADAPTER = originalAdapter;
    }

    if (originalSkipLLM === undefined) {
      delete process.env.PAPERCLIP_E2E_SKIP_LLM;
    } else {
      process.env.PAPERCLIP_E2E_SKIP_LLM = originalSkipLLM;
    }
  });

  it("rejects unsupported CoS chat adapters instead of silently using claude_api", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "codex_local";

    await expect(
      dispatchLLM({
        system: "You are a Chief of Staff.",
        messages: [{ role: "user", content: "Draft a rollout plan." }],
      }),
    ).rejects.toMatchObject({
      status: 501,
      message: expect.stringContaining("codex_local"),
    } satisfies Partial<HttpError>);

    expect(anthropicLLM).not.toHaveBeenCalled();
  });

  it("routes CoS replies through the minimax adapter when selected", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";

    const reply = await dispatchLLM({
      system: "You are a Chief of Staff.",
      messages: [{ role: "user", content: "Help me hire agents." }],
    });

    expect(reply).toBe("minimax reply");
    expect(minimaxLLM).toHaveBeenCalledTimes(1);
    expect(anthropicLLM).not.toHaveBeenCalled();
  });

  it("falls back to claude_api when the minimax adapter throws", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";
    minimaxLLM.mockRejectedValueOnce(new Error("minimax 500"));

    const reply = await dispatchLLM({
      system: "You are a Chief of Staff.",
      messages: [{ role: "user", content: "Help me hire agents." }],
    });

    expect(reply).toBe("anthropic fallback");
    expect(minimaxLLM).toHaveBeenCalledTimes(1);
    expect(anthropicLLM).toHaveBeenCalledTimes(1);
  });

  it("falls back to claude_api when the minimax adapter returns empty", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";
    minimaxLLM.mockResolvedValueOnce("");

    const reply = await dispatchLLM({
      system: "You are a Chief of Staff.",
      messages: [{ role: "user", content: "Help me hire agents." }],
    });

    expect(reply).toBe("anthropic fallback");
    expect(anthropicLLM).toHaveBeenCalledTimes(1);
  });

  it("routes CoS replies through the openai_compat adapter when selected", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "openai_compat";

    const reply = await dispatchLLM({
      system: "You are a Chief of Staff.",
      messages: [{ role: "user", content: "Help me hire agents." }],
    });

    expect(reply).toBe("openai_compat reply");
    expect(openaiCompatLLM).toHaveBeenCalledTimes(1);
    expect(anthropicLLM).not.toHaveBeenCalled();
  });

  it("falls back to claude_api when the openai_compat adapter throws", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "openai_compat";
    openaiCompatLLM.mockRejectedValueOnce(new Error("openrouter 500"));

    const reply = await dispatchLLM({
      system: "You are a Chief of Staff.",
      messages: [{ role: "user", content: "Help me hire agents." }],
    });

    expect(reply).toBe("anthropic fallback");
    expect(openaiCompatLLM).toHaveBeenCalledTimes(1);
    expect(anthropicLLM).toHaveBeenCalledTimes(1);
  });
});
