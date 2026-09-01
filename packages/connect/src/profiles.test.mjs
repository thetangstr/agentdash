import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shellProfilePaths } from "./index.mjs";

/**
 * `.zshrc` is sourced for INTERACTIVE shells only. Writing the export there and
 * nowhere else passed every hand test -- because a person testing it types into
 * an interactive terminal -- while Codex launched from a GUI app, a script, or
 * an MDM task got no key at all and failed as if the credential were bad.
 *
 * Verified on this machine at the time of writing:
 *   zsh -lc  (login, non-interactive) -> key length 0
 *   zsh -ic  (interactive)            -> key length 52
 */
describe("shellProfilePaths", () => {
  const home = os.homedir();

  it("covers the interactive AND login file for zsh", () => {
    const paths = shellProfilePaths("/bin/zsh");
    expect(paths).toContain(path.join(home, ".zshrc"));
    expect(paths).toContain(path.join(home, ".zprofile"));
  });

  it("covers the interactive AND login file for bash", () => {
    const paths = shellProfilePaths("/bin/bash");
    expect(paths).toContain(path.join(home, ".bashrc"));
    expect(paths).toContain(path.join(home, ".bash_profile"));
  });

  it("uses the single file fish actually reads", () => {
    // fish reads config.fish for both kinds, so a second file would be wrong,
    // not merely redundant.
    expect(shellProfilePaths("/opt/homebrew/bin/fish")).toEqual([
      path.join(home, ".config", "fish", "config.fish"),
    ]);
  });

  it("falls back to .profile for an unknown shell rather than writing nothing", () => {
    expect(shellProfilePaths("/usr/bin/some-shell")).toEqual([path.join(home, ".profile")]);
    expect(shellProfilePaths("")).toEqual([path.join(home, ".profile")]);
  });

  it("never returns an empty list, whatever it is handed", () => {
    // An empty list would mean the key is stored but nothing ever exports it --
    // a connection that reports success and cannot work.
    for (const shell of ["/bin/zsh", "/bin/bash", "/bin/fish", "", "nonsense"]) {
      expect(shellProfilePaths(shell).length).toBeGreaterThan(0);
    }
  });
});
