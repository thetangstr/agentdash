import { describe, expect, it } from "vitest";
import {
  buildConnectCommand,
  buildWatchPrompt,
  describeCodeLife,
  resolveInstanceOrigin,
} from "./connect-terminal-copy";

describe("resolveInstanceOrigin", () => {
  it("prefers the operator's configured URL over whatever is in the address bar", () => {
    expect(resolveInstanceOrigin("https://mk.example.ts.net:3112", "http://192.168.1.9:3112")).toBe(
      "https://mk.example.ts.net:3112",
    );
  });

  it("falls back to the browser origin when nothing is configured", () => {
    expect(resolveInstanceOrigin(null, "http://mkmini.local:3103")).toBe("http://mkmini.local:3103");
    expect(resolveInstanceOrigin("   ", "http://mkmini.local:3103")).toBe("http://mkmini.local:3103");
  });
});

describe("buildConnectCommand", () => {
  it("carries the code and the instance, so nothing else must be typed", () => {
    const line = buildConnectCommand("https://mk.example:3112", "KVTX-8F02");
    expect(line).toBe("npx agentdash-connect --url https://mk.example:3112 KVTX-8F02");
  });

  it("is one line", () => {
    expect(buildConnectCommand("https://mk.example:3112", "KVTX-8F02")).not.toContain("\n");
  });
});

describe("describeCodeLife", () => {
  it("counts down while the code is good", () => {
    expect(describeCodeLife(542)).toEqual({ state: "live", label: "works once · expires in 9m 02s" });
  });

  it("warns before it dies, not at the moment it dies", () => {
    expect(describeCodeLife(119).state).toBe("expiring");
    expect(describeCodeLife(121).state).toBe("live");
  });

  it("says expired rather than showing a stopped clock", () => {
    expect(describeCodeLife(0)).toEqual({ state: "expired", label: "expired" });
    expect(describeCodeLife(-5).state).toBe("expired");
  });
});

describe("buildWatchPrompt", () => {
  /**
   * The inbox routes need a `bridge:inbox` endpoint credential. An agent key
   * minted by a connect code is not one, so a prompt pointed at them fails for
   * everybody who follows it.
   */
  it("uses the tools a connect code actually grants, not the inbox routes", () => {
    const prompt = buildWatchPrompt("Casper");
    expect(prompt).toContain("agentdash tools");
    expect(prompt).not.toMatch(/bridge inbox|inbox_sync|inbox_decide/);
  });

  it("demands silence when there is nothing, or people stop reading it", () => {
    expect(buildWatchPrompt("Casper")).toContain("say nothing at all");
  });

  it("keeps the decision with the person", () => {
    const prompt = buildWatchPrompt("Casper");
    expect(prompt).toContain("Do not act on any of it");
    expect(prompt).toContain("I decide");
  });

  it("names the agent, so the prompt reads as being about theirs", () => {
    expect(buildWatchPrompt("HAL")).toContain("assigned to HAL");
  });
});
