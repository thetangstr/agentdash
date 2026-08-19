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
  // The codex chat branch imports the codex adapter's JSONL parser, and that
  // module's neighbours reach for execFile at import time. Mocking the module
  // means providing everything the import graph touches, not only what this
  // file drives.
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
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

import { dispatchLLM, stripHermesChatter } from "../services/dispatch-llm.js";

const originalAdapter = process.env.AGENTDASH_DEFAULT_ADAPTER;
const originalHermesCommand = process.env.AGENTDASH_HERMES_COMMAND;
const originalSkipLLM = process.env.PAPERCLIP_E2E_SKIP_LLM;
const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

describe("dispatchLLM", () => {
  beforeEach(() => {
    // A fallback happens only when one is configured AND it can actually
    // answer. These cases are about routing, so name a fallback and give it a
    // key; the cases about the refusing-to-stub behaviour clear them explicitly.
    process.env.AGENTDASH_FALLBACK_ADAPTER = "claude_api";
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
      expect.arrayContaining(["chat", "-q", expect.stringContaining("Draft a rollout plan."), "-Q"]),
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  /**
   * Least privilege for a process that reads untrusted agent output.
   *
   * The prompt handed to Hermes contains other agents' answers — text this
   * system wraps in `<untrusted-agent-answer>` because it may be adversarial.
   * Hermes enables terminal, file, code_execution, browser and computer_use by
   * default, and `spawn` inherits the server's environment unless told not to.
   * Together that made one prompt injection equal to code execution on the
   * AgentDash host holding the agent-JWT signing secret.
   */
  describe("hermes_local runs with least privilege", () => {
    function spawnArgs(): string[] {
      return spawnMock.mock.calls[0][1] as string[];
    }
    function spawnEnv(): Record<string, string | undefined> {
      return (spawnMock.mock.calls[0][2] as { env: Record<string, string | undefined> }).env;
    }

    it("grants only a restricted toolset, never the default shell-capable set", async () => {
      process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
      await dispatchLLM({ system: "s", messages: [{ role: "user", content: "hi" }] });

      const args = spawnArgs();
      expect(args, "no toolset restriction was passed").toContain("-t");
      const granted = args[args.indexOf("-t") + 1]!.split(",");
      for (const dangerous of ["terminal", "file", "code_execution", "browser", "computer_use"]) {
        expect(granted, `granted the ${dangerous} toolset`).not.toContain(dangerous);
      }
    });

    it("does not inject AGENTS.md, memory or skills into an untrusted context", async () => {
      process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
      await dispatchLLM({ system: "s", messages: [{ role: "user", content: "hi" }] });
      expect(spawnArgs()).toContain("--ignore-rules");
    });

    it("does not hand the server's secrets to the child process", async () => {
      // The specific secrets that made this severe: the JWT secret mints a token
      // for any agent, and DATABASE_URL carries credentials.
      process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
      process.env.PAPERCLIP_AGENT_JWT_SECRET = "jwt-secret-value";
      process.env.DATABASE_URL = "postgres://user:pw@127.0.0.1:5432/db";
      process.env.BETTER_AUTH_SECRET = "auth-secret-value";
      process.env.MINIMAX_API_KEY = "sk-cp-should-not-travel";
      try {
        await dispatchLLM({ system: "s", messages: [{ role: "user", content: "hi" }] });

        const env = spawnEnv();
        for (const leaked of [
          "PAPERCLIP_AGENT_JWT_SECRET",
          "DATABASE_URL",
          "BETTER_AUTH_SECRET",
          "MINIMAX_API_KEY",
        ]) {
          expect(env[leaked], `${leaked} reached the spawned CLI`).toBeUndefined();
        }
      } finally {
        delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
        delete process.env.DATABASE_URL;
        delete process.env.BETTER_AUTH_SECRET;
        delete process.env.MINIMAX_API_KEY;
      }
    });

    it("still passes what the CLI needs to run and find its own config", async () => {
      // Over-tightening is its own outage: without HOME, Hermes cannot read
      // ~/.hermes and every reply fails.
      process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";
      await dispatchLLM({ system: "s", messages: [{ role: "user", content: "hi" }] });

      const env = spawnEnv();
      expect(env.PATH, "no PATH: the binary cannot be found").toBeTruthy();
      expect(env.HOME, "no HOME: the CLI cannot read its own credentials").toBeTruthy();
    });
  });

  /**
   * A locally-spawned adapter must not inherit the server's working directory.
   *
   * `claude --print` starts a full Claude Code session and reads the project it
   * launches in. Running it in the server's cwd hands every agent the operator's
   * repository as context — an agent in a consultancy workspace, asked what to
   * focus on this week, answered "getting license enforcement finished and
   * merged, it's the branch you're on". That is the server's git branch, and an
   * agent that can see it can quote it to a colleague.
   */
  it("spawns local adapters in a neutral directory, not the server's", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "hermes_local";

    await dispatchLLM({
      system: "You are a Chief of Staff.",
      messages: [{ role: "user", content: "Draft a rollout plan." }],
    });

    const options = spawnMock.mock.calls[0][2] as { cwd?: string };
    expect(options.cwd, "no cwd was set, so the adapter inherits the server's").toBeTruthy();
    expect(options.cwd).not.toBe(process.cwd());
  });

  it("rejects unsupported CoS chat adapters instead of silently using claude_api", async () => {
    // Was codex_local until it gained a branch of its own. An adapter the chat
    // path cannot drive must still fail loudly rather than answer as some other
    // model without saying so.
    process.env.AGENTDASH_DEFAULT_ADAPTER = "gemini_local";

    await expect(
      dispatchLLM({
        system: "You are a Chief of Staff.",
        messages: [{ role: "user", content: "Draft a rollout plan." }],
      }),
    ).rejects.toMatchObject({
      status: 501,
      message: expect.stringContaining("gemini_local"),
    } satisfies Partial<HttpError>);

    expect(anthropicLLM).not.toHaveBeenCalled();
  });

  describe("codex_local runs with least privilege", () => {
    function spawnArgs(): string[] {
      return spawnMock.mock.calls[0][1] as string[];
    }

    it("routes CoS replies through codex and returns its final message", async () => {
      spawnMock.mockImplementation(() => {
        const child: any = {
          kill: vi.fn(),
          stdin: { end: vi.fn() },
          stdout: {
            on: vi.fn((event: string, callback: (chunk: Buffer) => void) => {
              if (event === "data") {
                setTimeout(
                  () =>
                    callback(
                      Buffer.from(
                        [
                          JSON.stringify({ type: "thread.started", thread_id: "t1" }),
                          JSON.stringify({
                            type: "item.completed",
                            item: { type: "agent_message", text: "codex reply" },
                          }),
                        ].join("\n"),
                      ),
                    ),
                  0,
                );
              }
              return child.stdout;
            }),
          },
          stderr: { on: vi.fn(() => child.stderr) },
          on: vi.fn((event: string, callback: (code: number) => void) => {
            if (event === "close") setTimeout(() => callback(0), 1);
            return child;
          }),
        };
        return child;
      });

      process.env.AGENTDASH_DEFAULT_ADAPTER = "codex_local";
      const reply = await dispatchLLM({ system: "s", messages: [{ role: "user", content: "hi" }] });

      expect(reply).toBe("codex reply");
      expect(spawnMock.mock.calls[0][0]).toBe("codex");
      expect(spawnArgs()).toContain("exec");
    });

    it("never hands untrusted content a writable sandbox", async () => {
      // The prompt carries other agents' output, which this system wraps in
      // <untrusted-agent-answer> precisely because it may be adversarial. Codex
      // agent RUNS bypass the sandbox deliberately; a chat reply must not.
      process.env.AGENTDASH_DEFAULT_ADAPTER = "codex_local";
      await dispatchLLM({ system: "s", messages: [{ role: "user", content: "hi" }] });

      const args = spawnArgs();
      expect(args).toContain("--sandbox");
      expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("--yolo");
    });

    it("asks for a model a ChatGPT-account login accepts", async () => {
      process.env.AGENTDASH_DEFAULT_ADAPTER = "codex_local";
      await dispatchLLM({ system: "s", messages: [{ role: "user", content: "hi" }] });

      const args = spawnArgs();
      expect(args).toContain("--model");
      expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.6-terra");
    });
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
  const originalFallbackEnv = process.env.AGENTDASH_FALLBACK_ADAPTER;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.AGENTDASH_FALLBACK_ADAPTER;
    anthropicLLM.mockClear();
    // This block previously left `minimaxLLM` alone, so its call count and any
    // queued rejection leaked between cases here. Harmless while no assertion
    // counted minimax calls; not harmless for the loop guard below, which is
    // precisely a claim about how many times an adapter is invoked.
    minimaxLLM.mockClear();
    minimaxLLM.mockResolvedValue("minimax reply");
    spawnMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
    if (originalAdapterEnv === undefined) delete process.env.AGENTDASH_DEFAULT_ADAPTER;
    else process.env.AGENTDASH_DEFAULT_ADAPTER = originalAdapterEnv;
    if (originalFallbackEnv === undefined) delete process.env.AGENTDASH_FALLBACK_ADAPTER;
    else process.env.AGENTDASH_FALLBACK_ADAPTER = originalFallbackEnv;
  });

  const input = { system: "s", messages: [{ role: "user" as const, content: "hi" }] };

  it("throws instead of stubbing when an adapter fails and no fallback is named", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "claude_local";
    spawnMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    await expect(dispatchLLM(input)).rejects.toThrow(/no AGENTDASH_FALLBACK_ADAPTER/);
    expect(anthropicLLM, "the stub was reached anyway").not.toHaveBeenCalled();
  });

  it("does not reach for Anthropic when no fallback was configured", async () => {
    // The point of the change: a deployment that chose MiniMax and said nothing
    // about a fallback must not quietly answer from Claude on someone's key.
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";
    minimaxLLM.mockRejectedValueOnce(new Error("minimax 500"));

    await expect(dispatchLLM(input)).rejects.toThrow(/no AGENTDASH_FALLBACK_ADAPTER/);
    expect(anthropicLLM, "fell through to Anthropic unasked").not.toHaveBeenCalled();
  });

  it("refuses a fallback that names the failed adapter, rather than looping", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";
    process.env.AGENTDASH_FALLBACK_ADAPTER = "minimax";
    minimaxLLM.mockRejectedValue(new Error("minimax 500"));

    await expect(dispatchLLM(input)).rejects.toThrow(/same adapter/);
    expect(minimaxLLM, "retried the adapter that just failed").toHaveBeenCalledTimes(1);
  });

  it("names the adapter and the underlying cause, so the log says what broke", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "claude_local";
    spawnMock.mockImplementation(() => {
      throw new Error("claude timed out after 45000ms");
    });

    await expect(dispatchLLM(input)).rejects.toThrow(/claude_local/);
    await expect(dispatchLLM(input)).rejects.toThrow(/timed out/);
  });

  it("throws when a hosted adapter fails with nothing to fall back to", async () => {
    process.env.AGENTDASH_DEFAULT_ADAPTER = "minimax";
    minimaxLLM.mockRejectedValueOnce(new Error("minimax 500"));

    await expect(dispatchLLM(input)).rejects.toThrow(/Refusing to answer with placeholder text/);
    expect(anthropicLLM).not.toHaveBeenCalled();
  });

  it("still falls back normally once one is configured and usable", async () => {
    // The fallback is useful when there is something to fall back to — this
    // guards against over-correcting into "never fall back".
    process.env.AGENTDASH_FALLBACK_ADAPTER = "claude_api";
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

/**
 * Hermes writes status lines to stdout, not stderr, even under `-Q`.
 *
 * The first string below is the one that actually reached a colleague's thread
 * on the mkboard instance: a correct answer wearing a security-scanner warning,
 * because the adapter treats all of stdout as the agent's words.
 */
describe("stripHermesChatter", () => {
  it("drops the warning Hermes printed into a real agent reply", () => {
    const observed =
      "  ⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only\r\n" +
      "Put weekly revenue versus plan on the board deck; what outcome must MKThink achieve in the next 0–3 months?";

    expect(stripHermesChatter(observed)).toBe(
      "Put weekly revenue versus plan on the board deck; what outcome must MKThink achieve in the next 0–3 months?",
    );
  });

  it("leaves an ordinary answer untouched", () => {
    expect(stripHermesChatter("Revenue versus plan.")).toBe("Revenue versus plan.");
  });

  it("keeps a status glyph that appears inside the answer body", () => {
    // Only a LEADING run is chatter. An answer that discusses a warning is
    // still the answer, and truncating it would be worse than the noise.
    const reply = "Two risks:\n⚠ schedule slip on Northgate\n✓ Riverside on track";
    expect(stripHermesChatter(reply)).toBe(reply);
  });

  it("strips several leading status lines but stops at the answer", () => {
    const out = "✓ loaded config\r\n  ⚠ scanner unavailable\r\nThe answer.\n⚠ not chatter";
    expect(stripHermesChatter(out)).toBe("The answer.\n⚠ not chatter");
  });

  it("returns empty when Hermes emitted only chatter, so the caller can fail loudly", () => {
    // Empty routes to the existing empty-reply path rather than posting a
    // warning as though it were the agent's turn.
    expect(stripHermesChatter("  ⚠ scanner unavailable\r\n")).toBe("");
  });
});
