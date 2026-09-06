import { spawn } from "node:child_process";

/**
 * AgentDash-MK: OS containment for the local bridge worker.
 *
 * The profile itself now lives in `@paperclipai/adapter-utils/seatbelt`, shared
 * with the server's agent-execution path. What remains here is the bridge
 * worker's own executor.
 *
 * The spike findings that shaped the profile, and the profile itself, are
 * documented at its new home. Point 3 from that spike still governs the
 * executor below: with home denied, `getcwd` fails from anywhere inside it, so
 * the child is placed in the workspace as part of spawning.
 */

/**
 * The profile builder and its guards moved to `@paperclipai/adapter-utils`, so
 * the server's execution path and this bridge worker share ONE implementation.
 * They are re-exported here because this module's callers already import them
 * from this path, and because a security check with two copies is one that will
 * eventually disagree with itself.
 */
export {
  SANDBOX_EXEC_PATH,
  MDNSRESPONDER_SOCKET,
  EGRESS_POLICIES,
  EGRESS_REQUIRED_MESSAGE,
  parseEgressPolicy,
  assertSandboxSupported,
  buildSandboxProfile,
} from "@paperclipai/adapter-utils/seatbelt";
export type { EgressPolicy } from "@paperclipai/adapter-utils/seatbelt";

import {
  SANDBOX_EXEC_PATH,
} from "@paperclipai/adapter-utils/seatbelt";

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
              "the home directory this profile denies, and that deny is deliberate. " +
              "To use your existing Claude subscription, do not use this command: connect " +
              "AgentDash to the Claude Code you are already signed into and work from your " +
              "inbox there (`paperclipai bridge inbox-init`), which runs as you with no " +
              "sandbox and no key. For an unattended worker instead, give it a key of its " +
              "own via ANTHROPIC_API_KEY — an env credential needs no filesystem access. " +
              "Running `claude /login` will not help either way: it writes to the directory " +
              "the sandbox is refusing.",
          ),
        );
        return;
      }

      reject(new Error(`${ctx.claudeBin} ${how}${tail ? `: ${tail}` : ""}${!tail && out ? `: ${out.trim().slice(0, 200)}` : ""}`));
    });
  });
