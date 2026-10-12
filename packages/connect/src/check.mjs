/**
 * `npx agentdash-connect check`: which clients are connected, whose inbox
 * this machine holds, and whether the person's own Claude can review work
 * (`bridge:work`).
 *
 * Read-only. It reads the clients' config files and asks the instance one
 * question with the inbox credential (`POST /api/bridge/whoami`), which moves
 * no cursor and mints no handle. It never prints the credential.
 */

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  DESKTOP_INSTRUCTIONS_FILE,
  claudeDesktopConfigPath,
  readCodexStdioServer,
  readDesktopInboxServer,
} from "./clients.mjs";
import { inboxServerNameFor } from "./index.mjs";
import { defaultInboxDir, defaultOwnerPath, defaultTokenPath, readBridgeOwner, resolveInboxServer } from "./inbox.mjs";

const TIMEOUT_MS = 15_000;
export const WORK_CAPABILITY = "bridge:work";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The value after `--server` in an inbox launch, if any. */
function serverArg(entry) {
  const args = Array.isArray(entry?.args) ? entry.args : [];
  const at = args.indexOf("--server");
  return at >= 0 && typeof args[at + 1] === "string" ? args[at + 1] : null;
}

export function defaultCheckPaths() {
  return {
    claudeConfig: path.join(os.homedir(), ".claude.json"),
    codexConfig: path.join(os.homedir(), ".codex", "config.toml"),
    desktopConfig: claudeDesktopConfigPath(),
    inboxDir: defaultInboxDir(),
    tokenPath: defaultTokenPath(),
    ownerPath: defaultOwnerPath(),
  };
}

/**
 * The inbox entry in each client's config. `installed` says which clients
 * are on this machine ({ claude, codex, desktop }); a client that is not
 * installed is reported as such, not as a fault.
 */
export function inspectClients({ serverName, paths, installed }) {
  const name = inboxServerNameFor(serverName);
  const claudeEntry = readJson(paths.claudeConfig)?.mcpServers?.[name] ?? null;
  const desktopEntry = readDesktopInboxServer(paths.desktopConfig, name);
  const codexEntry = readCodexStdioServer(readText(paths.codexConfig), name);
  const instructionsFile = path.join(paths.inboxDir, DESKTOP_INSTRUCTIONS_FILE);
  return {
    name,
    claude: { installed: Boolean(installed.claude), connected: Boolean(claudeEntry), server: serverArg(claudeEntry), file: paths.claudeConfig },
    desktop: {
      installed: Boolean(installed.desktop),
      connected: Boolean(desktopEntry),
      server: serverArg(desktopEntry),
      file: paths.desktopConfig,
      instructions: existsSync(instructionsFile),
      instructionsFile,
    },
    codex: { installed: Boolean(installed.codex), connected: Boolean(codexEntry), server: serverArg(codexEntry), file: paths.codexConfig },
    rules: {
      skill: existsSync(path.join(paths.inboxDir, ".claude", "skills", "agentdash-coworker", "SKILL.md")),
      agentsMd: existsSync(path.join(paths.inboxDir, "AGENTS.md")),
      dir: paths.inboxDir,
    },
  };
}

function readToken(tokenPath, env) {
  const fromEnv = env.AGENTDASH_BRIDGE_TOKEN?.trim();
  if (fromEnv) return { present: true, path: "AGENTDASH_BRIDGE_TOKEN", value: fromEnv };
  try {
    const value = readFileSync(tokenPath, "utf8").trim();
    if (value) return { present: true, path: tokenPath, value };
  } catch {
    /* missing */
  }
  return { present: false, path: tokenPath, value: null };
}

/** Where the inbox lives: the flag, the environment, then what the clients were given. */
function resolveServer({ server, env, clients, paths }) {
  const clean = (url) => url.replace(/\/+$/, "").replace(/\/api$/, "");
  if (server) return clean(server);
  if (env.AGENTDASH_BRIDGE_SERVER?.trim()) return clean(env.AGENTDASH_BRIDGE_SERVER.trim());
  for (const client of [clients.claude, clients.desktop, clients.codex]) {
    if (client.server) return clean(client.server);
  }
  const owner = readBridgeOwner(paths.ownerPath);
  if (typeof owner?.server === "string" && owner.server) return clean(owner.server);
  try {
    return resolveInboxServer({ env, claudeConfigPath: paths.claudeConfig });
  } catch {
    return null;
  }
}

