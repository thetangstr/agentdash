import { mkdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import type { Command } from "commander";
import pc from "picocolors";
import {
  assertSandboxSupported,
  parseEgressPolicy,
  type EgressPolicy,
  type TaskExecutor,
} from "../bridge/sandbox.js";
import { DEFAULT_INTERVAL_MS, runBridgeWorker } from "../bridge/worker.js";

/**
 * AgentDash-MK: `agentdash bridge run` — the local bridge worker.
 *
 * Runs on a human's own machine, polls AgentDash for tasks, executes each one
 * under a macOS Seatbelt profile in a throwaway workspace, and submits the
 * result. Three refusals are deliberate and come before anything else happens:
 * no sandbox, no run; no explicit egress choice, no run; no token off the
 * command line, ever.
 */

export const TOKEN_ARGV_MESSAGE =
  "Refusing to start: the endpoint token must not be passed as a command-line argument.\n" +
  "`argv` is world-readable via `ps` on a shared machine, so a token there is a token\n" +
  "leaked to every local user. Use one of:\n" +
  "  AGENTDASH_BRIDGE_TOKEN=<token> agentdash bridge run …\n" +
  "  agentdash bridge run --token-file /path/to/token";

const TOKEN_MISSING_MESSAGE =
  "Refusing to start: no endpoint token found.\n" +
  "Set AGENTDASH_BRIDGE_TOKEN in the environment, or pass --token-file <path>.\n" +
  "The token is minted once, when the endpoint enrollment is approved.";

const SERVER_MISSING_MESSAGE =
  "Refusing to start: no server URL.\n" +
  "Set AGENTDASH_BRIDGE_SERVER in the environment, or pass --server <url>.";

export interface BridgeRunOptions {
  server?: string;
  tokenFile?: string;
  /** Declared only so the refusal is ours and legible. Never usable. */
  token?: string;
  egress?: string;
  interval?: string;
  claudeBin?: string;
  workspaceRoot?: string;
}

export interface BridgeRunDeps {
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  executor?: TaskExecutor;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  stopSignal?: AbortSignal;
}

function resolveToken(opts: BridgeRunOptions, env: NodeJS.ProcessEnv, warn: (line: string) => void): string {
  if (opts.tokenFile) {
    let contents: string;
    try {
      contents = readFileSync(opts.tokenFile, "utf8");
    } catch (err) {
      throw new Error(
        `Refusing to start: cannot read --token-file ${opts.tokenFile}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const token = contents.trim();
    if (!token) throw new Error(`Refusing to start: --token-file ${opts.tokenFile} is empty.`);
    try {
      const mode = statSync(opts.tokenFile).mode & 0o077;
      if (mode !== 0) {
        warn(
          pc.yellow(
            `[bridge] warning: ${opts.tokenFile} is readable by other users on this machine (chmod 600 it).`,
          ),
        );
      }
    } catch {
      // Unreadable stat is not worth failing a start over; the read succeeded.
    }
    return token;
  }

  const fromEnv = (env.AGENTDASH_BRIDGE_TOKEN ?? "").trim();
  if (!fromEnv) throw new Error(TOKEN_MISSING_MESSAGE);
  return fromEnv;
}

function resolveIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_INTERVAL_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 1) {
    throw new Error(`Refusing to start: --interval must be a number of seconds >= 1 (got "${raw}").`);
  }
  return Math.round(seconds * 1000);
}

function posturePreamble(egress: EgressPolicy, log: (line: string) => void): void {
  log(pc.cyan("[bridge] containment: macOS Seatbelt, per-task workspace, home directory denied"));
  if (egress === "loopback") {
    log(
      pc.cyan(
        "[bridge] egress: loopback — all outbound egress denied except localhost. Reaching\n" +
          "         api.anthropic.com requires a local allowlisting proxy on loopback.",
      ),
    );
    return;
  }
  // Say it plainly. An operator who chose this should see what they chose.
  log(
    pc.yellow(
      "[bridge] egress: direct — WEAKER POSTURE. Outbound 443 is allowed, so the agent\n" +
        "         reaches api.anthropic.com (and any other 443 host) with no proxy in\n" +
        "         front of it. Nothing inspects or allowlists that traffic. The home\n" +
        "         directory deny still applies — that is not a dial.",
    ),
  );
}

export async function bridgeRun(opts: BridgeRunOptions, deps: BridgeRunDeps = {}): Promise<void> {
  // Belt and braces: the option's parser already refuses, but a programmatic
  // caller could construct these options directly.
  if (opts.token) throw new Error(TOKEN_ARGV_MESSAGE);

  // Confinement first. Nothing below this line may run on a host that cannot
  // provide it — there is no unsandboxed fallback by design.
  assertSandboxSupported({ platform: deps.platform, isExecutable: deps.isExecutable });

  const egress = parseEgressPolicy(opts.egress);

  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorLog = deps.errorLog ?? ((line: string) => console.error(line));

  const serverUrl = (opts.server ?? env.AGENTDASH_BRIDGE_SERVER ?? "").trim();
  if (!serverUrl) throw new Error(SERVER_MISSING_MESSAGE);

  const token = resolveToken(opts, env, log);
  const intervalMs = resolveIntervalMs(opts.interval);
  const workspaceRoot = opts.workspaceRoot ?? os.tmpdir();
  mkdirSync(workspaceRoot, { recursive: true });

  const controller = new AbortController();
  const stopSignal = deps.stopSignal ?? controller.signal;
  const ownsSignals = deps.stopSignal === undefined;

  const stop = (signal: string) => {
    if (controller.signal.aborted) {
      // Second signal. Registering a handler replaced Node's default, so
      // without this an impatient operator's Ctrl-C would do nothing at all
      // while a long task runs.
      errorLog(pc.yellow(`[bridge] second ${signal} — exiting now, abandoning the in-flight task.`));
      process.exit(130);
    }
    log(pc.cyan(`[bridge] ${signal} received — finishing the current task, then stopping.`));
    controller.abort();
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  if (ownsSignals) {
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }

  log(pc.cyan(`[bridge] polling ${serverUrl} every ${Math.round(intervalMs / 1000)}s`));
  posturePreamble(egress, log);

  try {
    await runBridgeWorker({
      serverUrl,
      token,
      egress,
      intervalMs,
      claudeBin: opts.claudeBin ?? "claude",
      workspaceRoot,
      homeDir: deps.homeDir ?? os.homedir(),
      executor: deps.executor,
      fetchImpl: deps.fetchImpl,
      log,
      errorLog,
      sleep: deps.sleep,
      stopSignal,
    });
  } finally {
    if (ownsSignals) {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  }
}

export function registerBridgeCommands(program: Command): Command {
  const bridge = program
    .command("bridge")
    .description("AgentDash-MK local bridge — run agent tasks on this machine, sandboxed");

  bridge
    .command("run")
    .description("Poll AgentDash for tasks and run them under a macOS sandbox (macOS only)")
    .option("--server <url>", "AgentDash server URL (or AGENTDASH_BRIDGE_SERVER)")
    .option("--token-file <path>", "File containing the endpoint token (or AGENTDASH_BRIDGE_TOKEN)")
    .option(
      "--egress <policy>",
      "Required, no default: loopback (deny egress, localhost only) or direct (allow outbound 443 — weaker)",
    )
    .option("--interval <seconds>", "Seconds between polls", "5")
    .option("--claude-bin <path>", "Path to the claude binary", "claude")
    .option("--workspace-root <path>", "Parent directory for per-task workspaces (default: OS temp dir)")
    .option(
      "--token <token>",
      "REFUSED — a token in argv is readable by every local user via `ps`. Use --token-file or AGENTDASH_BRIDGE_TOKEN.",
      () => {
        throw new Error(TOKEN_ARGV_MESSAGE);
      },
    )
    // Commander passes (options, command); bridgeRun's second parameter is its
    // dependency seam, so the extra argument must not reach it.
    .action((options: BridgeRunOptions) => bridgeRun(options));

  return bridge;
}
