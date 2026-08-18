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
