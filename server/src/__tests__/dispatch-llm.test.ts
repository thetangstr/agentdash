import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpError } from "../errors.js";

const anthropicLLM = vi.hoisted(() => vi.fn(async () => "anthropic fallback"));
const minimaxLLM = vi.hoisted(() => vi.fn(async () => "minimax reply"));
const openaiCompatLLMDetailed = vi.hoisted(() =>
  vi.fn(async () => ({ text: "openai_compat reply" }) as { text: string; usage?: unknown }),
);
const createEvent = vi.hoisted(() => vi.fn(async () => ({})));
const costService = vi.hoisted(() => vi.fn(() => ({ createEvent })));

vi.mock("../services/anthropic-llm.js", () => ({
  anthropicLLM,
}));

vi.mock("../services/minimax-llm.js", () => ({
  minimaxLLM,
}));

vi.mock("../services/openai-compat-llm.js", () => ({
  openaiCompatLLMDetailed,
}));

vi.mock("../services/costs.js", () => ({
  costService,
}));

import { dispatchLLM } from "../services/dispatch-llm.js";

const originalAdapter = process.env.AGENTDASH_DEFAULT_ADAPTER;
const originalSkipLLM = process.env.PAPERCLIP_E2E_SKIP_LLM;

describe("dispatchLLM", () => {
  beforeEach(() => {
    anthropicLLM.mockClear();
    minimaxLLM.mockClear();
    minimaxLLM.mockResolvedValue("minimax reply");
    openaiCompatLLMDetailed.mockClear();
    openaiCompatLLMDetailed.mockResolvedValue({ text: "openai_compat reply" });
    createEvent.mockClear();
    costService.mockClear();
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
    expect(openaiCompatLLMDetailed).toHaveBeenCalledTimes(1);
    expect(anthropicLLM).not.toHaveBeenCalled();
  });

  it("falls back to claude_api when the openai_compat adapter throws", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "openai_compat";
    openaiCompatLLMDetailed.mockRejectedValueOnce(new Error("openrouter 500"));

    const reply = await dispatchLLM({
      system: "You are a Chief of Staff.",
      messages: [{ role: "user", content: "Help me hire agents." }],
    });

    expect(reply).toBe("anthropic fallback");
    expect(openaiCompatLLMDetailed).toHaveBeenCalledTimes(1);
    expect(anthropicLLM).toHaveBeenCalledTimes(1);
  });

  it("meters openai_compat usage via cost_events when a meter is provided (G3)", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "openai_compat";
    openaiCompatLLMDetailed.mockResolvedValueOnce({
      text: "Routed reply.",
      usage: {
        model: "openai/gpt-4o-mini",
        promptTokens: 120,
        completionTokens: 30,
        costUsd: 0.07,
      },
    });
    const fakeDb = {} as never;

    const reply = await dispatchLLM(
      { system: "s", messages: [{ role: "user", content: "hi" }] },
      { db: fakeDb, companyId: "co-1", agentId: "ag-1" },
    );

    expect(reply).toBe("Routed reply.");
    expect(costService).toHaveBeenCalledWith(fakeDb);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({
        agentId: "ag-1",
        provider: "openai_compat",
        billingType: "usage",
        model: "openai/gpt-4o-mini",
        inputTokens: 120,
        outputTokens: 30,
        costCents: 7, // 0.07 USD => 7 cents
      }),
    );
  });

  it("does not meter when no meter context is provided", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "openai_compat";
    openaiCompatLLMDetailed.mockResolvedValueOnce({
      text: "Routed reply.",
      usage: { model: "m", promptTokens: 1, completionTokens: 1, costUsd: 1 },
    });

    await dispatchLLM({ system: "s", messages: [{ role: "user", content: "hi" }] });

    expect(createEvent).not.toHaveBeenCalled();
  });

  it("never fails the reply when metering throws (non-fatal)", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "openai_compat";
    openaiCompatLLMDetailed.mockResolvedValueOnce({
      text: "Routed reply.",
      usage: { model: "m", promptTokens: 1, completionTokens: 1, costUsd: 1 },
    });
    createEvent.mockRejectedValueOnce(new Error("db down"));

    const reply = await dispatchLLM(
      { system: "s", messages: [{ role: "user", content: "hi" }] },
      { db: {} as never, companyId: "co-1", agentId: "ag-1" },
    );

    expect(reply).toBe("Routed reply.");
  });
});
