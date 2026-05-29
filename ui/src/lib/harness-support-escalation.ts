import {
  recoveryActionLabel,
  type AgentRunFailureClassification,
} from "../components/AgentRunFailureGuidance";

export type HarnessSupportEscalationRun = {
  id?: string;
  runId?: string;
  agentId: string;
  status: string;
  errorCode?: string | null;
};

export function buildHarnessSupportEscalationBody(
  run: HarnessSupportEscalationRun,
  classification: AgentRunFailureClassification,
) {
  const runId = run.runId ?? run.id ?? "unknown";
  const status = run.errorCode ? `${run.status} (${run.errorCode})` : run.status;
  const nextActions =
    classification.nextActions.length > 0
      ? classification.nextActions.map(recoveryActionLabel).join(", ")
      : "None";
  return [
    "### Harness support escalation",
    "",
    `Run: ${runId}`,
    `Agent: ${run.agentId}`,
    `Status: ${status}`,
    `Category: ${classification.category.replace(/_/g, " ")}`,
    `Severity: ${classification.severity.replace(/_/g, " ")}`,
    `Next actions: ${nextActions}`,
    "",
    classification.detail,
    "",
    "Operator consent: this support note includes run metadata and the classified failure summary only. It does not attach raw logs, transcripts, secrets, or trace bundles.",
  ].join("\n");
}
