/**
 * The steward inbox, from the machine's side: store the endpoint credential,
 * scaffold the workspace whose SessionStart hook reads it, and do the read.
 *
 * This lives in agentdash-connect — the zero-dependency npx package — rather
 * than in the on-prem `paperclipai` CLI, for one reason: the machine being
 * connected is a colleague's laptop that has npx and nothing else. The previous
 * design scaffolded a hook that ran `paperclipai bridge inbox`, which meant the
 * documented flow ended at "command not found" on exactly the machines it was
 * written for. The render below mirrors `cli/src/commands/bridge-inbox.ts`
 * deliberately — same section order, same remainder lines, same closing
 * sentence — so the two clients never teach different readings of the same
 * inbox.
 *
 * Two rules inherited from that file, kept because they were learned the hard
 * way there:
 *
 * 1. **It never exits 2.** A `SessionStart` hook that exits 2 stops the session
 *    from starting. An unreachable inbox must never be able to stop a steward
 *    from working, so every failure is a non-blocking exit 1 with the reason on
 *    stderr.
 * 2. **`--ack` advances over the whole fetched page**, so anything not rendered
 *    is buried permanently. Approvals on the page that the digest no longer
 *    lists (already decided elsewhere) are therefore counted and named rather
 *    than silently skipped.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;

export function defaultTokenPath() {
  return path.join(os.homedir(), ".agentdash", "bridge-token");
}

export function defaultInboxDir() {
  return path.join(os.homedir(), "agentdash-inbox");
}

/**
 * Write the endpoint token where the inbox hook expects it. 0600 because it is
 * a live credential: whoever holds it reads this person's inbox and receives
 * their decision handles.
 */
