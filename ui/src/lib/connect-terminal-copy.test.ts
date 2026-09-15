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
    expect(choices.map((c) => c.url)).toEqual([TAILNET, PUBLISHED]);
    expect(choices.map((c) => c.kind)).toEqual(["current", "published"]);
  });

  /**
   * REVERSED on field evidence, deliberately. The first ordering defaulted to
   * the published address so a forwarded command would be the shared one — and
   * the first remote steward to use the page hit exactly the failure that
   * default guarantees: the published LAN name does not resolve over a VPN,
   * and he had to notice and switch by hand. The page's own copy says "run
   * this on the machine you work on"; self-use is the dominant case, so the
   * default is the address the reader is provably using, and the forwarding
   * caution lives on the published option's label instead.
   */
  it("defaults to the address the reader is using, not the published one", () => {
    expect(resolveOriginChoices(PUBLISHED, TAILNET)[0]!.kind).toBe("current");
    expect(resolveInstanceOrigin(PUBLISHED, TAILNET)).toBe(TAILNET);
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
    // @latest is load-bearing: a bare name lets npx serve a cached pre-0.2 CLI
    // that silently skips the inbox half of the pairing.
    expect(line).toBe("npx -y agentdash-connect@latest --url https://mk.example:3112 KVTX-8F02");
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
