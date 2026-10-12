/**
 * The person's inbox tools in every client they use: Claude Code, Claude
 * Desktop and Codex.
 *
 * The agent connection (index.mjs) rides the agent's key. This file is the
 * other credential: the person's own inbox, served by `agentdash-connect mcp`
 * over stdio. No client config written here ever holds a secret; the token
 * stays in ~/.agentdash/bridge-token and the configs name only the command.
 *
 * Kept apart from index.mjs and inbox.mjs so client setup can change without
 * touching the connect and inbox flows.
 *
 * Claude Desktop is the odd one: it has no project folder, no session-start
 * hook and no skills folder this package can write to. So it gets the tools
 * (its own config file, merged and backed up, never clobbered), server
 * instructions that say it is Desktop, and a project-instructions file the
 * person pastes into a Claude Desktop project once.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { findCodexBlock, inboxMcpLaunch } from "./harnesses.mjs";
import { applyInboxMcp, inboxServerNameFor } from "./index.mjs";
import { coworkerSkillVersion, packagedCoworkerSkill, writeManaged } from "./inbox.mjs";

/** Passed as `mcp --client claude-desktop`, so the server knows where it runs. */
export const DESKTOP_CLIENT = "claude-desktop";

/** The file in the inbox folder whose text goes into a Claude Desktop project. */
export const DESKTOP_INSTRUCTIONS_FILE = "claude-desktop-project.md";

/**
 * Added to the inbox server's instructions when Claude Desktop launched it.
 * Desktop registers the tools for every chat, so like a Claude Code session
 * outside the inbox folder it waits to be asked, except in the inbox project
 * whose instructions start the review.
 */
export const DESKTOP_SERVER_INSTRUCTIONS = [
  "This is Claude Desktop: there is no inbox folder and no session-start hook here.",
  "Review what is waiting (inbox_sync, then work_list when available) before anything else only in a chat",
  "in the person's AgentDash inbox project, whose instructions say so, or when the person asks you to.",
  "In every other chat, use these tools only when the person asks about their inbox, an approval or",
  "an agent's question; never sync on your own.",
  "Claude Desktop may not be able to open a file that work_fetch_file saved on this machine. If you",
  "cannot read one, say so plainly and never guess what it says.",
].join("\n");

// ------------------------------------------------------------ Claude Desktop

/** Where Claude Desktop keeps its config. Null where Desktop does not run. */
export function claudeDesktopConfigPath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return null;
}

const DEFAULT_DESKTOP_APPS = ["/Applications/Claude.app", path.join(os.homedir(), "Applications", "Claude.app")];

/**
 * Is Claude Desktop on this machine? Its config folder (made on first launch)
 * or, on macOS, the app itself. Linux has no Claude Desktop.
 */
export function detectClaudeDesktop({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  appPaths = platform === "darwin" ? DEFAULT_DESKTOP_APPS : [],
} = {}) {
  const configPath = claudeDesktopConfigPath({ platform, home, env });
  if (!configPath) return { installed: false, configPath: null };
  const installed = existsSync(path.dirname(configPath)) || appPaths.some((app) => existsSync(app));
  return { installed, configPath };
}

/**
 * How Claude Desktop launches the inbox tools. A Mac app does not inherit the
 * login shell's PATH, so `npx` (and the `node` its shebang asks for) would not
 * be found where Homebrew, nvm or a node installer put them. The PATH given
 * here starts with the directory of the node running this setup and then the
 * usual install places, so an upgraded node is still found. On Windows the app
 * gets the user's PATH, and npx is a .cmd shim that goes through cmd.
 */
export function desktopInboxLaunch({ server, platform = process.platform, nodeDir = path.dirname(process.execPath) } = {}) {
  const base = inboxMcpLaunch({ server, platform });
  const args = [...base.args, "--client", DESKTOP_CLIENT];
  if (platform === "win32") return { command: base.command, args };
  const dirs = [nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean);
  return { command: base.command, args, env: { PATH: [...new Set(dirs)].join(":") } };
}

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Add or replace one server in a Desktop config, keeping everything else.
 * Refuses a shape it does not understand rather than rewriting it.
 */
export function mergeDesktopInboxServer(config, name, launch) {
  if (!isPlainObject(config)) return { ok: false, reason: "its top level is not a JSON object" };
  if (config.mcpServers !== undefined && !isPlainObject(config.mcpServers)) {
    return { ok: false, reason: "its mcpServers entry is not a JSON object" };
  }
  return {
    ok: true,
    config: { ...config, mcpServers: { ...(config.mcpServers ?? {}), [name]: launch } },
  };
}

