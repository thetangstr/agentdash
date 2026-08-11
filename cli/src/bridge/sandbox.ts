import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";

/**
 * AgentDash-MK: OS containment for the local bridge worker.
 *
 * The profile below is not a guess — it is the shape a containment spike
 * validated on macOS 26.6 (16/16 tests, see
 * `doc/plans/2026-07-31-bridge-containment-spike.md`). Three facts from that
 * spike are load-bearing and must survive any edit here:
 *
 *   1. Whole-filesystem `(deny default)` starves dyld and the process dies on
 *      SIGABRT before `main`. The deployable shape inverts it: allow the
 *      system, deny the human, re-open the workspace.
 *   2. Later rules win in SBPL. The workspace allow MUST come after the home
 *      deny or the workspace is unreachable and nothing runs.
 *   3. With home denied, `getcwd` fails from anywhere inside it. The child has
 *      to be placed in the workspace as part of spawning, not by a first
 *      command that has already lost its footing.
 *
 * Seatbelt constrains *subprocesses*. Claude Code's own in-process tools answer
 * to its permission system, not to this file. Neither layer substitutes for the
 * other.
 */

export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** macOS name resolution goes through this socket; `(deny network*)` closes it. */
export const MDNSRESPONDER_SOCKET = "/private/var/run/mDNSResponder";

export const EGRESS_POLICIES = ["loopback", "direct"] as const;
export type EgressPolicy = (typeof EGRESS_POLICIES)[number];

export const EGRESS_REQUIRED_MESSAGE =
  "Refusing to start: --egress is required and has no default.\n" +
  "  --egress loopback  Deny all egress, allow loopback only. Reaching the Anthropic\n" +
  "                     API requires a local allowlisting proxy. This is the posture\n" +
  "                     the containment spike validated.\n" +
  "  --egress direct    Additionally allow outbound 443 so the agent can reach\n" +
  "                     api.anthropic.com unmediated. Weaker: no proxy sees the\n" +
  "                     traffic and no allowlist constrains the destination.\n" +
  "There is no safe default here, so the choice is yours to make explicitly.";

export interface BridgeTask {
  id: string;
  taskClass: string;
  instruction: string;
  leaseExpiresAt?: string | null;
}

export interface ExecutorContext {
  task: BridgeTask;
  /** Fresh, per-task, and the only writable place the child can reach. */
  workspaceDir: string;
  profilePath: string;
  claudeBin: string;
  maxOutputBytes: number;
}

export type TaskExecutor = (ctx: ExecutorContext) => Promise<string>;

export function parseEgressPolicy(value: string | undefined | null): EgressPolicy {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(EGRESS_REQUIRED_MESSAGE);
  if (!(EGRESS_POLICIES as readonly string[]).includes(trimmed)) {
    throw new Error(
      `Refusing to start: unknown egress policy "${trimmed}". Expected one of: ${EGRESS_POLICIES.join(", ")}.`,
    );
  }
  return trimmed as EgressPolicy;
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The single most important safety property in this worker.
 *
 * A bridge that silently drops confinement is worse than one that will not
 * start, because the operator believes the containment is there. There is
 * deliberately no fallback path, no `--no-sandbox`, and no "best effort" mode.
 */
export function assertSandboxSupported(
  opts: { platform?: NodeJS.Platform; isExecutable?: (path: string) => boolean } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") {
    throw new Error(
      `Refusing to start: the bridge worker requires macOS (darwin) and this host is "${platform}".\n` +
        "Containment relies on macOS Seatbelt (sandbox-exec). There is no unsandboxed\n" +
        "fallback: running agent-authored code without confinement is the failure this\n" +
        "worker exists to prevent.",
    );
  }
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  if (!isExecutable(SANDBOX_EXEC_PATH)) {
    throw new Error(
      `Refusing to start: ${SANDBOX_EXEC_PATH} is not executable on this host.\n` +
        "Without it nothing can be confined, and the worker will not run tasks unconfined.",
    );
  }
}

