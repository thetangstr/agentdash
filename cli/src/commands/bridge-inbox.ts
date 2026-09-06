import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveServer, resolveToken } from "./bridge-run.js";

/**
 * AgentDash-MK: read the steward inbox from this machine.
 *
 * This is the client half of the inbox. The server has kept a durable
 * per-person log, a position per machine, and single-use decision handles for
 * a while; nothing read them, so none of it reached anybody.
 *
 * Two things this command deliberately does NOT do:
 *
 * 1. **It does not decide.** Resolving an approval needs a handle, and a handle
 *    is a credential — putting one in argv would make it readable by every
 *    local user through `ps`, which is exactly why `bridge run` refuses
 *    `--token`. Deciding lives in the MCP tools, where the handle never leaves
 *    the process.
 * 2. **It never exits 2.** A `SessionStart` hook that exits 2 stops the session
 *    from starting at all. An unreachable inbox must never be able to stop a
 *    steward from working, so every failure here is a non-blocking exit 1 with
 *    the reason on stderr.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export interface BridgeInboxOptions {
  server?: string;
  tokenFile?: string;
  ack?: boolean;
  json?: boolean;
  quietWhenEmpty?: boolean;
  limit?: string;
}

export interface BridgeInboxDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  now?: () => number;
}

interface DigestSection<T> {
  total: number;
  shown: number;
  items: T[];
}

interface InboxSyncResponse {
  lastAckedSeq: number;
  headSeq: number;
  hasMore: boolean;
  events: Array<{
    seq: number;
    kind: string;
    refType: string;
    refId: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
  digest?: {
    agentsAnsweredFor: number;
    approvals: DigestSection<{
      approvalId: string;
      type: string;
      revision: number;
      agentName: string | null;
      risk: { level: string; reason: string };
      waitingSince: string;
    }>;
    blockers: DigestSection<{ identifier: string | null; title: string; agentName: string | null }>;
    completions: DigestSection<{ identifier: string | null; title: string; agentName: string | null }>;
    truncated: boolean;
  };
}

/** "and 4 more" — never silently. A shown list that hides its total lies. */
function remainder(section: DigestSection<unknown>): string {
  const hidden = section.total - section.shown;
  return hidden > 0 ? `  … and ${hidden} more (${section.total} in total)` : "";
}

