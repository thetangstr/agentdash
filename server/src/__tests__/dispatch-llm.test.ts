import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpError } from "../errors.js";

const anthropicLLM = vi.hoisted(() => vi.fn(async () => "anthropic fallback"));
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../services/anthropic-llm.js", () => ({
  anthropicLLM,
}));

import { dispatchLLM } from "../services/dispatch-llm.js";

const originalAdapter = process.env.AGENTDASH_DEFAULT_ADAPTER;
const originalHermesCommand = process.env.AGENTDASH_HERMES_COMMAND;
const originalSkipLLM = process.env.PAPERCLIP_E2E_SKIP_LLM;

describe("dispatchLLM", () => {
  beforeEach(() => {
    anthropicLLM.mockClear();
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
});