/** `20261012T080910Z`: sortable, and safe in a file name on every platform. */
function backupStamp(date) {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/**
 * Read a Desktop config. Missing or empty is an empty config; anything that
 * does not parse is a refusal, because rewriting a file we could not read
 * would lose whatever the person or Desktop put there.
 */
function readDesktopConfig(configPath) {
  if (!existsSync(configPath)) return { ok: true, exists: false, config: {} };
  let text;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    return { ok: false, reason: `could not read it (${err?.code ?? err?.message ?? err})` };
  }
  if (!text.trim()) return { ok: true, exists: true, config: {} };
  try {
    return { ok: true, exists: true, config: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "it is not valid JSON" };
  }
}

/** Copy the file aside before changing it. The copy is private: other servers' secrets live in it. */
function backUp(configPath, now) {
  const backup = `${configPath}.agentdash-backup-${backupStamp(now())}`;
  copyFileSync(configPath, backup);
  chmodSync(backup, 0o600);
  return backup;
}

function writeDesktopConfig(configPath, config, existed) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  // An existing file keeps its own mode; a new one is the person's alone.
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, existed ? undefined : { mode: 0o600 });
}

/**
 * Give Claude Desktop the inbox tools. Merges, never clobbers; backs the file
 * up first; writes nothing when the entry is already exactly right.
 */
export function applyDesktopInboxMcp({
  serverName,
  instanceUrl,
  configPath = claudeDesktopConfigPath(),
  platform = process.platform,
  nodeDir,
  now = () => new Date(),
}) {
  const name = inboxServerNameFor(serverName);
  const base = { name, file: configPath, backup: null };
  if (!configPath) return { ...base, status: "refused", reason: "Claude Desktop does not run on this platform" };
  const read = readDesktopConfig(configPath);
  if (!read.ok) {
    return { ...base, status: "refused", reason: `left ${configPath} unchanged: ${read.reason}` };
  }
  const launch = desktopInboxLaunch({ server: instanceUrl, platform, ...(nodeDir ? { nodeDir } : {}) });
  const merged = mergeDesktopInboxServer(read.config, name, launch);
  if (!merged.ok) {
    return { ...base, status: "refused", reason: `left ${configPath} unchanged: ${merged.reason}` };
  }
  if (JSON.stringify(read.config?.mcpServers?.[name]) === JSON.stringify(launch)) {
    return { ...base, status: "unchanged" };
  }
  try {
    const backup = read.exists ? backUp(configPath, now) : null;
    writeDesktopConfig(configPath, merged.config, read.exists);
    return { ...base, status: "written", backup };
  } catch (err) {
    return { ...base, status: "refused", reason: `could not write ${configPath} (${err?.code ?? err?.message ?? err})` };
  }
}

/** The inbox entry in a Desktop config, or null. Never throws. */
export function readDesktopInboxServer(configPath, name) {
  if (!configPath) return null;
  const read = readDesktopConfig(configPath);
  if (!read.ok || !isPlainObject(read.config) || !isPlainObject(read.config.mcpServers)) return null;
  return read.config.mcpServers[name] ?? null;
}

function removeDesktopInboxServer(configPath, name, now) {
  if (!configPath || !existsSync(configPath)) return false;
  const read = readDesktopConfig(configPath);
  if (!read.ok || !isPlainObject(read.config) || !isPlainObject(read.config.mcpServers)) return false;
  if (!(name in read.config.mcpServers)) return false;
  const servers = { ...read.config.mcpServers };
  delete servers[name];
  backUp(configPath, now);
  writeDesktopConfig(configPath, { ...read.config, mcpServers: servers }, true);
  return true;
}

/**
 * What goes into the instructions of a Claude Desktop project: the review
 * rules the skill gives Claude Code, and the one thing Desktop needs said
 * because it has no hook — start every chat in the project with the review.
 */
export function desktopProjectInstructions(skillText) {
  const version = coworkerSkillVersion(skillText) ?? 0;
  const body = skillText
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--\s*agentdash-coworker-skill-version:\s*\d+\s*-->/, "")
    .replace(/^\s+/, "");
  return [
    "# My AgentDash inbox (Claude Desktop project instructions)",
    "",
    `<!-- agentdash-coworker-skill-version: ${version} -->`,
    "",
    "This project is my AgentDash inbox. Claude Desktop has no session-start hook, so at the",
    "start of every chat in this project, before anything else, review what is waiting: call",
    "`inbox_sync`, then `work_list` when it is available, and go through every waiting item as",
    "described below. If the `agentdash-inbox` tools are not available in this chat, say so plainly",
    "and point me to my AgentDash page.",
    "",
    "Nothing is sent without my explicit go in this chat, and only what I chose.",
    "",
    "The folders named below (`~/agentdash-inbox/work/` and `incoming/`) are on my machine. If you",
    "cannot read or write them from Claude Desktop, say so, keep notes in this chat instead, and",
    "never guess what a file says.",
    "",
    "---",
    "",
    body,
  ].join("\n");
}

