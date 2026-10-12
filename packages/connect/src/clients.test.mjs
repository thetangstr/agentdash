import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DESKTOP_CLIENT,
  DESKTOP_INSTRUCTIONS_FILE,
  DESKTOP_SERVER_INSTRUCTIONS,
  applyCodexInboxMcp,
  applyDesktopInboxMcp,
  claudeDesktopConfigPath,
  describeClientEntries,
  desktopInboxLaunch,
  desktopProjectInstructions,
  detectClaudeDesktop,
  installDesktopInstructions,
  mergeDesktopInboxServer,
  readCodexStdioServer,
  readDesktopInboxServer,
  removeInboxClients,
  setupInboxClients,
  upsertCodexStdioToml,
} from "./clients.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "clients-test-"));
const SERVER = "http://agentdash.example.test:3100";
const SKILL = [
  "---",
  "name: agentdash-coworker",
  "description: test skill",
  "---",
  "<!-- agentdash-coworker-skill-version: 3 -->",
  "",
  "# AgentDash co-worker",
  "",
  "Review every waiting item first.",
  "",
].join("\n");

describe("Claude Desktop: where it keeps its config", () => {
  it("uses the per-platform config file and has none on Linux", () => {
    expect(claudeDesktopConfigPath({ platform: "darwin", home: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(
      claudeDesktopConfigPath({ platform: "win32", home: "C:\\Users\\a", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" } }),
    ).toBe(path.join("C:\\Users\\a\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
    expect(claudeDesktopConfigPath({ platform: "linux", home: "/home/a" })).toBeNull();
  });

  it("counts Desktop as installed when its folder or the app is there", () => {
    const home = tmp();
    expect(detectClaudeDesktop({ platform: "darwin", home, appPaths: [] }).installed).toBe(false);
    mkdirSync(path.join(home, "Library", "Application Support", "Claude"), { recursive: true });
    expect(detectClaudeDesktop({ platform: "darwin", home, appPaths: [] })).toMatchObject({
      installed: true,
      configPath: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    });
    const app = path.join(tmp(), "Claude.app");
    mkdirSync(app);
    expect(detectClaudeDesktop({ platform: "darwin", home: tmp(), appPaths: [app] }).installed).toBe(true);
    expect(detectClaudeDesktop({ platform: "linux", home }).installed).toBe(false);
  });
});

describe("Claude Desktop: the inbox server entry", () => {
  it("launches the inbox tools with the instance and says it is Desktop", () => {
    const launch = desktopInboxLaunch({ server: SERVER, platform: "darwin", nodeDir: "/opt/node/bin" });
    expect(launch.command).toBe("npx");
    expect(launch.args).toEqual(["-y", "agentdash-connect@latest", "mcp", "--server", SERVER, "--client", DESKTOP_CLIENT]);
    // A Mac app does not get the login shell's PATH; npx and node must still resolve.
    expect(launch.env.PATH.split(":")).toEqual(
      expect.arrayContaining(["/opt/node/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
    );
    expect(launch.env.PATH.split(":")[0]).toBe("/opt/node/bin");
    // No credential is ever written into the Desktop config.
    expect(JSON.stringify(launch)).not.toMatch(/token|bearer|key/i);

    const win = desktopInboxLaunch({ server: SERVER, platform: "win32" });
    expect(win.command).toBe("cmd");
    expect(win.args.slice(0, 3)).toEqual(["/c", "npx", "-y"]);
    expect(win.env).toBeUndefined();
  });

  it("merges into an existing config and keeps every other key", () => {
    const existing = {
      globalShortcut: "Cmd+Shift+Space",
      preferences: { menuBarEnabled: true },
      mcpServers: { filesystem: { command: "npx", args: ["-y", "fs-server", "/tmp"], env: { A: "1" } } },
    };
    const launch = desktopInboxLaunch({ server: SERVER, platform: "darwin", nodeDir: "/opt/node/bin" });
    const merged = mergeDesktopInboxServer(existing, "agentdash-inbox", launch);
    expect(merged.ok).toBe(true);
    expect(merged.config.globalShortcut).toBe("Cmd+Shift+Space");
    expect(merged.config.preferences).toEqual({ menuBarEnabled: true });
    expect(merged.config.mcpServers.filesystem).toEqual(existing.mcpServers.filesystem);
    expect(merged.config.mcpServers["agentdash-inbox"]).toEqual(launch);
    // The input is not mutated.
    expect(existing.mcpServers["agentdash-inbox"]).toBeUndefined();
  });

  it("refuses a config it does not understand rather than guessing", () => {
    const launch = desktopInboxLaunch({ server: SERVER, platform: "darwin", nodeDir: "/x" });
    expect(mergeDesktopInboxServer([], "agentdash-inbox", launch).ok).toBe(false);
    expect(mergeDesktopInboxServer({ mcpServers: [] }, "agentdash-inbox", launch).ok).toBe(false);
    expect(mergeDesktopInboxServer({ mcpServers: "x" }, "agentdash-inbox", launch).ok).toBe(false);
  });

  it("creates the file when Desktop has none yet, private to the person", () => {
    const dir = tmp();
    const configPath = path.join(dir, "Claude", "claude_desktop_config.json");
    mkdirSync(path.dirname(configPath));
    const result = applyDesktopInboxMcp({ serverName: "agentdash", instanceUrl: SERVER, configPath, platform: "darwin", nodeDir: "/n" });
    expect(result).toMatchObject({ status: "written", file: configPath, backup: null, name: "agentdash-inbox" });
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.mcpServers["agentdash-inbox"].args).toContain(SERVER);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("backs the existing file up before changing it, then is idempotent", () => {
    const dir = tmp();
    const configPath = path.join(dir, "claude_desktop_config.json");
    const original = `${JSON.stringify({ preferences: { x: 1 }, mcpServers: { other: { command: "a", args: [] } } }, null, 2)}\n`;
    writeFileSync(configPath, original, { mode: 0o644 });

    const now = () => new Date("2026-10-12T08:09:10.123Z");
    const first = applyDesktopInboxMcp({ serverName: "agentdash", instanceUrl: SERVER, configPath, platform: "darwin", nodeDir: "/n", now });
    expect(first.status).toBe("written");
    expect(first.backup).toBe(`${configPath}.agentdash-backup-20261012T080910Z`);
    expect(readFileSync(first.backup, "utf8")).toBe(original);
    expect(statSync(first.backup).mode & 0o777).toBe(0o600);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    expect(after.preferences).toEqual({ x: 1 });
    expect(after.mcpServers.other).toEqual({ command: "a", args: [] });
    expect(readDesktopInboxServer(configPath, "agentdash-inbox")?.args).toContain(SERVER);

    // Same input again: nothing written, no second backup.
    const text = readFileSync(configPath, "utf8");
    const second = applyDesktopInboxMcp({ serverName: "agentdash", instanceUrl: SERVER, configPath, platform: "darwin", nodeDir: "/n", now });
    expect(second).toMatchObject({ status: "unchanged", backup: null });
    expect(readFileSync(configPath, "utf8")).toBe(text);
    expect(readdirSync(dir).filter((f) => f.includes("agentdash-backup"))).toHaveLength(1);
  });

  it("leaves a file it cannot parse untouched and says so", () => {
    const dir = tmp();
    const configPath = path.join(dir, "claude_desktop_config.json");
    writeFileSync(configPath, "{ not json");
    const result = applyDesktopInboxMcp({ serverName: "agentdash", instanceUrl: SERVER, configPath, platform: "darwin", nodeDir: "/n" });
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/JSON/);
    expect(readFileSync(configPath, "utf8")).toBe("{ not json");
    expect(readdirSync(dir)).toEqual(["claude_desktop_config.json"]);
  });
});

describe("Codex: the inbox tools as a stdio server", () => {
  it("writes the shape `codex mcp add` writes, with room for npx to start", () => {
    const text = upsertCodexStdioToml("", "agentdash-inbox", {
      command: "npx",
      args: ["-y", "agentdash-connect@latest", "mcp", "--server", SERVER],
    });
    expect(text).toBe(
      [
        "[mcp_servers.agentdash-inbox]",
        'command = "npx"',
        `args = ["-y", "agentdash-connect@latest", "mcp", "--server", "${SERVER}"]`,
        "startup_timeout_sec = 60",
        "tool_timeout_sec = 3600",
        "",
      ].join("\n"),
    );
    expect(readCodexStdioServer(text, "agentdash-inbox")).toEqual({
      command: "npx",
      args: ["-y", "agentdash-connect@latest", "mcp", "--server", SERVER],
    });
  });

  it("keeps the agent server and everything else, and replaces only its own block", () => {
    const existing = [
      'model = "gpt-x"',
      "",
      "[mcp_servers.agentdash]",
      `url = "${SERVER}/api/mcp"`,
      'bearer_token_env_var = "AGENTDASH_KEY_AGENTDASH"',
      "",
      "[mcp_servers.agentdash-inbox]",
      'command = "old"',
      "args = []",
      "",
      "[profiles.fast]",
      'model = "y"',
      "",
    ].join("\n");
    const next = upsertCodexStdioToml(existing, "agentdash-inbox", { command: "npx", args: ["a", 'quote"d'] });
    expect(next).toContain('model = "gpt-x"');
    expect(next).toContain('bearer_token_env_var = "AGENTDASH_KEY_AGENTDASH"');
    expect(next).toContain("[profiles.fast]");
    expect(next).not.toContain('command = "old"');
    expect(next.match(/\[mcp_servers\.agentdash-inbox\]/g)).toHaveLength(1);
    expect(readCodexStdioServer(next, "agentdash-inbox")).toEqual({ command: "npx", args: ["a", 'quote"d'] });
    expect(upsertCodexStdioToml(next, "agentdash-inbox", { command: "npx", args: ["a", 'quote"d'] })).toBe(next);
  });

  it("applies to the config file idempotently and never writes a secret", () => {
    const dir = tmp();
    const configPath = path.join(dir, ".codex", "config.toml");
    const first = applyCodexInboxMcp({ serverName: "agentdash", instanceUrl: SERVER, configPath, platform: "darwin" });
    expect(first).toMatchObject({ name: "agentdash-inbox", file: configPath, status: "written" });
    const text = readFileSync(configPath, "utf8");
    expect(text).not.toMatch(/token|bearer/i);
    expect(applyCodexInboxMcp({ serverName: "agentdash", instanceUrl: SERVER, configPath, platform: "darwin" }).status).toBe(
      "unchanged",
    );
    expect(readFileSync(configPath, "utf8")).toBe(text);
  });
});

describe("Claude Desktop project instructions", () => {
  it("carries the skill body, its version, and a start-of-chat review rule", () => {
    const text = desktopProjectInstructions(SKILL);
    expect(text).toContain("<!-- agentdash-coworker-skill-version: 3 -->");
    expect(text).toContain("Review every waiting item first.");
    expect(text).not.toContain("name: agentdash-coworker");
    expect(text).toMatch(/start of every chat in this project/i);
    expect(text).toContain("inbox_sync");
    // Never tells Desktop it may send without the person's go.
    expect(text).toMatch(/explicit go/);
  });

  it("is installed once and kept when the person removed the version line", () => {
    const dir = tmp();
    const first = installDesktopInstructions(dir, { skillText: SKILL });
    const file = path.join(dir, DESKTOP_INSTRUCTIONS_FILE);
    expect(first.created).toEqual([file]);
    expect(installDesktopInstructions(dir, { skillText: SKILL }).created).toEqual([]);
    writeFileSync(file, "my own notes");
    const kept = installDesktopInstructions(dir, { skillText: SKILL.replace("version: 3", "version: 4") });
    expect(kept.notInstalled).toEqual([{ file, reason: "own" }]);
    expect(readFileSync(file, "utf8")).toBe("my own notes");
  });

  it("the server instructions for Desktop wait to be asked outside the inbox project", () => {
    expect(DESKTOP_SERVER_INSTRUCTIONS).toMatch(/no session-start hook/i);
    expect(DESKTOP_SERVER_INSTRUCTIONS).toMatch(/when the person asks/i);
    expect(DESKTOP_SERVER_INSTRUCTIONS).toMatch(/never guess/i);
  });
});

describe("setting up and removing every inbox client", () => {
  function paths(dir) {
    return {
      claudeConfig: path.join(dir, ".claude.json"),
      codexConfig: path.join(dir, ".codex", "config.toml"),
      desktopConfig: path.join(dir, "Claude", "claude_desktop_config.json"),
      inboxDir: path.join(dir, "agentdash-inbox"),
    };
  }

  it("wires Claude Code, Claude Desktop and Codex, and skips what is not installed", () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.claudeConfig, JSON.stringify({ mcpServers: { agentdash: { type: "http", url: `${SERVER}/api/mcp` } } }));
    const entries = setupInboxClients({
      serverName: "agentdash",
      instanceUrl: SERVER,
      clients: { claude: true, codex: true, desktop: true },
      paths: p,
      platform: "darwin",
      nodeDir: "/n",
      skillText: SKILL,
    });
    expect(entries.map((e) => [e.client, e.status])).toEqual([
      ["claude", "written"],
      ["desktop", "written"],
      ["desktop-instructions", "written"],
      ["codex", "written"],
    ]);
    const claude = JSON.parse(readFileSync(p.claudeConfig, "utf8"));
    expect(claude.mcpServers.agentdash.url).toBe(`${SERVER}/api/mcp`);
    expect(claude.mcpServers["agentdash-inbox"].args).toContain(SERVER);
    expect(readDesktopInboxServer(p.desktopConfig, "agentdash-inbox")?.args).toContain(DESKTOP_CLIENT);
    expect(readCodexStdioServer(readFileSync(p.codexConfig, "utf8"), "agentdash-inbox")?.args).toContain(SERVER);
    expect(existsSync(path.join(p.inboxDir, DESKTOP_INSTRUCTIONS_FILE))).toBe(true);

    const none = setupInboxClients({
      serverName: "agentdash",
      instanceUrl: SERVER,
      clients: { claude: false, codex: false, desktop: false },
      paths: paths(tmp()),
      platform: "darwin",
      skillText: SKILL,
    });
    expect(none).toEqual([]);
  });

  it("removes the inbox entries from Desktop and Codex, backing Desktop up first", () => {
    const dir = tmp();
    const p = paths(dir);
    setupInboxClients({
      serverName: "agentdash",
      instanceUrl: SERVER,
      clients: { claude: false, codex: true, desktop: true },
      paths: p,
      platform: "darwin",
      nodeDir: "/n",
      skillText: SKILL,
    });
    const codexBefore = readFileSync(p.codexConfig, "utf8");
    writeFileSync(p.codexConfig, `[mcp_servers.agentdash]\nurl = "${SERVER}/api/mcp"\n\n${codexBefore}`);

    const removed = removeInboxClients({ serverName: "agentdash", paths: p, now: () => new Date("2026-10-12T00:00:00Z") });
    expect(removed.map((r) => r.harness)).toEqual(["desktop", "codex"]);
    expect(readDesktopInboxServer(p.desktopConfig, "agentdash-inbox")).toBeNull();
    const codexAfter = readFileSync(p.codexConfig, "utf8");
    expect(readCodexStdioServer(codexAfter, "agentdash-inbox")).toBeNull();
    expect(codexAfter).toContain("[mcp_servers.agentdash]");
    expect(readdirSync(path.dirname(p.desktopConfig)).some((f) => f.includes("agentdash-backup"))).toBe(true);

    expect(removeInboxClients({ serverName: "agentdash", paths: p })).toEqual([]);
  });
});

describe("telling the person what was set up", () => {
  it("names each file, the backup, and the step each client still needs", () => {
    const lines = describeClientEntries([
      { client: "claude", status: "written", file: "/h/.claude.json", name: "agentdash-inbox" },
      { client: "desktop", status: "written", file: "/h/desktop.json", name: "agentdash-inbox", backup: "/h/desktop.json.agentdash-backup-1" },
      { client: "desktop-instructions", status: "written", file: "/h/agentdash-inbox/claude-desktop-project.md" },
      { client: "codex", status: "unchanged", file: "/h/.codex/config.toml", name: "agentdash-inbox" },
      { client: "desktop", status: "refused", file: "/h/d.json", reason: "left /h/d.json unchanged: it is not valid JSON" },
    ]);
    const text = lines.map((l) => l.text).join("\n");
    expect(text).toContain("/h/desktop.json.agentdash-backup-1");
    expect(text).toMatch(/quit and reopen Claude Desktop/);
    expect(text).toMatch(/paste this file into the instructions/);
    expect(text).toContain("/h/.codex/config.toml (already set up)");
    expect(lines.at(-1)).toEqual({ text: expect.stringContaining("not valid JSON"), problem: true });
  });
});
