type ExecOsIssueState = {
  originKind: string | null;
  originId: string | null;
  status: string;
};

type ExecOsRunState = {
  status: string;
  resultJson: unknown;
};

export function resolveExecOsRequestIssueStatus(input: {
  issue: ExecOsIssueState;
  run: ExecOsRunState;
}): "done" | null {
  if (
    input.issue.originKind !== "execos_request" ||
    !input.issue.originId ||
    input.issue.status === "done" ||
    input.issue.status === "cancelled" ||
    input.run.status !== "succeeded"
  ) {
    return null;
  }

  const result = asRecord(input.run.resultJson);
  const audit = asRecord(result?.audit);
  const request = asRecord(audit?.request);
  if (request?.id !== input.issue.originId) return null;

  return audit?.terminalStatus === "completed" || audit?.terminalStatus === "cannot_answer"
    ? "done"
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
