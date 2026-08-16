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
    expect(settings.spec).toEqual({ homeDir: os.homedir(), egress: "loopback", readWritePaths: [] });
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

  it("does not check the platform when the sandbox is off", () => {
    // A Linux host with the sandbox off is a supported configuration; only
    // ASKING for confinement there is an error.
    expect(() => resolveAgentSandboxSettings({}, "linux")).not.toThrow();
  });
});
