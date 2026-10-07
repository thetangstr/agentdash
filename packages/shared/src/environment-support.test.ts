import { describe, expect, it } from "vitest";
import {
  getAdapterEnvironmentSupport,
  getEnvironmentCapabilities,
  isEnvironmentDriverSupportedForAdapter,
  isSandboxProviderSupportedForAdapter,
  supportedEnvironmentDriversForAdapter,
} from "./environment-support.js";

describe("isSandboxProviderSupportedForAdapter", () => {
  it("accepts additional sandbox providers for remote-managed adapters", () => {
    expect(
      isSandboxProviderSupportedForAdapter("codex_local", "fake-plugin", ["fake-plugin"]),
    ).toBe(true);
  });

  it("rejects providers for adapters without remote-managed environment support", () => {
    expect(
      isSandboxProviderSupportedForAdapter("openclaw", "fake-plugin", ["fake-plugin"]),
    ).toBe(false);
  });
});

describe("hermes_local SSH capability (AGENTDASH_HERMES_SSH_ENABLED)", () => {
  it("keeps hermes_local local-only when the instance flag is off (default)", () => {
    expect(supportedEnvironmentDriversForAdapter("hermes_local")).toEqual(["local"]);
    expect(supportedEnvironmentDriversForAdapter("hermes_local", { hermesSshEnabled: false })).toEqual(["local"]);
    expect(isEnvironmentDriverSupportedForAdapter("hermes_local", "ssh")).toBe(false);
    expect(getAdapterEnvironmentSupport("hermes_local").drivers.ssh).toBe("unsupported");
    const caps = getEnvironmentCapabilities(["hermes_local"]);
    expect(caps.adapters[0]?.drivers).toEqual({
      local: "supported",
      ssh: "unsupported",
      sandbox: "unsupported",
      plugin: "unsupported",
    });
  });

  it("adds ssh (and only ssh) for hermes_local when the instance flag is on", () => {
    const options = { hermesSshEnabled: true };
    expect(supportedEnvironmentDriversForAdapter("hermes_local", options)).toEqual(["local", "ssh"]);
    expect(isEnvironmentDriverSupportedForAdapter("hermes_local", "ssh", options)).toBe(true);
    expect(isEnvironmentDriverSupportedForAdapter("hermes_local", "sandbox", options)).toBe(false);
    expect(isSandboxProviderSupportedForAdapter("hermes_local", "fake-plugin", ["fake-plugin"])).toBe(false);
    const caps = getEnvironmentCapabilities(["hermes_local"], { hermesSshEnabled: true });
    expect(caps.adapters[0]?.drivers).toEqual({
      local: "supported",
      ssh: "supported",
      sandbox: "unsupported",
      plugin: "unsupported",
    });
  });

  it("does not change any other adapter's matrix", () => {
    for (const options of [{}, { hermesSshEnabled: true }]) {
      expect(supportedEnvironmentDriversForAdapter("claude_local", options)).toEqual(["local", "ssh", "sandbox"]);
      expect(supportedEnvironmentDriversForAdapter("openclaw", options)).toEqual(["local"]);
      expect(supportedEnvironmentDriversForAdapter("process", options)).toEqual(["local"]);
    }
  });
});
