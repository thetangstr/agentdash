import type { HeartbeatRun } from "@paperclipai/shared";

/**
 * What is actually wrong with this agent, for the person who has to act on it.
 *
 * Written from a real complaint. A steward diagnosing his own stopped agent
 * reported: "HAL's dashboard shows only the recovery-budget wrapper, and you
 * have to click into the run to find the cause. I nearly reported the wrong
 * root cause off HAL's dashboard alone."
 *
 * He was right, and it is the same defect twice over. The newest run is often
 * not the informative one: when recovery gives up it writes its own cancelled
 * run on top — "Automatic recovery budget exhausted (attempts): attempts=1/1"
 * — which says a budget was spent and nothing about what failed. The run under
 * it holds the real error, in that case "Process adapter missing command".
 *
 * So this deliberately reads past the wrapper. A steward should not have to
 * know that recovery leaves a marker, nor click through to find out why their
 * agent is dead.
 */

/**
 * Statuses and codes that describe the recovery machinery rather than the
 * fault. Kept narrow on purpose: skipping too much would hide a genuine
 * failure, so anything not listed here is treated as a real cause.
 */
const WRAPPER_ERROR_CODES = new Set(["task_recovery_budget_exhausted"]);

export type AgentTrouble = {
  /** The plain sentence a non-technical steward reads first. */
  headline: string;
  /** The underlying error, as the adapter reported it. Null when there isn't one. */
  cause: string | null;
  /** The machine-readable code, for someone who wants to search it. */
  code: string | null;
  /** When the failing run finished, ISO, for relative rendering. */
  at: string | null;
  /** True when a recovery marker was skipped to find the cause underneath. */
  lookedPastRecoveryMarker: boolean;
};

function isFailed(run: Pick<HeartbeatRun, "status">): boolean {
  return run.status === "failed" || run.status === "cancelled";
}

/**
 * `runs` newest first, as the list endpoint returns them.
 *
 * Returns null when the agent is fine — an agent whose newest run succeeded is
 * not in trouble, however many older failures it has. Showing an old error to
 * someone whose agent is working is its own kind of lying.
 */
export function summarizeAgentTrouble(
  runs: ReadonlyArray<Pick<HeartbeatRun, "status" | "error" | "finishedAt">> & {
    [index: number]: { errorCode?: string | null };
  },
  agentName: string,
): AgentTrouble | null {
  const newest = runs[0];
  if (!newest || !isFailed(newest)) return null;

  let lookedPast = false;
  let chosen: (typeof runs)[number] | null = null;

  for (const run of runs) {
    if (!isFailed(run)) break; // a success ends the failing streak
    const code = (run as { errorCode?: string | null }).errorCode ?? null;
    if (code && WRAPPER_ERROR_CODES.has(code)) {
      lookedPast = true;
      continue;
    }
    chosen = run;
    break;
  }

  // Every run in the streak was a recovery marker. Say that plainly rather
  // than presenting the marker as though it were the fault.
  if (!chosen) {
    return {
      headline: `${agentName} stopped, and automatic recovery gave up.`,
      cause: null,
      code: "task_recovery_budget_exhausted",
      at: newest.finishedAt ? String(newest.finishedAt) : null,
      lookedPastRecoveryMarker: true,
    };
  }

  const cause = typeof chosen.error === "string" && chosen.error.trim() ? chosen.error.trim() : null;
  return {
    headline: `${agentName} stopped and has not run since.`,
    cause,
    code: (chosen as { errorCode?: string | null }).errorCode ?? null,
    at: chosen.finishedAt ? String(chosen.finishedAt) : null,
    lookedPastRecoveryMarker: lookedPast,
  };
}
