import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BRIDGE_CLI_BIN, buildBridgeRunCommand } from "./ConnectYourMachine";

/**
 * AgentDash (AGE-12): the enrollment page must print a command that exists.
 *
 * The bin name is read from the CLI package itself rather than repeated here,
 * so a rename of the CLI fails this test instead of silently shipping a page
 * that tells people to run a binary nobody installed.
 */
describe("bridge enrollment command", () => {
  const cliPackage = JSON.parse(
    readFileSync(new URL("../../../../cli/package.json", import.meta.url), "utf8"),
  ) as { bin?: Record<string, string> };

  const cliSource = readFileSync(
    new URL("../../../../cli/src/commands/bridge-run.ts", import.meta.url),
    "utf8",
  );

  it("names the CLI package's real bin", () => {
    const bins = Object.keys(cliPackage.bin ?? {});
    expect(bins).toContain(BRIDGE_CLI_BIN);
  });

  it("prints `<bin> bridge run` with the server and the token file, never the bare product name", () => {
    const command = buildBridgeRunCommand(
      "https://agentdash.example.com",
      "direct",
    );
    expect(command).toContain(`${BRIDGE_CLI_BIN} bridge run`);
    expect(command).toContain("--server https://agentdash.example.com");
    expect(command).toContain("--token-file ~/.agentdash/bridge-token");
    expect(command).not.toMatch(new RegExp(`(^|\\s)${"agent" + "dash"} bridge run`));
    expect(command).not.toContain("npx");
  });

  /**
   * The regression this exists for: the page printed a command with no
   * `--egress`, and the worker exits immediately with "Refusing to start:
   * --egress is required and has no default." Read the requirement off the CLI
   * rather than hardcoding the flag here, so a future required option fails
   * this test instead of shipping another command that cannot start.
   */
  it("passes every option the CLI declares required with no default", () => {
    const required = [
      ...cliSource.matchAll(/\.option\(\s*"(--[\w-]+)[^"]*"\s*,\s*"([^"]*)/g),
    ]
      .filter(([, , description]) => /Required, no default/i.test(description))
      .map(([, flag]) => flag);

    expect(required, "expected the CLI to declare at least one required option").toContain(
      "--egress",
    );

    for (const egress of ["loopback", "direct"] as const) {
      const command = buildBridgeRunCommand(
        "https://agentdash.example.com",
        egress,
      );
      for (const flag of required) {
        expect(command, `command omits required ${flag}`).toContain(flag);
      }
      expect(command).toContain(`--egress ${egress}`);
    }
  });

  /**
   * The sandbox denies the home directory, so the worker cannot read a desktop
   * `claude` login. Without a key in the environment the bridge polls happily
   * and then fails every task it claims, which reads as a broken agent rather
   * than a missing credential.
   */
  it("sets an Anthropic key in the environment rather than leaving the worker unauthenticated", () => {
    const command = buildBridgeRunCommand(
      "https://agentdash.example.com",
      "direct",
    );
    expect(command).toContain("ANTHROPIC_API_KEY");
    expect(command).not.toMatch(/--token\s/);
  });
});
