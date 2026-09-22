import { describe, expect, it } from "vitest";
import {
  buildConnectCommand,
  buildWatchPrompt,
  describeCodeLife,
  pointsElsewhere,
  resolveInstanceOrigin,
  resolveOriginChoices,
} from "./connect-terminal-copy";

describe("resolveOriginChoices", () => {
  const PUBLISHED = "http://mkmini.local:3102";
  const TAILNET = "https://mkthinks-mac-mini.tail112187.ts.net:3112";

  it("offers the published address when it is also the one you came through", () => {
    const choices = resolveOriginChoices(PUBLISHED, PUBLISHED);
    expect(choices).toHaveLength(1);
    expect(choices[0]!.url).toBe(PUBLISHED);
  });

  /**
   * The whole point of the change. A steward reading the page over the tailnet
   * used to be handed the tailnet address, which is precisely the address the
   * colleague they are pairing cannot reach. There is now one answer and the
   * reader does not get to make it worse.
   */
  it("gives the published address even when the reader arrived by another door", () => {
    const choices = resolveOriginChoices(PUBLISHED, TAILNET);
    expect(choices).toHaveLength(1);
    expect(choices[0]!.url).toBe(PUBLISHED);
    expect(choices[0]!.kind).toBe("published");
    expect(resolveInstanceOrigin(PUBLISHED, TAILNET)).toBe(PUBLISHED);
  });

  /**
   * Superseded on purpose. An earlier release defaulted to the reader's own
   * address on field evidence — a remote steward's VPN could not resolve the
   * published LAN name. That failure is real and has not gone away; it is now
   * the operator's to fix in PAPERCLIP_PUBLIC_URL rather than each reader's to
   * rediscover, and `pointsElsewhere` is what tells them it happened.
   */
  it("says when the command points somewhere other than this reader's door", () => {
    expect(pointsElsewhere(PUBLISHED, TAILNET)).toBe(true);
    expect(pointsElsewhere(PUBLISHED, PUBLISHED)).toBe(false);
    expect(pointsElsewhere(PUBLISHED, "http://MKMini.local:3102/")).toBe(false);
    expect(pointsElsewhere(null, TAILNET)).toBe(false);
    expect(pointsElsewhere(PUBLISHED, "")).toBe(false);
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
