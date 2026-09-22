import { describe, expect, it } from "vitest";
import {
  buildConnectCommand,
  buildInstallPrompt,
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

describe("buildInstallPrompt", () => {
  const ORIGIN = "http://10.50.10.129:3102";
  const prompt = buildInstallPrompt(ORIGIN, "KVTX-8F02", "Casper");

  it("carries the exact command with the code, so nothing else must be typed", () => {
    expect(prompt).toContain(buildConnectCommand(ORIGIN, "KVTX-8F02"));
    expect(prompt).toContain("exactly as written");
  });

  /** The CLI prints progress first; the outcome is the summary line. */
  it("points Claude at the outcome line, which the CLI prints after its progress", () => {
    expect(prompt).toContain('starts with "Connected."');
  });

  it("names the agent being connected", () => {
    expect(prompt).toContain("my AgentDash agent, Casper");
  });

  /** A code works once: a rerun with a "fixed" command after a partial failure burns it. */
  it("forbids improvising a different command on failure", () => {
    expect(prompt).toContain("do not retry with a");
    expect(prompt).toContain("works once");
  });

  /** New MCP servers are invisible in the session that installed them. */
  it("says to restart, and what to ask afterwards", () => {
    expect(prompt).toContain("restart Claude Code");
    expect(prompt).toContain("What's waiting on me in");
  });

  it("never carries a key", () => {
    expect(prompt).not.toMatch(/pcp_|Bearer|api key/i);
  });
});

describe("buildWatchPrompt", () => {
  /**
   * REVERSED. This used to assert the agent's tools, on the grounds that the
   * inbox routes need a person's inbox credential a connect code did not reach
   * the harness with. Since connect registers the person's own inbox tools,
   * the agent tools are the wrong ones: the agent key is refused on every
   * decision route by design, so "approve that" after a check answered 403.
   */
  it("reads the person's own inbox, not the agent's tools", () => {
    const prompt = buildWatchPrompt("Casper");
    expect(prompt).toContain("inbox_sync");
    expect(prompt).not.toContain("agentdash tools");
  });

  it("decides only the item the person names, when they say so", () => {
    expect(buildWatchPrompt("Casper")).toContain("use inbox_decide for that item only");
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
    expect(buildWatchPrompt("HAL")).toContain("anything of HAL's");
  });
});
