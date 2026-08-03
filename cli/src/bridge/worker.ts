import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSandboxProfile,
  defaultExecutor,
  type BridgeTask,
  type EgressPolicy,
  type TaskExecutor,
} from "./sandbox.js";

/**
 * The poll loop.
 *
 * The server has already made every decision that matters before a task reaches
 * this file: `act` tasks are approval-gated upstream and only appear in a poll
 * once a human has said yes. The worker does not re-gate, it runs what it is
 * handed — inside the sandbox, in a workspace that exists only for that task.
 */

export const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
export const DEFAULT_INTERVAL_MS = 5_000;
const MAX_DECLINE_REASON_CHARS = 2_000;
/**
 * Headroom so overflow is *detectable*. If the executor buffered exactly the
 * submit cap, a runaway task would yield exactly the cap and `truncateResult`
 * could not tell "fit precisely" from "was cut", so nothing would be marked and
 * the loss would be silent.
 */
const OVERFLOW_PROBE_BYTES = 4_096;
const INSTRUCTION_FILENAME = "INSTRUCTION.md";
const PROFILE_FILENAME = "sandbox.sb";

export interface BridgeWorkerConfig {
  serverUrl: string;
  token: string;
  egress: EgressPolicy;
  intervalMs: number;
  claudeBin: string;
  workspaceRoot: string;
  homeDir: string;
  maxResultBytes?: number;
  executor?: TaskExecutor;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  stopSignal: AbortSignal;
}

export function truncateResult(result: string, maxBytes = DEFAULT_MAX_RESULT_BYTES): string {
  const buf = Buffer.from(result, "utf8");
  if (buf.byteLength <= maxBytes) return result;
  const marker = `\n\n[agentdash-bridge: result truncated at ${maxBytes} bytes of ${buf.byteLength}]`;
  return `${buf.subarray(0, maxBytes).toString("utf8")}${marker}`;
}

function describeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > MAX_DECLINE_REASON_CHARS
    ? `${text.slice(0, MAX_DECLINE_REASON_CHARS)}…`
    : text;
}

/** Filesystem-safe fragment of a task id, for a human-readable workspace name. */
function workspaceSlug(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "task";
}

function isTask(value: unknown): value is BridgeTask {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === "string" && typeof task.instruction === "string";
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runBridgeWorker(config: BridgeWorkerConfig): Promise<void> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const executor = config.executor ?? defaultExecutor;
  const log = config.log ?? ((line: string) => console.log(line));
  const errorLog = config.errorLog ?? ((line: string) => console.error(line));
  const sleep = config.sleep ?? ((ms: number) => defaultSleep(ms, config.stopSignal));
  const maxResultBytes = config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const base = config.serverUrl.replace(/\/+$/, "");

  async function post(routePath: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetchImpl(`${base}${routePath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`POST ${routePath} failed: ${res.status}${detail ? ` ${detail.slice(0, 500)}` : ""}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async function handleTask(task: BridgeTask, resultToken: string): Promise<void> {
    const workspaceDir = await mkdtemp(
      path.join(config.workspaceRoot, `agentdash-bridge-${workspaceSlug(task.id)}-`),
    );

    let outcome: { kind: "result"; result: string } | { kind: "decline"; reason: string };
    try {
      // The instruction lands in the workspace as a file too: the sandboxed
      // agent can re-read its own brief without reaching outside.
      await writeFile(path.join(workspaceDir, INSTRUCTION_FILENAME), task.instruction, {
        mode: 0o600,
      });
      const profilePath = path.join(workspaceDir, PROFILE_FILENAME);
      await writeFile(
        profilePath,
        buildSandboxProfile({
          homeDir: config.homeDir,
          workspaceDir,
          egress: config.egress,
        }),
        { mode: 0o600 },
      );

      log(`[bridge] running task ${task.id} (${task.taskClass}) in ${workspaceDir}`);
      const output = await executor({
        task,
        workspaceDir,
        profilePath,
        claudeBin: config.claudeBin,
        maxOutputBytes: maxResultBytes + OVERFLOW_PROBE_BYTES,
      });
      outcome = { kind: "result", result: truncateResult(output, maxResultBytes) };
    } catch (err) {
      outcome = { kind: "decline", reason: describeError(err) };
    } finally {
      // Removed before the submit call, so a hung server cannot leave the
      // workspace (and whatever the task wrote into it) lying around.
      await rm(workspaceDir, { recursive: true, force: true }).catch((err: unknown) => {
        errorLog(`[bridge] failed to remove workspace ${workspaceDir}: ${describeError(err)}`);
      });
    }

    if (outcome.kind === "result") {
      await post("/api/bridge/result", { taskId: task.id, resultToken, result: outcome.result });
      log(`[bridge] submitted result for task ${task.id}`);
      return;
    }

    // Decline rather than let the lease expire: the requesting agent learns why
    // now instead of after a timeout that tells it nothing.
    errorLog(`[bridge] task ${task.id} failed: ${outcome.reason}`);
    await post("/api/bridge/decline", { taskId: task.id, resultToken, reason: outcome.reason });
  }

  while (!config.stopSignal.aborted) {
    try {
      const claimed = await post("/api/bridge/poll", {});
      const task = claimed.task;
      const resultToken = typeof claimed.resultToken === "string" ? claimed.resultToken : "";

      if (!isTask(task) || !resultToken) {
        await sleep(config.intervalMs);
        continue;
      }

      await handleTask(task, resultToken);
    } catch (err) {
      errorLog(`[bridge] ${describeError(err)}`);
      await sleep(config.intervalMs);
    }
  }

  log("[bridge] stopped");
}