/**
 * Write (or update) the Desktop project instructions into the inbox folder,
 * by the same rules as the skill: a file without the version line is the
 * person's own and is never replaced. Never throws.
 */
export function installDesktopInstructions(dir, { skillText } = {}) {
  const lists = { created: [], updated: [], skipped: [], notInstalled: [] };
  const file = path.join(dir, DESKTOP_INSTRUCTIONS_FILE);
  let skill;
  try {
    skill = skillText ?? packagedCoworkerSkill();
  } catch (err) {
    lists.notInstalled.push({ file, reason: "unusable", detail: err?.code ?? String(err) });
    return lists;
  }
  writeManaged(file, desktopProjectInstructions(skill), lists);
  return lists;
}

// --------------------------------------------------------------------- Codex

/**
 * TOML basic strings take the same escapes JSON does for everything
 * JSON.stringify emits, so a JSON string literal is a valid TOML one.
 */
const tomlString = (value) => JSON.stringify(String(value));

/**
 * `[mcp_servers.<name>]` as a stdio server, in the shape `codex mcp add NAME
 * -- CMD ARGS` writes (checked against codex-cli 0.161). The first `npx -y`
 * fetch can take longer than Codex's default startup wait, and a large file
 * download may run past its default tool wait; the tools keep their own
 * deadlines, so these are outer bounds only.
 */
export function upsertCodexStdioToml(text, serverName, { command, args }) {
  const block = [
    `[mcp_servers.${serverName}]`,
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 60",
    "tool_timeout_sec = 3600",
  ];
  const found = findCodexBlock(text, serverName);
  if (found) {
    const { lines, start, end } = found;
    // Keep the blank line that separated this block from the next table, or
    // the file's final newline when the block was last.
    const tail = lines.slice(end);
    const gap = tail.length === 0 || lines[end - 1]?.trim() === "" ? [""] : [];
    return [...lines.slice(0, start), ...block, ...gap, ...tail].join("\n");
  }
  const existing = String(text ?? "").replace(/\s*$/, "");
  return existing.length > 0 ? `${existing}\n\n${block.join("\n")}\n` : `${block.join("\n")}\n`;
}

/** The command and args of a stdio server block, or null. */
export function readCodexStdioServer(text, serverName) {
  const found = findCodexBlock(text, serverName);
  if (!found) return null;
  const body = found.lines.slice(found.start + 1, found.end).join("\n");
  const commandLine = body.match(/^\s*command\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m)?.[1];
  const argsLine = body.match(/^\s*args\s*=\s*(\[.*\])\s*$/m)?.[1];
  if (!commandLine) return null;
  let command;
  let args = [];
  try {
    command = JSON.parse(commandLine);
    if (argsLine) args = JSON.parse(argsLine);
  } catch {
    return null;
  }
  return { command, args: Array.isArray(args) ? args : [] };
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const DEFAULT_CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

/** Give Codex the inbox tools, beside (never instead of) its agent server. */
export function applyCodexInboxMcp({
  serverName,
  instanceUrl,
  configPath = DEFAULT_CODEX_CONFIG,
  platform = process.platform,
}) {
  const name = inboxServerNameFor(serverName);
  const before = readText(configPath);
  const next = upsertCodexStdioToml(before, name, inboxMcpLaunch({ server: instanceUrl, platform }));
  if (next === before) return { name, file: configPath, status: "unchanged" };
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, next, { mode: 0o600 });
  return { name, file: configPath, status: "written" };
}

function removeCodexInboxServer(configPath, name) {
  const text = readText(configPath);
  const found = findCodexBlock(text, name);
  if (!found) return false;
  const kept = [...found.lines.slice(0, found.start), ...found.lines.slice(found.end)];
  writeFileSync(configPath, `${kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "")}\n`);
  return true;
}

// ------------------------------------------------------------- all together

/**
 * Wire the inbox tools into every client present. Each entry says what
 * happened to one client, so the caller can tell the person precisely.
 *
 * `clients` is `{ claude, codex, desktop }` (booleans). `paths` overrides the
 * real config locations, for tests.
 */
