// AgentDash (c4-stops): "stopped" = work that still reads in progress but has
// no live run because its newest run was cancelled. One rule shared by the
// issue banner, the agent vitals strip, and the task card so the surfaces can
// never disagree about whether the work is actually doing anything.
export function isIssueWorkStopped(input: {
  status: string | null | undefined;
  hasLiveRun: boolean;
  latestRunStatus: string | null | undefined;
}): boolean {
  if (input.hasLiveRun) return false;
  if (input.status !== "in_progress" && input.status !== "todo") return false;
  return input.latestRunStatus === "cancelled";
}

/** Newest first; ties fall back to input order. */
export function latestRunByCreatedAt<T extends { createdAt: string | Date }>(runs: readonly T[]): T | null {
  let latest: T | null = null;
  for (const run of runs) {
    if (!latest || new Date(run.createdAt).getTime() > new Date(latest.createdAt).getTime()) latest = run;
  }
  return latest;
}
