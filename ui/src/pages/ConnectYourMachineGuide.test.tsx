import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildBridgeRunCommand } from "../components/agent/ConnectYourMachine";

/**
 * The guide explains a command that has already been wrong twice — once naming
 * a binary nobody had installed, once omitting a flag the tool requires. Both
 * times the fix landed in one place and the prose that quoted it did not.
 *
 * So the rule this defends is narrow and mechanical: the guide must RENDER the
 * shared builder, never restate its output.
 */
describe("connect-your-machine guide", () => {
  // Collapse whitespace: JSX wraps prose across source lines, so a sentence the
  // customer reads as one line is not one line here. Matching the raw file made
  // these assertions pass or fail on where the formatter happened to break.
  const guide = readFileSync(
    new URL("./ConnectYourMachineGuide.tsx", import.meta.url),
    "utf8",
  ).replace(/\s+/g, " ");

  /**
   * The guide must not hand a customer the sandboxed worker command.
   *
   * That path runs `claude` inside a sandbox which denies the home directory,
   * so it cannot see their Claude Code login and demands an API key of its own.
   * The supported path uses their existing subscription through a session they
   * open. The page used to teach both, with a network-posture picker in the
   * middle of the setup steps, which sent people down the one that cannot work.
   */
  it("teaches the inbox path and not the sandboxed worker", () => {
    expect(guide, "the worker command must not appear in customer setup").not.toContain(
      "buildBridgeRunCommand",
    );
    expect(guide, "no network-posture picker belongs in this flow").not.toMatch(/egress/i);
    expect(guide, "the inbox workspace is the setup step").toContain("bridge inbox-init");
  });

  /**
   * Cadence can be stored but nothing reads it yet. Saying so is the difference
   * between a documented limitation and a customer waiting for checks that
   * never come.
   */
  it("states the cadence limitation rather than implying scheduling works", () => {
    expect(guide).toMatch(/nothing reads the interval yet/i);
    expect(guide).toMatch(/not built/i);
  });

  /** Directing work is confirmation-gated; the guide has to say so. */
  it("documents the confirmation boundary on directing work", () => {
    expect(guide).toMatch(/Nothing is sent until you confirm/i);
    expect(guide).toMatch(/at most 10 at a time/i);
    expect(guide).toMatch(/checked at the moment you confirm/i);
  });

  it("names the binary from the same constant the enrollment card uses", () => {
    expect(guide).toContain("BRIDGE_CLI_BIN");
    // The squatted npm name may only appear as the warning not to use it.
    const mentionsBareName = /["`]agentdash["`]/.test(guide);
    if (mentionsBareName) {
      expect(guide).toMatch(/predates|not ours|nothing published/i);
    }
  });

  it("is reachable from the router", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(app).toContain("ConnectYourMachineGuide");
    expect(app).toContain('path="my-agent/connect-machine"');
  });

  /**
   * The page tells a steward the key is not optional and why. If the builder
   * ever stops emitting it, the page would be describing something that is no
   * longer there.
   */
  it("stays consistent with what the builder actually emits", () => {
    // The builder still exists for the unattended worker; the guide simply no
    // longer teaches it, so the page must not mention its API-key requirement.
    const command = buildBridgeRunCommand("https://example.test", "direct");
    expect(command).toContain("ANTHROPIC_API_KEY");
    expect(guide, "an API key has no place in the subscription path").not.toMatch(
      /ANTHROPIC_API_KEY/,
    );
  });
});
