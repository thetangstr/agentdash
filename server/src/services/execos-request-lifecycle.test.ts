import { describe, expect, it } from "vitest";
import { resolveExecOsRequestIssueStatus } from "./execos-request-lifecycle.js";

const matchingAudit = {
  request: { id: "req_kiddoquest_repo_state" },
  terminalStatus: "completed",
};

describe("resolveExecOsRequestIssueStatus", () => {
  it.each(["completed", "cannot_answer"])(
    "closes a matching successful ExecOS request after terminal status %s",
    (terminalStatus) => {
      expect(resolveExecOsRequestIssueStatus({
        issue: {
          originKind: "execos_request",
          originId: "req_kiddoquest_repo_state",
          status: "in_progress",
        },
        run: {
          status: "succeeded",
          resultJson: {
            audit: { ...matchingAudit, terminalStatus },
          },
        },
      })).toBe("done");
    },
  );

  it.each([
    {
      name: "ordinary AgentDash issue",
      issue: { originKind: "manual", originId: null, status: "in_progress" },
      run: { status: "succeeded", resultJson: { audit: matchingAudit } },
    },
    {
      name: "mismatched request binding",
      issue: { originKind: "execos_request", originId: "req_other", status: "in_progress" },
      run: { status: "succeeded", resultJson: { audit: matchingAudit } },
    },
    {
      name: "failed AgentDash run",
      issue: { originKind: "execos_request", originId: "req_kiddoquest_repo_state", status: "in_progress" },
      run: { status: "failed", resultJson: { audit: matchingAudit } },
    },
    {
      name: "approval-blocked result",
      issue: { originKind: "execos_request", originId: "req_kiddoquest_repo_state", status: "in_progress" },
      run: { status: "succeeded", resultJson: { audit: { ...matchingAudit, terminalStatus: "blocked_pending_approval" } } },
    },
    {
      name: "already closed issue",
      issue: { originKind: "execos_request", originId: "req_kiddoquest_repo_state", status: "done" },
      run: { status: "succeeded", resultJson: { audit: matchingAudit } },
    },
  ])("does not close $name", ({ issue, run }) => {
    expect(resolveExecOsRequestIssueStatus({ issue, run })).toBeNull();
  });
});
