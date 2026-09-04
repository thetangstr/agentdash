import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The desktop design is that approved work runs in the Claude Code the operator
 * is already signed into, on their own subscription. AgentDash never holds a
 * model credential of theirs.
 *
 * `bridge run` is the other mode — an unattended worker in a sandbox that denies
 * the home directory, which is exactly why it needs a key of its own. Both of
 * its messages used to present that key as the answer, full stop, which sent
 * anybody wanting to use their subscription down the one path that cannot.
 */
describe("bridge run messaging", () => {
  const runCommand = readFileSync(new URL("../commands/bridge-run.ts", import.meta.url), "utf8");
  const sandbox = readFileSync(new URL("../bridge/sandbox.ts", import.meta.url), "utf8");

  /**
   * Reassemble the message the way a reader sees it. These strings are built by
   * concatenating source lines, so matching raw source would fail on any phrase
   * that happens to straddle a line break -- which says nothing about whether
   * the message is right.
   */
  function readable(source: string, from: string, length = 1600): string {
    return source
      .slice(source.indexOf(from), source.indexOf(from) + length)
      .replace(/\\n/g, " ")
      .replace(/"\s*\+\s*"/g, "")
      .replace(/\s+/g, " ");
  }

  const startupWarning = readable(runCommand, "this sandboxed worker has no credential");
  const authFailure = readable(sandbox, "not authenticated inside the sandbox");

  it.each([
    ["the startup warning", () => startupWarning],
    ["the authentication failure", () => authFailure],
  ])("%s points at the subscription path first", (_label, get) => {
    const text = get();
    expect(text, "must name the inbox path").toMatch(/inbox-init/);
    expect(text, "must say this command is not the subscription route").toMatch(
      /wrong command|do not use this command/i,
    );
  });

  it("still explains the key for the unattended case rather than dropping it", () => {
    for (const text of [startupWarning, authFailure]) {
      expect(text).toMatch(/ANTHROPIC_API_KEY/);
      expect(text).toMatch(/unattended/i);
    }
  });

  it("keeps saying that claude /login cannot help here", () => {
    for (const text of [startupWarning, authFailure]) {
      expect(text).toMatch(/login/);
    }
  });
});
