import { afterEach, describe, expect, it } from "vitest";
import { getHermesCommandFromContext } from "./registry.js";

// Regression guard for the Hermes command fallback. It previously hardcoded a
// developer-specific absolute path (/Users/<someone>/.local/bin/hermes), which
// ENOENT'd on any other machine whenever an agent had no config. The fallback
// must be a PATH-resolvable command (honoring AGENTDASH_HERMES_COMMAND), never
// an absolute home-directory path.
describe("getHermesCommandFromContext", () => {
  const originalEnv = process.env.AGENTDASH_HERMES_COMMAND;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AGENTDASH_HERMES_COMMAND;
    else process.env.AGENTDASH_HERMES_COMMAND = originalEnv;
  });

  it("prefers an explicit config.hermesCommand", () => {
    expect(getHermesCommandFromContext({ config: { hermesCommand: "/opt/hermes" } })).toBe("/opt/hermes");
  });

  it("prefers the agent's adapterConfig.hermesCommand when config is absent", () => {
    expect(getHermesCommandFromContext({ agent: { adapterConfig: { hermesCommand: "/opt/a" } } })).toBe("/opt/a");
  });

  it("falls back to a PATH-resolvable command (no absolute home path) when nothing is configured", () => {
    delete process.env.AGENTDASH_HERMES_COMMAND;
    const cmd = getHermesCommandFromContext({});
    expect(cmd).toBe("hermes");
    expect(cmd.startsWith("/Users/")).toBe(false);
    expect(cmd).not.toContain("maxiaoer");
  });

  it("honors AGENTDASH_HERMES_COMMAND in the fallback", () => {
    process.env.AGENTDASH_HERMES_COMMAND = "/custom/hermes";
    expect(getHermesCommandFromContext({})).toBe("/custom/hermes");
  });
});
