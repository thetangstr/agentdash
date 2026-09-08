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
   * The cadence section used to say a scheduler was coming and the stored
   * preference would start working. That is not the design: the repeating check
   * is the operator's own harness job, and AgentDash runs no timer. These pin
   * the corrected doctrine, per-harness, including the parts we could not
   * verify — an unverified limit stated plainly is the point, not a gap.
   */
  it("teaches native scheduling in the operator's own tool, not an AgentDash timer", () => {
    expect(guide).toMatch(/AgentDash does not run a timer/i);
    expect(guide).toMatch(/Claude Code/);
    expect(guide).toMatch(/Codex/);
    // No promise that a scheduler is on its way.
    expect(guide).not.toMatch(/scheduler is\s+<span className="font-medium">not built/i);
    expect(guide).not.toMatch(/once scheduled checking exists/i);
  });

  it("states that a scheduled check cannot decide yet, and why", () => {
    expect(guide).toMatch(/cannot decide anything for you yet/i);
    expect(guide).toMatch(/MCP client package is not built on this instance/);
  });

  it("keeps the per-harness limits that make this honest", () => {
    // Claude Code: session-scoped, expires, jittered, sleep undocumented.
    expect(guide).toMatch(/seven days/i);
    expect(guide).toMatch(/running and idle/i);
    expect(guide).toMatch(/half the interval/i);
    expect(guide).toMatch(/Sleep and wake are not documented/i);
    // Codex: CLI has none; web cannot reach a local connection.
    expect(guide).toMatch(/command line has no scheduling/i);
    expect(guide).toMatch(/does not read the configuration on your machine/i);
  });

  it("does not claim the harnesses behave alike", () => {
    expect(guide).toMatch(/behave very differently/i);
  });

  /** The stored interval must not be described as doing anything. */
  it("says the stored interval is read by nothing", () => {
    expect(guide).toMatch(/records the number and nothing reads it/i);
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
