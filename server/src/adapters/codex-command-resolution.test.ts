import { afterEach, describe, expect, it } from "vitest";
import { normalizeHermesConfig } from "./registry.js";

describe("normalizeHermesConfig Codex command fallback", () => {
  const originalEnv = process.env.AGENTDASH_CODEX_COMMAND;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENTDASH_CODEX_COMMAND;
    else process.env.AGENTDASH_CODEX_COMMAND = originalEnv;
  });

  it("uses a PATH-resolvable codex-acp command instead of a developer-specific path", () => {
    delete process.env.AGENTDASH_CODEX_COMMAND;
    const ctx = { config: {} as Record<string, unknown> };

    normalizeHermesConfig(ctx);

    expect(ctx.config.command).toBe("codex-acp");
    expect(String(ctx.config.command).startsWith("/Users/")).toBe(false);
    expect(String(ctx.config.command)).not.toContain("maxiaoer");
  });

  it("honors AGENTDASH_CODEX_COMMAND", () => {
    process.env.AGENTDASH_CODEX_COMMAND = "/opt/codex-acp";
    const ctx = { config: {} as Record<string, unknown> };

    normalizeHermesConfig(ctx);

    expect(ctx.config.command).toBe("/opt/codex-acp");
  });

  it("preserves an explicitly configured command", () => {
    process.env.AGENTDASH_CODEX_COMMAND = "/opt/fallback-codex-acp";
    const ctx = { config: { command: "/custom/codex-acp" } };

    normalizeHermesConfig(ctx);

    expect(ctx.config.command).toBe("/custom/codex-acp");
  });
});
