import { RUN_CANCELLED_BY_OPERATOR_CODE } from "@paperclipai/shared";

/**
 * AgentDash (APM gate 3, P3.4): the run error code for a run its agent's
 * access rules refused (enforce mode). The run never started; the server
 * leaves a blocker note on the issue.
 */
export const ACCESS_POLICY_REFUSED_RUN_CODE = "access_policy_refused";
export const ACCESS_POLICY_REFUSED_RUN_LABEL = "Not started: outside this agent's access rules";

/**
 * AgentDash (c3): the label every surface uses for a cancelled run — the
 * recorded reason, neutral. "Stopped manually" for an operator stop; the
 * stored reason (budget pause, issue done, comment interrupt) otherwise.
 */
export function cancelledRunLabel(run: {
  error?: string | null;
  errorCode?: string | null;
}): string {
  if (run.errorCode === ACCESS_POLICY_REFUSED_RUN_CODE) return ACCESS_POLICY_REFUSED_RUN_LABEL;
  return run.errorCode === RUN_CANCELLED_BY_OPERATOR_CODE || run.error === LEGACY_OPERATOR_CANCEL_MESSAGE
    ? "Stopped manually"
    : (run.error ?? "Stopped");
}

// AgentDash (c4-stops): rows written before the rename stored this message
// for an operator stop; they render with today's wording.
export const LEGACY_OPERATOR_CANCEL_MESSAGE = "Cancelled by control plane";

/**
 * AgentDash (c4-stops): events persisted before the rename recorded "run
 * cancelled" — and a manual stop could land as "run failed" when the killed
 * process's exit surfaced first. On a cancelled run both mean "run stopped".
 */
export function normalizeStoppedRunEventMessage(message: string, runStatus: string): string {
  return runStatus === "cancelled" && /^run (cancelled|failed)$/i.test(message.trim())
    ? "run stopped"
    : message;
}
