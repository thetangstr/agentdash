import { RUN_CANCELLED_BY_OPERATOR_CODE } from "@paperclipai/shared";

/**
 * AgentDash (c3): the label every surface uses for a cancelled run — the
 * recorded reason, neutral. "Stopped manually" for an operator stop; the
 * stored reason (budget pause, issue done, comment interrupt) otherwise.
 */
export function cancelledRunLabel(run: {
  error?: string | null;
  errorCode?: string | null;
}): string {
  return run.errorCode === RUN_CANCELLED_BY_OPERATOR_CODE
    ? "Stopped manually"
    : (run.error ?? "Stopped");
}