export function setupInboxClients({
  serverName,
  instanceUrl,
  clients,
  paths = {},
  platform = process.platform,
  nodeDir,
  now,
  skillText,
}) {
  const entries = [];
  if (clients.claude) {
    const result = applyInboxMcp({
      serverName,
      instanceUrl,
      ...(paths.claudeConfig ? { configPath: paths.claudeConfig } : {}),
    });
    entries.push({ client: "claude", status: "written", file: result.file, name: result.name });
  }
  if (clients.desktop) {
    const result = applyDesktopInboxMcp({
      serverName,
      instanceUrl,
      configPath: paths.desktopConfig ?? claudeDesktopConfigPath({ platform }),
      platform,
      ...(nodeDir ? { nodeDir } : {}),
      ...(now ? { now } : {}),
    });
    entries.push({ client: "desktop", ...result });
    const inboxDir = paths.inboxDir ?? path.join(os.homedir(), "agentdash-inbox");
    const rules = installDesktopInstructions(inboxDir, { skillText });
    const file = path.join(inboxDir, DESKTOP_INSTRUCTIONS_FILE);
    const own = rules.notInstalled.find((entry) => entry.file === file);
    entries.push({
      client: "desktop-instructions",
      file,
      status: own ? "kept" : rules.created.length + rules.updated.length > 0 ? "written" : "unchanged",
      ...(own ? { reason: own.reason === "own" ? "your own edited copy was kept" : `could not use it (${own.detail ?? "unknown"})` } : {}),
    });
  }
  if (clients.codex) {
    const result = applyCodexInboxMcp({
      serverName,
      instanceUrl,
      ...(paths.codexConfig ? { configPath: paths.codexConfig } : {}),
      platform,
    });
    entries.push({ client: "codex", ...result });
  }
  return entries;
}

/**
 * Remove the inbox entries this file wrote to Claude Desktop and Codex. The
 * Claude Code entry and the agent servers are removeConnection's (index.mjs).
 */
export function removeInboxClients({ serverName, paths = {}, now = () => new Date(), platform = process.platform }) {
  const name = inboxServerNameFor(serverName);
  const removed = [];
  const desktopConfig = paths.desktopConfig ?? claudeDesktopConfigPath({ platform });
  try {
    if (removeDesktopInboxServer(desktopConfig, name, now)) {
      removed.push({ harness: "desktop", file: `${desktopConfig} (${name})` });
    }
  } catch {
    // A Desktop config we cannot rewrite is left as it was; the rest still goes.
  }
  const codexConfig = paths.codexConfig ?? DEFAULT_CODEX_CONFIG;
  if (removeCodexInboxServer(codexConfig, name)) {
    removed.push({ harness: "codex", file: `${codexConfig} (${name})` });
  }
  return removed;
}

/**
 * What setupInboxClients did, as lines for the person: `{ text, problem }`,
 * where a problem goes to stderr. Says where each entry was written and the
 * one step each client still needs from them.
 */
export function describeClientEntries(entries) {
  const lines = [];
  for (const entry of entries) {
    const tag = (entry.client === "desktop-instructions" ? "desktop" : entry.client).padEnd(7);
    if (entry.status === "refused") {
      lines.push({ text: `  ${tag} ${entry.reason}; the inbox tools were not added there`, problem: true });
      continue;
    }
    const same = entry.status === "unchanged" ? " (already set up)" : "";
    switch (entry.client) {
      case "claude":
        lines.push({ text: `  ${tag} ${entry.file}${same}\n          "${entry.name}" — your own inbox tools: Claude reviews with you and sends only what you approve` });
        break;
      case "desktop":
        lines.push({
          text:
            `  ${tag} ${entry.file}${same}\n          "${entry.name}" — your inbox tools in Claude Desktop` +
            (entry.backup ? `; the previous file is saved as ${entry.backup}` : "") +
            (entry.status === "written" ? "\n          quit and reopen Claude Desktop to load them" : ""),
        });
        break;
      case "desktop-instructions":
        lines.push({
          text:
            entry.status === "kept"
              ? `  ${tag} ${entry.file} — ${entry.reason}`
              : `  ${tag} ${entry.file}${same}\n          Claude Desktop has no session-start hook: paste this file into the instructions of a\n          Claude Desktop project (for example "AgentDash inbox") and start inbox chats there`,
        });
        break;
      case "codex":
        lines.push({ text: `  ${tag} ${entry.file}${same}\n          "${entry.name}" — your own inbox tools in Codex; open ~/agentdash-inbox in Codex for the review rules (AGENTS.md)` });
        break;
      default:
        break;
    }
  }
  return lines;
}
