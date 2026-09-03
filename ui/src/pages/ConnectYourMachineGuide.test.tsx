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
  const guide = readFileSync(new URL("./ConnectYourMachineGuide.tsx", import.meta.url), "utf8");

  it("renders the shared command builder instead of quoting a command", () => {
    expect(guide).toContain("buildBridgeRunCommand");

    // No hand-written invocation anywhere in the page, in any spelling.
    const handWritten = guide.match(/["`][^"`\n]*bridge run[^"`\n]*["`]/g) ?? [];
    expect(
      handWritten,
      "the guide must render buildBridgeRunCommand, not restate the command",
    ).toHaveLength(0);
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
    const command = buildBridgeRunCommand("https://example.test", "direct");
    expect(command).toContain("ANTHROPIC_API_KEY");
    expect(command).toContain("--egress direct");
    expect(guide).toMatch(/ANTHROPIC_API_KEY/);
  });
});