function ageInWords(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function issueLine(item: { identifier: string | null; title: string; agentName: string | null }) {
  const ref = item.identifier ? `${item.identifier} ` : "";
  const who = item.agentName ? ` (${item.agentName})` : "";
  return `  - ${ref}${item.title}${who}`;
}

/** The plain-text rendering a SessionStart hook feeds straight into a session. */
export function renderInbox(response: InboxSyncResponse, now: number): string {
  const digest = response.digest;
  const lines: string[] = [];

  if (!digest) {
    lines.push(`AgentDash inbox: ${response.events.length} new event(s).`);
    return lines.join("\n");
  }

  const nothing =
    digest.approvals.total === 0 && digest.blockers.total === 0 && digest.completions.total === 0;
  if (nothing) {
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

  lines.push(
    "Decide with the inbox_decide tool. Details are in AgentDash — nothing above carries the evidence.",
  );
  return lines.join("\n").trimEnd();
}

export async function runBridgeInbox(
  opts: BridgeInboxOptions,
  deps: BridgeInboxDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const errorLog = deps.errorLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ? deps.now() : Date.now();

  let server: string;
  let token: string;
  try {
    server = resolveServer(opts, env);
    token = resolveToken(opts, env, errorLog);
  } catch (err) {
    errorLog(err instanceof Error ? err.message : String(err));
    // Exit 1, never 2: a missing credential must not stop a session starting.
    return 1;
  }

  const limit = opts.limit === undefined ? undefined : Number(opts.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    errorLog(`--limit must be a positive integer (got "${opts.limit}").`);
    return 1;
  }

  let response: InboxSyncResponse;
  try {
    const res = await fetchImpl(`${server}/api/bridge/inbox/sync`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ includeDigest: true, ...(limit === undefined ? {} : { limit }) }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      errorLog(`AgentDash inbox unavailable: ${res.status} ${body.slice(0, 200)}`);
      return 1;
    }
    response = (await res.json()) as InboxSyncResponse;
  } catch (err) {
    errorLog(
      `AgentDash inbox unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const digest = response.digest;
  const empty =
    response.events.length === 0 &&
    (!digest ||
      (digest.approvals.total === 0 &&
        digest.blockers.total === 0 &&
        digest.completions.total === 0));

  if (opts.json) {
    log(JSON.stringify(response, null, 2));
  } else if (!(empty && opts.quietWhenEmpty)) {
    log(renderInbox(response, now));
  }

  if (opts.ack && response.events.length > 0) {
    const highest = response.events[response.events.length - 1]!.seq;
    try {
      const res = await fetchImpl(`${server}/api/bridge/inbox/ack`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ seq: highest }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) errorLog(`Could not acknowledge up to ${highest}: ${res.status}`);
    } catch (err) {
      errorLog(
        `Could not acknowledge up to ${highest}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Deliberately not a failure exit. The events were rendered; the cursor
      // simply did not move, and the next sync returns them again. That is what
      // at-least-once delivery is for.
    }
  }

  return 0;
}

/**
 * The dedicated inbox workspace, scaffolded.
 *
 * The "never inject into an arbitrary coding chat" rule is enforced by WHERE
 * the hook is configured, not by a condition inside it. A project-level
 * `.claude/settings.json` applies only to sessions started in that directory,
 * so a hook that lives here cannot fire anywhere else. A globally installed
 * hook that checks whether it should run would be one edit away from firing in
 * everybody's coding sessions.
 */
export function scaffoldInboxWorkspace(
  dir: string,
  options: { server?: string; tokenFile?: string } = {},
): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];
  const claudeDir = path.join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const serverFlag = options.server ? ` --server ${options.server}` : "";
  const tokenFlag = options.tokenFile ? ` --token-file ${options.tokenFile}` : "";
  const command = `paperclipai bridge inbox --ack --quiet-when-empty${serverFlag}${tokenFlag}`;

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
                // Catch up when a session begins and when one resumes. Both are
                // moments a steward is about to start reading.
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
        "A `SessionStart` hook here runs `paperclipai bridge inbox` and puts what is",
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

export function registerBridgeInboxCommands(bridge: Command): Command {
  bridge
    .command("inbox")
    .description("Read your AgentDash steward inbox: approvals, blockers, then completions")
    .option("--server <url>", "AgentDash server URL (or AGENTDASH_BRIDGE_SERVER)")
    .option("--token-file <path>", "File containing the endpoint token (or AGENTDASH_BRIDGE_TOKEN)")
    .option("--ack", "Acknowledge the events shown, so they are not shown again")
    .option("--json", "Print the raw sync response instead of the readable summary")
    .option("--quiet-when-empty", "Print nothing when nothing is waiting (for hooks)")
    .option("--limit <n>", "Maximum events to fetch")
    .action(async (opts: BridgeInboxOptions) => {
      process.exitCode = await runBridgeInbox(opts);
    });

  bridge
    .command("inbox-init")
    .description("Create a dedicated inbox workspace whose SessionStart hook reads your inbox")
    .argument("[dir]", "Directory to create the workspace in", "./agentdash-inbox")
    .option("--server <url>", "Bake an explicit server URL into the hook command")
    .option("--token-file <path>", "Bake an explicit token file path into the hook command")
    .action((dir: string, opts: { server?: string; tokenFile?: string }) => {
      const target = path.resolve(dir);
      const { created, skipped } = scaffoldInboxWorkspace(target, opts);
      for (const file of created) process.stdout.write(`created ${file}\n`);
      for (const file of skipped) process.stdout.write(`kept existing ${file}\n`);
      process.stdout.write(`\nOpen a Claude Code session in ${target} to read your inbox.\n`);
    });

  return bridge;
}