/** SBPL string literals have no escape syntax worth trusting. Reject, don't quote. */
function sbplLiteralPath(label: string, value: string): string {
  if (!value.startsWith("/")) {
    throw new Error(`Refusing to build a sandbox profile: ${label} must be an absolute path (got "${value}").`);
  }
  if (/["\\\n\r]/.test(value)) {
    throw new Error(
      `Refusing to build a sandbox profile: ${label} contains a character that cannot be represented ` +
        `safely in an SBPL string literal (got "${value}").`,
    );
  }
  return value;
}

export function buildSandboxProfile(opts: {
  homeDir: string;
  workspaceDir: string;
  egress: EgressPolicy;
  /**
   * Absolute paths of the agent binary, symlinks resolved.
   *
   * Without these the worker cannot run at all on a standard install. Claude
   * Code puts its binary at `~/.local/bin/claude`, a symlink into
   * `~/.local/share/claude/versions/…` — both inside the home directory this
   * profile denies. The result is `execvp() of 'claude' failed: No such file or
   * directory` on every task, which reads like a PATH problem and is not one.
   *
   * Re-opening exactly the binary we were told to execute widens nothing: the
   * task was always going to run that program. What stays denied is everything
   * it might have read — documents, keys, repositories, the rest of home.
   */
  execPaths?: string[];
}): string {
  const home = sbplLiteralPath("homeDir", opts.homeDir);
  const workspace = sbplLiteralPath("workspaceDir", opts.workspaceDir);
  const execAllows = (opts.execPaths ?? [])
    .map((candidate, index) => sbplLiteralPath(`execPaths[${index}]`, candidate))
    .flatMap((literal) => [
      `(allow file-read* (literal "${literal}"))`,
      `(allow process-exec (literal "${literal}"))`,
    ]);

  const egressLines =
    opts.egress === "loopback"
      ? [
          ";; Deny all egress, then re-open loopback only. A local allowlisting proxy",
          ";; decides which domains are reachable; the sandbox guarantees nothing can",
          ";; route around that proxy — not by raw IP, not to a LAN peer.",
          "(deny network*)",
          '(allow network-outbound (remote ip "localhost:*"))',
          '(allow network-bind    (local  ip "localhost:*"))',
        ]
      : [
          ";; WEAKER POSTURE. Deny all egress, then re-open outbound 443 so the agent",
          ";; can reach api.anthropic.com with no proxy in front of it. Nothing",
          ";; inspects or allowlists that traffic, and any other 443 host is reachable",
          ";; too. Chosen explicitly via --egress direct.",
          "(deny network*)",
          '(allow network-outbound (remote ip "*:443"))',
          ";; DNS. Do not remove: `(deny network*)` also closes the mDNSResponder",
          ";; socket, and without it every hostname fails to resolve — the 443 allow",
          ";; above is then useless and this mode silently does nothing. Verified:",
          ";; raw-IP 443 succeeds without it, api.anthropic.com does not.",
          ";; Unnecessary under loopback, where the proxy resolves on the task's behalf.",
          `(allow network-outbound (literal "${MDNSRESPONDER_SOCKET}"))`,
        ];

  return [
    "(version 1)",
    "(allow default)",
    "",
    ";; Deny the operator's home, then re-open only this task's workspace.",
    ";; ORDER IS LOAD-BEARING: later rules win in SBPL, so the workspace allow must",
    ";; stay below the home deny. The home deny is not a dial — it is present under",
    ";; every egress policy, always.",
    `(deny file-read* file-write* (subpath "${home}"))`,
    `(allow file-read* file-write* (subpath "${workspace}"))`,
    ...(execAllows.length
      ? [
          "",
          ";; The agent binary itself, symlinks resolved. It usually lives inside the",
          ";; home directory denied above, and denying the program we were asked to run",
          ";; makes every task fail before it starts.",
          ...execAllows,
        ]
      : []),
    "",
    ...egressLines,
    "",
  ].join("\n");
}

/** Keep the first `maxBytes` of output and stop buffering after that. */
function boundedCollector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk: Buffer) {
      if (size >= maxBytes) return;
      const room = maxBytes - size;
      const slice = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
      chunks.push(slice);
      size += slice.byteLength;
    },
    text(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

const STDERR_TAIL_BYTES = 4096;

/**
 * The production executor: `sandbox-exec -f <profile> <claude> -p <instruction>`
 * with the workspace as cwd.
 *
 * The bridge credential is stripped from the child environment. The task is
 * agent-authored code; handing it the token that authenticates this machine to
 * AgentDash would let it file and answer its own tasks.
 */
export const defaultExecutor: TaskExecutor = (ctx) =>
  new Promise<string>((resolve, reject) => {
    const args = ["-f", ctx.profilePath, ctx.claudeBin, "-p", ctx.task.instruction];

    const env = { ...process.env };
    delete env.AGENTDASH_BRIDGE_TOKEN;

    const child = spawn(SANDBOX_EXEC_PATH, args, {
      // chdir as part of spawning: with home denied, getcwd fails from inside it.
      cwd: ctx.workspaceDir,
      env,
      // Unattended. A prompt on stdin would hang the worker forever.
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = boundedCollector(ctx.maxOutputBytes);
    const stderr = boundedCollector(STDERR_TAIL_BYTES);
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn ${SANDBOX_EXEC_PATH}: ${err.message}`));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(stdout.text());
        return;
      }
      const how = signal ? `killed by signal ${signal}` : `exited with code ${code ?? "unknown"}`;
      const tail = stderr.text().trim();
      const out = stdout.text();

      /**
       * The one failure everybody hits first, translated.
       *
       * The sandbox denies the home directory, so the agent cannot read the
       * desktop login in `~/.claude` — that deny is the whole point of running
       * agent-authored instructions in here, and it is not a dial. Claude then
       * prints "Not logged in · Please run /login" on stdout and exits 1, so the
       * raw failure is an exit code with an empty stderr, which sends people
       * looking at the sandbox, the token, and the network in that order.
       *
       * Running `/login` cannot fix it: the credential it writes lands in the
       * directory this profile denies. An API key in the worker's environment
       * can, because it never touches the filesystem.
       */
      if (/not logged in|please run \/login/i.test(out)) {
        reject(
          new Error(
            "the agent is not authenticated inside the sandbox. Its desktop login lives in " +
              "the home directory this profile denies, and that deny is deliberate. Set " +
              "ANTHROPIC_API_KEY in the environment you start `agentdash bridge run` from — " +
              "an env credential needs no filesystem access. Running `claude /login` will not " +
              "help: it writes to the directory the sandbox is refusing.",
          ),
        );
        return;
      }

      reject(new Error(`${ctx.claudeBin} ${how}${tail ? `: ${tail}` : ""}${!tail && out ? `: ${out.trim().slice(0, 200)}` : ""}`));
    });
  });
