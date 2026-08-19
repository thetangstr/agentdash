import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_COMMAND, resolveCodexCommand } from "./command.js";

describe("resolveCodexCommand", () => {
  it("defaults to the codex CLI, not the ACP bridge", () => {
    // codex-acp cannot take `exec`, which every invocation this adapter
    // builds starts with. Defaulting to it means no run can ever succeed.
    expect(resolveCodexCommand({}, {})).toBe("codex");
    expect(DEFAULT_CODEX_COMMAND).toBe("codex");
  });

  it("prefers the per-agent adapter config over everything", () => {
    expect(
      resolveCodexCommand({ command: "/opt/homebrew/bin/codex" }, { AGENTDASH_CODEX_COMMAND: "/elsewhere/codex" }),
    ).toBe("/opt/homebrew/bin/codex");
  });

  it("falls back to the host override when the agent says nothing", () => {
    expect(resolveCodexCommand({}, { AGENTDASH_CODEX_COMMAND: "/opt/homebrew/bin/codex" })).toBe(
      "/opt/homebrew/bin/codex",
    );
  });

  it("ignores blank values rather than spawning an empty command", () => {
    expect(resolveCodexCommand({ command: "   " }, { AGENTDASH_CODEX_COMMAND: "  " })).toBe("codex");
  });
});

describe("DEFAULT_CODEX_LOCAL_MODEL", () => {
  it("is a model a ChatGPT-account login will actually accept", async () => {
    // gpt-5.3-codex is refused outright by Codex when the login is a ChatGPT
    // account — "not supported when using Codex with a ChatGPT account" — so
    // every agent created on such an install was born unable to run.
    const { DEFAULT_CODEX_LOCAL_MODEL, models } = await import("../index.js");
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-terra");
    expect(models.some((m) => m.id === DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
  });

  it("keeps the coding-tuned lane selectable for API-key installs", async () => {
    const { models } = await import("../index.js");
    expect(models.some((m) => m.id === "gpt-5.3-codex")).toBe(true);
  });
});
