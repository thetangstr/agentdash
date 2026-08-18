import os from "node:os";
import { describe, expect, it } from "vitest";
import { resolveAgentSandboxSettings } from "../services/agent-sandbox-config.js";

/**
 * The settings that decide whether agents run confined.
 *
 * The cases that matter here are the refusals. A misconfigured security control
 * that quietly falls back to "off" is worse than one that stops the server,
 * because the operator reads their own config, sees confinement requested, and
 * believes it. Every invalid input below is expected to throw rather than
 * degrade.
 */

describe("resolveAgentSandboxSettings", () => {
  it("is off when unset — agents run as they always have", () => {
    const settings = resolveAgentSandboxSettings({}, "darwin");
    expect(settings.spec).toBeNull();
    expect(settings.summary).toMatch(/off/);
  });

  it.each(["off", "false", "0", "  "])("treats %j as off", (value) => {
    expect(resolveAgentSandboxSettings({ AGENTDASH_AGENT_SANDBOX: value }, "darwin").spec).toBeNull();
  });

  it("builds a spec for a valid egress policy", () => {
    const settings = resolveAgentSandboxSettings({ AGENTDASH_AGENT_SANDBOX: "loopback" }, "darwin");
    expect(settings.spec).toEqual({ homeDir: os.homedir(), egress: "loopback", readWritePaths: [], readOnlyPaths: [] });
    expect(settings.summary).toMatch(/on \(egress=loopback\)/);
  });

  it("refuses a typo rather than falling back to off", () => {
    // The whole point. "lopback" must not mean "unconfined".
    expect(() => resolveAgentSandboxSettings({ AGENTDASH_AGENT_SANDBOX: "lopback" }, "darwin")).toThrow(
      /not a valid setting/,
    );
    expect(() => resolveAgentSandboxSettings({ AGENTDASH_AGENT_SANDBOX: "on" }, "darwin")).toThrow(
      /not a valid setting/,
    );
    expect(() => resolveAgentSandboxSettings({ AGENTDASH_AGENT_SANDBOX: "true" }, "darwin")).toThrow(
      /not a valid setting/,
    );
  });

  it("refuses to run confined-by-request on a host that cannot confine", () => {
    expect(() => resolveAgentSandboxSettings({ AGENTDASH_AGENT_SANDBOX: "loopback" }, "linux")).toThrow(
      /has no fallback/,
    );
  });

  it("carries extra read-write paths through", () => {
    const settings = resolveAgentSandboxSettings(
      { AGENTDASH_AGENT_SANDBOX: "direct", AGENTDASH_AGENT_SANDBOX_ALLOW: "/opt/a:/opt/b" },
      "darwin",
    );
    expect(settings.spec?.readWritePaths).toEqual(["/opt/a", "/opt/b"]);
    // Named in the summary so the startup log states where the holes are,
    // rather than leaving an operator to read the profile to find out.
    expect(settings.summary).toContain("/opt/a");
    expect(settings.summary).toContain("/opt/b");
  });

  it("refuses a relative path in the allow list", () => {
    // A relative entry cannot be expressed in SBPL and would be rejected deep
    // inside profile construction, on the first agent run, as a failed run.
    expect(() =>
      resolveAgentSandboxSettings(
        { AGENTDASH_AGENT_SANDBOX: "loopback", AGENTDASH_AGENT_SANDBOX_ALLOW: "relative/path" },
        "darwin",
      ),
    ).toThrow(/absolute paths/);
  });

  it("ignores empty entries in the allow list", () => {
    const settings = resolveAgentSandboxSettings(
      { AGENTDASH_AGENT_SANDBOX: "loopback", AGENTDASH_AGENT_SANDBOX_ALLOW: "/opt/a::" },
      "darwin",
    );
    expect(settings.spec?.readWritePaths).toEqual(["/opt/a"]);
  });

  it("carries a synthetic HOME through, and names it in the summary", () => {
    // The point of the setting: a tool that probes $HOME on startup (mcporter
    // does, and died confined on the operator's ~/.claude/settings.json) finds
    // this directory instead. Named in the summary because a child running
    // with a different home than the server is exactly the kind of surprise an
    // operator should read at startup, not discover while debugging.
    const settings = resolveAgentSandboxSettings(
      {
        AGENTDASH_AGENT_SANDBOX: "direct",
        AGENTDASH_AGENT_SANDBOX_HOME: "/opt/agent-home",
      },
      "darwin",
    );
    expect(settings.spec?.syntheticHomeDir).toBe("/opt/agent-home");
    expect(settings.summary).toContain("/opt/agent-home");
  });

  it("leaves the synthetic home unset when the variable is absent or blank", () => {
    // Absent must mean "the child keeps the real HOME", not "the child gets an
    // empty string as its home" — an empty HOME makes every tool resolve `~`
    // to the process cwd and fail somewhere unrelated.
    for (const env of [{}, { AGENTDASH_AGENT_SANDBOX_HOME: "   " }]) {
      const settings = resolveAgentSandboxSettings(
        { AGENTDASH_AGENT_SANDBOX: "loopback", ...env },
        "darwin",
      );
      expect(settings.spec).not.toHaveProperty("syntheticHomeDir");
    }
  });

  it("refuses a relative synthetic home", () => {
    expect(() =>
      resolveAgentSandboxSettings(
        { AGENTDASH_AGENT_SANDBOX: "loopback", AGENTDASH_AGENT_SANDBOX_HOME: "agent-home" },
        "darwin",
      ),
    ).toThrow(/absolute path/);
  });

  it("refuses a synthetic home that would swallow the home deny", () => {
    // The dangerous typo. The synthetic home is re-opened READ-WRITE below the
    // `(deny ... (subpath "$HOME"))` rule, and later rules win in SBPL — so
    // pointing it at the real home (or any ancestor) emits a profile that
    // parses, loads, reports success and confines nothing. Refuse at startup,
    // where the variable's own name is in the message.
    const home = os.homedir();
    for (const candidate of [home, "/", home.slice(0, home.lastIndexOf("/")) || "/"]) {
      expect(() =>
        resolveAgentSandboxSettings(
          { AGENTDASH_AGENT_SANDBOX: "direct", AGENTDASH_AGENT_SANDBOX_HOME: candidate },
          "darwin",
        ),
      ).toThrow(/silently disable the sandbox/);
    }
  });

  it("does not check the platform when the sandbox is off", () => {
    // A Linux host with the sandbox off is a supported configuration; only
    // ASKING for confinement there is an error.
    expect(() => resolveAgentSandboxSettings({}, "linux")).not.toThrow();
  });
});