/** Ask the instance about this machine's own credential. */
async function askWhoami(server, token, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${server}/api/bridge/whoami`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { status: "unreachable", reason: err?.message ?? String(err) };
  }
  if (res.status === 401 || res.status === 403) return { status: "rejected", httpStatus: res.status };
  if (res.status === 404) return { status: "unsupported" };
  if (!res.ok) return { status: "error", httpStatus: res.status };
  let body;
  try {
    body = await res.json();
  } catch {
    return { status: "error", httpStatus: res.status };
  }
  return {
    status: "ok",
    owner: body?.owner ?? null,
    label: typeof body?.endpoint?.label === "string" ? body.endpoint.label : null,
    capabilities: Array.isArray(body?.endpoint?.capabilities) ? body.endpoint.capabilities.filter((c) => typeof c === "string") : [],
    coworkerBridgeEnabled: body?.coworkerBridgeEnabled === true,
  };
}

const row = (label, value) => `  ${label.padEnd(16)}${value}`;

function clientLine(label, client) {
  if (client.connected) return row(label, "connected");
  if (!client.installed) return row(label, "not installed");
  return row(label, "not connected");
}

/**
 * The report as lines, and whether everything this machine has is working.
 * A client that is not installed is not a fault; one that is installed
 * without the inbox tools is.
 */
export function renderCheck(report) {
  const lines = [];
  const problems = [];
  const { agent, clients, token, server, remote } = report;

  if (agent?.configured) {
    lines.push(`Agent tools ("${report.serverName ?? "agentdash"}")`);
    lines.push(row("Claude Code", agent.claudeServer ? "configured" : "not configured"));
    lines.push(row("Codex", agent.codexServer ? `configured (reads ${agent.codexServer.envVar})` : "not configured"));
    if (agent.verified) {
      lines.push(row("Status", `working — ${agent.verified.toolCount} tools available`));
    } else {
      lines.push(row("Status", `NOT working — ${agent.reason ?? "unknown reason"}`));
      problems.push("agent");
    }
  } else {
    lines.push(`Agent tools       not configured on this machine (redeem a connect code: npx agentdash-connect <CODE>)`);
    problems.push("agent");
  }
  lines.push("");

  lines.push(`Your inbox ("${clients.name}")`);
  lines.push(clientLine("Claude Code", clients.claude));
  lines.push(clientLine("Claude Desktop", clients.desktop));
  lines.push(clientLine("Codex", clients.codex));
  for (const client of [clients.claude, clients.desktop, clients.codex]) {
    if (client.installed && !client.connected) problems.push("client");
  }
  if (clients.rules.skill && clients.rules.agentsMd) lines.push(row("Review rules", `installed in ${clients.rules.dir}`));
  else lines.push(row("Review rules", `missing in ${clients.rules.dir} (the next connect or inbox session installs them)`));

  if (!token.present) {
    lines.push(row("Credential", `missing (${token.path}) — redeem a new connect code: npx agentdash-connect <CODE>`));
    problems.push("token");
  } else {
    lines.push(row("Credential", token.path));
  }
  lines.push(row("Instance", server ?? "unknown — pass --server <url>"));
  if (token.present && !server) problems.push("server");

  if (remote) {
    if (remote.status === "ok") {
      const owner = remote.owner?.name || remote.owner?.email || "unknown";
      const email = remote.owner?.name && remote.owner?.email ? ` (${remote.owner.email})` : "";
      lines.push(row("Owner", `${owner}${email}`));
      if (remote.label) lines.push(row("This machine", remote.label));
      lines.push(row("Capabilities", remote.capabilities.length > 0 ? remote.capabilities.join(", ") : "none"));
      const hasWork = remote.capabilities.includes(WORK_CAPABILITY);
      if (hasWork) {
        lines.push(row(WORK_CAPABILITY, "present"));
        lines.push(
          row(
            "Review",
            remote.coworkerBridgeEnabled
              ? "ready"
              : "not turned on for your company yet (an administrator turns on co-worker review)",
          ),
        );
      } else {
        lines.push(row(WORK_CAPABILITY, "missing — review not enabled; reconnect with a new connect code"));
        problems.push("work");
      }
    } else if (remote.status === "rejected") {
      lines.push(row("Inbox", `credential not accepted (${remote.httpStatus}): disconnected, replaced, or the instance is older than this check; reconnect with a new connect code`));
      problems.push("remote");
    } else if (remote.status === "unsupported") {
      lines.push(row("Inbox", "this AgentDash instance is older than this check and cannot report capabilities"));
      problems.push("remote");
    } else if (remote.status === "unreachable") {
      lines.push(row("Inbox", `unreachable: ${remote.reason}`));
      problems.push("remote");
    } else {
      lines.push(row("Inbox", `unavailable (${remote.httpStatus})`));
      problems.push("remote");
    }
  }

  if (clients.desktop.installed) {
    lines.push("");
    lines.push(
      `Claude Desktop has no session-start hook: paste ${clients.desktop.instructionsFile} into the instructions of a Claude Desktop project once, and start inbox chats in that project.`,
    );
    if (!clients.desktop.instructions) {
      lines.push("  (That file is not there yet: run npx agentdash-connect clients to write it.)");
    }
  }
  if (problems.includes("client")) {
    lines.push("");
    lines.push("To add your inbox tools to a client installed since you connected: npx agentdash-connect clients");
  }

  return { lines, ok: problems.length === 0 };
}

/**
 * Gather the report and print it. Returns the exit code: 0 when everything
 * this machine has is working and review is enabled for it, 1 otherwise.
 *
 * `deps.installed` ({ claude, codex, desktop }) and `deps.checkAgent` come
 * from the caller, which owns detecting harnesses and the agent connection.
 */
export async function runCheck(opts = {}, deps = {}) {
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const paths = { ...defaultCheckPaths(), ...(deps.paths ?? {}) };
  const serverName = opts.serverName ?? "agentdash";

  const agent = deps.checkAgent ? await deps.checkAgent() : { configured: false };
  const clients = inspectClients({ serverName, paths, installed: deps.installed ?? {} });
  const token = readToken(paths.tokenPath, env);
  const server = resolveServer({ server: opts.server, env, clients, paths });
  const remote = token.present && server ? await askWhoami(server, token.value, deps.fetchImpl ?? fetch) : null;

  const { lines, ok } = renderCheck({ serverName, agent, clients, token: { present: token.present, path: token.path }, server, remote });
  for (const line of lines) log(line);
  return ok ? 0 : 1;
}
