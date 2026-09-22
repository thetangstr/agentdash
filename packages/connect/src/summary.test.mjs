import { describe, expect, it } from "vitest";

import { NEXT_QUESTION, renderConnectSummary, tildePath } from "./summary.mjs";

const HOME = "/Users/titus";
const base = {
  agentName: "Casper",
  companyName: "MKThink",
  harnesses: { claude: true, codex: false },
  owner: { name: "Titus", email: "shem@mkthink.com" },
  files: [
    { file: `${HOME}/.claude.json`, what: `Casper's agent key ("agentdash"), and your inbox tools ("agentdash-inbox")` },
    { file: `${HOME}/.agentdash/bridge-token`, what: "your inbox credential" },
  ],
  undo: "npx agentdash-connect --remove",
  home: HOME,
};

describe("renderConnectSummary", () => {
  it("leads with the outcome — who is connected to which agent", () => {
    const text = renderConnectSummary({ ...base, inbox: "connected" });
    expect(text.split("\n")[0]).toBe(
      "Connected. Casper at MKThink is ready in Claude Code, and so is your inbox (Titus, shem@mkthink.com).",
    );
  });

  it("gives the one next step: restart, then ask", () => {
    const text = renderConnectSummary({ ...base, inbox: "connected" });
    expect(text).toContain("restart Claude Code");
    expect(text).toContain(NEXT_QUESTION);
    expect(text).toContain("approve or reject right there in the chat");
    // The inbox folder is no longer presented as a step.
    expect(text).not.toMatch(/^Open .*agentdash-inbox/m);
  });

  it("keeps the file list, with home shortened, for whoever reviews it", () => {
    const text = renderConnectSummary({ ...base, inbox: "connected" });
    expect(text).toContain("Written (credentials at mode 600):");
    expect(text).toContain("~/.claude.json");
    expect(text).toContain("~/.agentdash/bridge-token");
    expect(text).not.toContain(HOME);
    expect(text.trimEnd().split("\n").at(-1)).toBe("Undo: npx agentdash-connect --remove");
  });

  it("says plainly when someone else's inbox was kept, and how to replace it", () => {
    const text = renderConnectSummary({ ...base, inbox: "kept", keptOwner: "Yang Tang" });
    expect(text).toContain("Your inbox was not changed: this machine's inbox belongs to Yang Tang.");
    expect(text).toContain("run the same command in a terminal and answer yes");
    expect(text).not.toContain("so is your inbox");
    expect(text).not.toContain("approve or reject right there");
  });

  it("says what failed without undoing the agent half", () => {
    const text = renderConnectSummary({ ...base, inbox: "failed", inboxError: "EACCES" });
    expect(text.split("\n")[0]).toBe("Connected. Casper at MKThink is ready in Claude Code, but inbox setup failed (EACCES).");
    expect(text).toContain("Create a fresh code");
  });

  it("does not promise an inbox an older instance cannot give", () => {
    const text = renderConnectSummary({ ...base, inbox: "unsupported" });
    expect(text).toContain("does not offer an inbox yet");
    expect(text).not.toContain("so is your inbox");
  });

  it("names both harnesses and the Codex restart when Codex is there too", () => {
    const text = renderConnectSummary({
      ...base,
      inbox: "connected",
      harnesses: { claude: true, codex: true },
      codexEnvVar: "AGENTDASH_KEY_AGENTDASH",
    });
    expect(text).toContain("ready in Claude Code and Codex");
    expect(text).toContain("Codex: open a new terminal first, so AGENTDASH_KEY_AGENTDASH is set.");
  });

  it("never carries a credential, only where one was put", () => {
    const text = renderConnectSummary({ ...base, inbox: "connected" });
    expect(text).not.toMatch(/pcp_|Bearer/);
  });
});

describe("tildePath", () => {
  it("shortens paths under home and leaves others alone", () => {
    expect(tildePath(`${HOME}/.claude.json`, HOME)).toBe("~/.claude.json");
    expect(tildePath(HOME, HOME)).toBe("~");
    expect(tildePath("/etc/hosts", HOME)).toBe("/etc/hosts");
    expect(tildePath("OS keychain", HOME)).toBe("OS keychain");
  });
});