export function storeBridgeToken(token, tokenPath = defaultTokenPath()) {
  mkdirSync(path.dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  // An existing file keeps its old mode through writeFileSync; tighten it.
  chmodSync(tokenPath, 0o600);
  return tokenPath;
}

export function resolveBridgeToken({ tokenFile, env = process.env } = {}) {
  const fromEnv = env.AGENTDASH_BRIDGE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const candidate = tokenFile ?? defaultTokenPath();
  if (existsSync(candidate)) {
    const value = readFileSync(candidate, "utf8").trim();
    if (value) return value;
  }
  throw new Error(
    `No bridge token at ${candidate} and AGENTDASH_BRIDGE_TOKEN is not set. ` +
      `Redeem a connect code (npx agentdash-connect) to create one.`,
  );
}

/**
 * The dedicated inbox workspace. The "never inject into an arbitrary coding
 * chat" rule is enforced by WHERE the hook is configured: a project-level
 * `.claude/settings.json` applies only to sessions started in that directory,
 * so a hook that lives here cannot fire anywhere else.
 */
export function scaffoldInboxWorkspace(dir, { server } = {}) {
  const created = [];
  const skipped = [];
  const claudeDir = path.join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const serverFlag = server ? ` --server ${server}` : "";
  // npx, not paperclipai: this package is the one thing guaranteed present,
  // because running it is how the workspace came to exist.
  const command = `npx -y agentdash-connect inbox --ack --quiet-when-empty${serverFlag}`;

  const settingsPath = path.join(claudeDir, "settings.json");
  if (existsSync(settingsPath)) {
    skipped.push(settingsPath);
  } else {
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                // Catch up when a session begins and when one resumes — both
                // are moments a steward is about to start reading.
                matcher: "startup|resume",
                hooks: [{ type: "command", command, timeout: 30 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    created.push(settingsPath);
  }

  const readmePath = path.join(dir, "README.md");
  if (existsSync(readmePath)) {
    skipped.push(readmePath);
  } else {
    writeFileSync(
      readmePath,
      [
        "# AgentDash inbox",
        "",
        "Open a Claude Code session **in this directory** to read your inbox.",
        "",
        "A `SessionStart` hook here runs `npx agentdash-connect inbox` and puts what is",
        "waiting on you into the session: approvals needing your decision first, then",
        "agents that stopped, then work that finished.",
        "",
        "## Why a separate directory",
        "",
        "So it cannot interrupt anything. The hook is configured in this project's",
        "`.claude/settings.json`, which applies only to sessions started here — your",
        "coding sessions elsewhere are untouched and always will be.",
        "",
        "## Deciding",
        "",
        "Ask in this session. The `inbox_decide` tool spends a handle that is good for",
        "one approval, at one revision, once. Handles are not accepted on the command",
        "line, because anything in a command line is readable by every user on this",
        "machine.",
        "",
        "## What arrives here",
        "",
        "The ask and a pointer, never the evidence. Anything delivered into a session",
        "becomes model context, so figures, client names and rates stay in AgentDash.",
        "",
      ].join("\n"),
    );
    created.push(readmePath);
  }

  return { created, skipped };
}

/** "and 4 more" — never silently. A shown list that hides its total lies. */
function remainder(section) {
  const hidden = section.total - section.shown;
  return hidden > 0 ? `  … and ${hidden} more (${section.total} in total)` : "";
}

function ageInWords(iso, now) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function issueLine(item) {
  const ref = item.identifier ? `${item.identifier} ` : "";
  const who = item.agentName ? ` (${item.agentName})` : "";
  return `  - ${ref}${item.title}${who}`;
}

/**
 * Approvals on this page that the digest does not list: decided elsewhere
 * since the page's events were written. `--ack` buries them regardless, so
 * they are counted rather than silently skipped.
 */
export function unseenApprovalCount(response) {
  const digest = response.digest;
  if (!digest) return 0;
  const shown = new Set(digest.approvals.items.map((item) => item.approvalId));
  const onPage = new Set(
    response.events
      .filter((event) => event.refType === "approval" && typeof event.refId === "string")
      .map((event) => event.refId),
  );
  let unseen = 0;
  for (const ref of onPage) if (!shown.has(ref)) unseen += 1;
  return unseen;
}

/** The plain-text rendering a SessionStart hook feeds straight into a session. */
export function renderInbox(response, now) {
  const digest = response.digest;
  const lines = [];

  if (!digest) {
    lines.push(`AgentDash inbox: ${response.events.length} new event(s).`);
    return lines.join("\n");
  }

  const nothing =
    digest.approvals.total === 0 && digest.blockers.total === 0 && digest.completions.total === 0;
  if (nothing) {
    const other = unseenApprovalCount(response);
    if (other > 0) {
      return `AgentDash inbox: nothing waiting on you. ${other} other update(s) already dealt with.`;
    }
    return "AgentDash inbox: nothing waiting on you.";
  }

  lines.push("AgentDash inbox");
  lines.push("");

  // Order is the contract: urgent approvals, then blockers, then completions.
  if (digest.approvals.total > 0) {
    lines.push(`Waiting on your decision (${digest.approvals.total}):`);
    for (const item of digest.approvals.items) {
      const who = item.agentName ? `${item.agentName} — ` : "";
      lines.push(
        `  - ${who}${item.type} [${item.risk.level}: ${item.risk.reason}], rev ${item.revision}, waiting ${ageInWords(item.waitingSince, now)}`,
      );
    }
    const more = remainder(digest.approvals);
    if (more) lines.push(more);
    lines.push("");
  }

  if (digest.blockers.total > 0) {
    lines.push(`Stopped and needs you (${digest.blockers.total}):`);
    for (const item of digest.blockers.items) lines.push(issueLine(item));
    const more = remainder(digest.blockers);
    if (more) lines.push(more);
    lines.push("");
  }

  if (digest.completions.total > 0) {
    lines.push(`Finished (${digest.completions.total}):`);
    for (const item of digest.completions.items) lines.push(issueLine(item));
    const more = remainder(digest.completions);
    if (more) lines.push(more);
    lines.push("");
  }

  const other = unseenApprovalCount(response);
  if (other > 0) {
    lines.push(`(${other} approval(s) on this page were already decided elsewhere.)`);
  }
  lines.push(
    "Decide with the inbox_decide tool. Details are in AgentDash — nothing above carries the evidence.",
  );
  return lines.join("\n").trimEnd();
}

/** Read the instance URL the connect flow already saved, so `inbox` needs no flags. */
export function resolveInboxServer({ server, env = process.env, claudeConfigPath } = {}) {
  if (server) return server.replace(/\/+$/, "").replace(/\/api$/, "");
  const fromEnv = env.AGENTDASH_BRIDGE_SERVER?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "").replace(/\/api$/, "");
  // The connect flow wrote an MCP endpoint into ~/.claude.json; its origin is
  // the instance. Best-effort — a missing or unparseable file just means the
  // caller has to pass --server.
  try {
    const configPath = claudeConfigPath ?? path.join(os.homedir(), ".claude.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    for (const entry of Object.values(config?.mcpServers ?? {})) {
      const url = entry?.url;
      if (typeof url === "string" && /\/api\/mcp\/?$/.test(url)) {
        return url.replace(/\/api\/mcp\/?$/, "");
      }
    }
  } catch {
    /* fall through */
  }
  throw new Error(
    "No instance address found. Pass --server <url> or set AGENTDASH_BRIDGE_SERVER.",
  );
}

/**
 * Sync, render, optionally acknowledge. Returns a process exit code — 1 for
 * every failure, by the hook rule above.
 */
export async function runInbox(opts = {}, deps = {}) {
  const log = deps.log ?? ((line) => process.stdout.write(`${line}\n`));
  const errorLog = deps.errorLog ?? ((line) => process.stderr.write(`${line}\n`));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ? deps.now() : Date.now();

  let server;
  let token;
  try {
    server = resolveInboxServer(opts);
    token = resolveBridgeToken(opts);
  } catch (err) {
    errorLog(err?.message ?? String(err));
    return 1;
  }

  let response;
  try {
    const res = await fetchImpl(`${server}/api/bridge/inbox/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ includeDigest: true }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      errorLog(`AgentDash inbox unavailable: ${res.status} ${body.slice(0, 200)}`);
      return 1;
    }
    response = await res.json();
  } catch (err) {
    errorLog(`AgentDash inbox unreachable: ${err?.message ?? String(err)}`);
    return 1;
  }

  const digest = response.digest;
  const empty =
    response.events.length === 0 &&
    (!digest ||
      (digest.approvals.total === 0 && digest.blockers.total === 0 && digest.completions.total === 0));

  if (!(empty && opts.quietWhenEmpty)) {
    log(renderInbox(response, now));
  }

  if (opts.ack && response.events.length > 0) {
    const highest = response.events[response.events.length - 1].seq;
    try {
      const res = await fetchImpl(`${server}/api/bridge/inbox/ack`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ seq: highest }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) errorLog(`Could not acknowledge up to ${highest}: ${res.status}`);
    } catch (err) {
      // Not a failure exit: the events were rendered, the cursor did not move,
      // and the next sync returns them again. That is at-least-once delivery.
      errorLog(`Could not acknowledge up to ${highest}: ${err?.message ?? String(err)}`);
    }
  }

  return 0;
}
