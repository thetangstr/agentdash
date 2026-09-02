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

  it("names the CLI package's real bin", () => {
    const bins = Object.keys(cliPackage.bin ?? {});
    expect(bins).toContain(BRIDGE_CLI_BIN);
  });

  it("prints `<bin> bridge run` with the server and the token file, never the bare product name", () => {
    const command = buildBridgeRunCommand("https://agentdash.example.com");
    expect(command.startsWith(`${BRIDGE_CLI_BIN} bridge run`)).toBe(true);
    expect(command).toContain("--server https://agentdash.example.com");
    expect(command).toContain("--token-file ~/.agentdash/bridge-token");
    expect(command).not.toMatch(new RegExp(`(^|\\s)${"agent" + "dash"} bridge run`));
    expect(command).not.toContain("npx");
  });
});
