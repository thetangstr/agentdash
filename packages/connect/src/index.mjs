/**
 * agentdash-connect: turn a link and a key into a working harness connection.
 *
 * The thing this replaces is a prompt you paste. A prompt is a suggestion --
 * editable, truncatable, silent when it fails. This is a config write with an
 * exit code, and `--remove` puts everything back.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  envVarNameFor,
  inboxMcpLaunch,
  mcpEndpointFor,
  normalizeInstanceUrl,
  readClaudeServer,
  readCodexServer,
  removeClaudeConfig,
  removeCodexToml,
  upsertClaudeConfig,
  upsertClaudeStdioServer,
  upsertCodexToml,
} from "./harnesses.mjs";
import {
  deleteSecret,
  ensureProfileLine,
  profileLineMarker,
  readSecret,
  removeProfileLine,
  shellProfileLine,
  storeSecret,
} from "./secrets.mjs";
import { VerifyError, verifyConnection } from "./verify.mjs";

export { VerifyError, verifyConnection, normalizeInstanceUrl, mcpEndpointFor };

export const DEFAULT_SERVER_NAME = "agentdash";

const CLAUDE_CONFIG = path.join(os.homedir(), ".claude.json");
const CODEX_CONFIG = path.join(os.homedir(), ".codex", "config.toml");

function commandExists(command) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", timeout: 10_000 });
  return !probe.error && probe.status === 0;
}

/** Which harnesses are actually on this machine. */
export function detectHarnesses() {
  return {
    claude: commandExists("claude"),
    codex: commandExists("codex"),
  };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  // An existing file keeps its old mode through writeFileSync, so say it again.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort: a stricter umask or an exotic filesystem is not a failure.
  }
}

function readTextFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeTextFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

/**
 * Every startup file the user's shell might read — not just one.
 *
 * `.zshrc` is sourced for INTERACTIVE shells only, so a Codex started from a
 * GUI app, a script, or an MDM task finds no key and fails in a way that looks
 * like a bad credential rather than a missing environment. `.zprofile` covers
 * the login case. Writing both is the difference between "works in my terminal"
 * and "works".
 */
export function shellProfilePaths(shell = process.env.SHELL ?? "") {
  const home = os.homedir();
  if (shell.includes("zsh")) return [path.join(home, ".zshrc"), path.join(home, ".zprofile")];
  if (shell.includes("bash")) return [path.join(home, ".bashrc"), path.join(home, ".bash_profile")];
  // fish reads config.fish for both interactive and login shells.
  if (shell.includes("fish")) return [path.join(home, ".config", "fish", "config.fish")];
  return [path.join(home, ".profile")];
}

/**
 * Write config for every harness present. Verification is the caller's job and
 * must already have happened -- this function only writes.
 */
export function applyConnection({ serverName, instanceUrl, key, harnesses, account }) {
  const endpoint = mcpEndpointFor(instanceUrl);
  const envVar = envVarNameFor(serverName);
  const written = [];

  if (harnesses.claude) {
    const config = readJsonFile(CLAUDE_CONFIG) ?? {};
    writeJsonFile(CLAUDE_CONFIG, upsertClaudeConfig(config, serverName, { url: endpoint, key }));
    written.push({
      harness: "claude",
      file: CLAUDE_CONFIG,
      // Said out loud because it is the one place the key rests in plaintext.
      note: "stores the key in this file (mode 600)",
    });
  }

  let backend = null;
  if (harnesses.codex) {
    backend = storeSecret(account, key);
    writeTextFile(
      CODEX_CONFIG,
      upsertCodexToml(readTextFile(CODEX_CONFIG), serverName, { url: endpoint, envVar }),
    );
    const line = shellProfileLine(envVar, account, backend);
    const marker = profileLineMarker(account);
    written.push({
      harness: "codex",
      file: CODEX_CONFIG,
      note: `reads ${envVar} at runtime; key stored in the ${backend}`,
    });
    for (const profile of shellProfilePaths()) {
      if (!ensureProfileLine(profile, line, marker)) continue;
      written.push({
        harness: "codex",
        file: profile,
        note: `one line exporting ${envVar} — open a new terminal for it to take effect`,
      });
    }
  }

  return { endpoint, envVar, written, secretBackend: backend };
}

/** The inbox tools' server name sits beside the agent's, so --remove finds both. */
export const inboxServerNameFor = (serverName) => `${serverName}-inbox`;

/**
 * Give Claude Code the person's own inbox tools. Separate from
 * `applyConnection` because it rides the OTHER credential: the agent key above
 * is the agent, this is the person, and the two must never share a server
 * entry. The token itself stays in ~/.agentdash/bridge-token; the config names
 * only the command, so no secret is written here.
 */
export function applyInboxMcp({ serverName, instanceUrl, configPath = CLAUDE_CONFIG }) {
  const name = inboxServerNameFor(serverName);
  const config = readJsonFile(configPath) ?? {};
  writeJsonFile(configPath, upsertClaudeStdioServer(config, name, inboxMcpLaunch({ server: instanceUrl })));
  return { name, file: configPath };
}

/** Undo everything `applyConnection` did, reporting what was actually there. */
export function removeConnection({ serverName, account }) {
  const removed = [];

  let claudeConfig = readJsonFile(CLAUDE_CONFIG);
  for (const name of [serverName, inboxServerNameFor(serverName)]) {
    if (claudeConfig && readClaudeServer(claudeConfig, name)) {
      claudeConfig = removeClaudeConfig(claudeConfig, name);
      writeJsonFile(CLAUDE_CONFIG, claudeConfig);
      removed.push({ harness: "claude", file: `${CLAUDE_CONFIG} (${name})` });
    }
  }

  const codexText = readTextFile(CODEX_CONFIG);
  if (readCodexServer(codexText, serverName)) {
    writeTextFile(CODEX_CONFIG, removeCodexToml(codexText, serverName));
    removed.push({ harness: "codex", file: CODEX_CONFIG });
  }

  for (const profile of shellProfilePaths()) {
    if (removeProfileLine(profile, profileLineMarker(account))) {
      removed.push({ harness: "codex", file: profile });
    }
  }
  if (deleteSecret(account)) {
    removed.push({ harness: "codex", file: "stored key" });
  }

  return { removed };
}

/** What is currently configured, and does it still work? */
export async function checkConnection({ serverName, account }) {
  const claudeConfig = readJsonFile(CLAUDE_CONFIG);
  const claudeServer = claudeConfig ? readClaudeServer(claudeConfig, serverName) : null;
  const codexServer = readCodexServer(readTextFile(CODEX_CONFIG), serverName);

  const endpoint = claudeServer?.url ?? codexServer?.url ?? null;
  if (!endpoint) {
    return { configured: false, endpoint: null, claudeServer, codexServer, verified: null };
  }

  const key =
    claudeServer?.headers?.Authorization?.replace(/^Bearer\s+/i, "") ?? readSecret(account);
  if (!key) {
    return {
      configured: true,
      endpoint,
      claudeServer,
      codexServer,
      verified: null,
      reason: "configured, but no key is retrievable from this machine",
    };
  }

  try {
    return {
      configured: true,
      endpoint,
      claudeServer,
      codexServer,
      verified: await verifyConnection(endpoint, key),
    };
  } catch (error) {
    return {
      configured: true,
      endpoint,
      claudeServer,
      codexServer,
      verified: null,
      reason: error.message,
    };
  }
}
