// AgentDash (c4-stops): run-status live events name no cancelling actor, so
// the client remembers which runs this viewer stopped to distinguish "Stopped
// by you" from another operator's or a system's stop.
const locallyStoppedRunIds = new Set<string>();
const MAX_LOCALLY_STOPPED_RUN_IDS = 500;

export function markRunStoppedLocally(runId: string) {
  if (locallyStoppedRunIds.has(runId)) return;
  locallyStoppedRunIds.add(runId);
  if (locallyStoppedRunIds.size > MAX_LOCALLY_STOPPED_RUN_IDS) {
    const oldest = locallyStoppedRunIds.values().next().value;
    if (oldest !== undefined) locallyStoppedRunIds.delete(oldest);
  }
}

export function wasRunStoppedLocally(runId: string) {
  return locallyStoppedRunIds.has(runId);
}

/** Test hook: live-event state must not leak between tests. */
export function clearLocallyStoppedRuns() {
  locallyStoppedRunIds.clear();
}
