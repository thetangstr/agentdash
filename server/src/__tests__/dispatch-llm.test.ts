import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpError } from "../errors.js";

const anthropicLLM = vi.hoisted(() => vi.fn(async () => "anthropic fallback"));
const minimaxLLM = vi.hoisted(() => vi.fn(async () => "minimax reply"));
const openaiCompatLLMDetailed = vi.hoisted(() =>
  vi.fn(async () => ({ text: "openai_compat reply" }) as { text: string; usage?: unknown }),
);
const createEvent = vi.hoisted(() => vi.fn(async () => ({})));
const costService = vi.hoisted(() => vi.fn(() => ({ createEvent })));
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

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
const originalHermesCommand = process.env.AGENTDASH_HERMES_COMMAND;
const originalSkipLLM = process.env.PAPERCLIP_E2E_SKIP_LLM;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

describe("dispatchLLM", () => {
  beforeEach(() => {
    // A fallback to claude_api only happens when claude_api can actually
    // answer. These cases are about routing, so give them a key; the cases that
    // are about the missing-key behaviour clear it explicitly.
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    anthropicLLM.mockClear();
    minimaxLLM.mockClear();
    minimaxLLM.mockResolvedValue("minimax reply");
    openaiCompatLLMDetailed.mockClear();
    openaiCompatLLMDetailed.mockResolvedValue({ text: "openai_compat reply" });
    createEvent.mockClear();
    costService.mockClear();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child: any = {
        kill: vi.fn(),
        stdin: {
          end: vi.fn(),
        },
        stdout: {
          on: vi.fn((event: string, callback: (chunk: Buffer) => void) => {
            if (event === "data") setTimeout(() => callback(Buffer.from("hermes reply")), 0);
            return child.stdout;
          }),
        },
        stderr: {
          on: vi.fn(() => child.stderr),
        },
        on: vi.fn((event: string, callback: (code?: number) => void) => {
          if (event === "close") setTimeout(() => callback(0), 0);
          return child;
        }),
      };
      return child;
    });
    delete process.env.PAPERCLIP_E2E_SKIP_LLM;
    delete process.env.AGENTDASH_HERMES_COMMAND;
  });

  afterEach(() => {
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
    if (originalAdapter === undefined) {
      delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    } else {
      process.env.AGENTDASH_DEFAULT_ADAPTER = originalAdapter;
    }

    if (originalHermesCommand === undefined) {
      delete process.env.AGENTDASH_HERMES_COMMAND;
    } else {
      process.env.AGENTDASH_HERMES_COMMAND = originalHermesCommand;
    }

    if (originalSkipLLM === undefined) {
      delete process.env.PAPERCLIP_E2E_SKIP_LLM;
    } else {
      process.env.PAPERCLIP_E2E_SKIP_LLM = originalSkipLLM;
    }
  });

  it("uses the hermes binary on PATH by default for hermes_local CoS chat", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";

    await expect(
      dispatchLLM({
        system: "You are a Chief of Staff.",
        messages: [{ role: "user", content: "Draft a rollout plan." }],
      }),
    ).resolves.toBe("hermes reply");

    expect(spawnMock).toHaveBeenCalledWith(
      "hermes",
      ["chat", "-q", expect.stringContaining("Draft a rollout plan."), "-Q"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
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

/**
 * A failed adapter must not answer with placeholder text.
 *
 * `anthropicLLM` returns a canned "set ANTHROPIC_API_KEY" line when no key is
 * configured. As the landing spot for someone poking at chat locally that is
 * fine. As a FALLBACK from a failed adapter it is a serious bug: it turns a
 * failure into a plausible-looking agent turn.
 *
 * Observed for real on a cold end-to-end run — `claude_local` hit its timeout,
 * fell through to the keyless fallback, and an agent replied
 * "Got it. (stub reply — set ANTHROPIC_API_KEY…)" to a colleague's question in a
 * team thread. Nothing surfaced the timeout, because the conversation looked
 * like it had worked.
 */
describe("dispatchLLM refuses to answer with placeholder text", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalAdapterEnv = process.env.AGENTDASH_DEFAULT_ADAPTER;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    anthropicLLM.mockClear();
    spawnMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalAdapterEnv === undefined) delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    else process.env.AGENTDASH_DEFAULT_ADAPTER = originalAdapterEnv;
  });

  const input = { system: "s", messages: [{ role: "user" as const, content: "hi" }] };

  it("throws instead of stubbing when a local adapter fails and there is no key", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "claude_local";
    spawnMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    await expect(dispatchLLM(input)).rejects.toThrow(/no ANTHROPIC_API_KEY is set to fall back to/);
    expect(anthropicLLM, "the stub was reached anyway").not.toHaveBeenCalled();
  });

  it("names the adapter and the underlying cause, so the log says what broke", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "claude_local";
    spawnMock.mockImplementation(() => {
      throw new Error("claude timed out after 45000ms");
    });

    await expect(dispatchLLM(input)).rejects.toThrow(/claude_local/);
    await expect(dispatchLLM(input)).rejects.toThrow(/timed out/);
  });

  it("throws when a hosted adapter fails with no key to fall back to", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";
    minimaxLLM.mockRejectedValueOnce(new Error("minimax 500"));

    await expect(dispatchLLM(input)).rejects.toThrow(/Refusing to answer with placeholder text/);
    expect(anthropicLLM).not.toHaveBeenCalled();
  });

  it("still falls back normally once a key exists", async () => {
    // The fallback is useful when there is something to fall back to — this
    // guards against over-correcting into "never fall back".
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";
    minimaxLLM.mockRejectedValueOnce(new Error("minimax 500"));

    await expect(dispatchLLM(input)).resolves.toBe("anthropic fallback");
    expect(anthropicLLM).toHaveBeenCalledTimes(1);
  });

  it("leaves the direct claude_api path stubbing for keyless local dev", async () => {
    // Someone running chat locally with no keys should still get a reply and a
    // clear hint — that path never pretended an adapter had succeeded.
    process.env.AGENTDASH_DEFAULT_ADAPTER = "claude_api";

    await expect(dispatchLLM(input)).resolves.toBe("anthropic fallback");
  });
});
