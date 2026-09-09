import { describe, expect, it } from "vitest";
import {
  buildConnectCommand,
  buildWatchPrompt,
  describeCodeLife,
  resolveInstanceOrigin,
  resolveOriginChoices,
} from "./connect-terminal-copy";

describe("resolveOriginChoices", () => {
  const PUBLISHED = "http://mkmini.local:3102";
  const TAILNET = "https://mkthinks-mac-mini.tail112187.ts.net:3112";

  /**
   * The common case, and it must stay invisible. A steward on the office LAN
   * reaches the box at the published address, so there is nothing to decide and
   * no control should appear.
   */
  it("offers nothing to choose when both addresses agree", () => {
    const choices = resolveOriginChoices(PUBLISHED, PUBLISHED);
    expect(choices).toHaveLength(1);
    expect(choices[0]!.url).toBe(PUBLISHED);
  });

  it("treats a trailing slash and case as the same address", () => {
    expect(resolveOriginChoices(PUBLISHED, "http://MKMini.local:3102/")).toHaveLength(1);
  });

  /** Someone on the tailnet: the published LAN address is not how they got here. */
  it("offers both when the door they came through is not the published one", () => {
    const choices = resolveOriginChoices(PUBLISHED, TAILNET);
    expect(choices.map((c) => c.url)).toEqual([PUBLISHED, TAILNET]);
    expect(choices.map((c) => c.kind)).toEqual(["published", "current"]);
  });

  /**
   * The ordering is a safety property, not a preference. The command gets
   * forwarded to colleagues, and a URL captured from whichever door happened to
   * be open ends up in someone else's config where it silently stops working.
   * Whoever took the unusual door is the one who can see they did.
   */
  it("puts the shared address first, so the default is the forwardable one", () => {
    expect(resolveOriginChoices(PUBLISHED, TAILNET)[0]!.kind).toBe("published");
    expect(resolveInstanceOrigin(PUBLISHED, TAILNET)).toBe(PUBLISHED);
  });

  it("falls back to the browser address when nothing is published", () => {
    expect(resolveOriginChoices(null, TAILNET)).toEqual([
      { url: TAILNET, kind: "current", label: "The address you are using now" },
    ]);
    expect(resolveInstanceOrigin("   ", TAILNET)).toBe(TAILNET);
  });

  it("survives having neither", () => {
    expect(resolveOriginChoices(null, "")).toEqual([]);
    expect(resolveInstanceOrigin(null, "")).toBe("");
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
