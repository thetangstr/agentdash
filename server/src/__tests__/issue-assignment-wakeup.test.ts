import { describe, expect, it, vi } from "vitest";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";

/**
 * AgentDash (scan 2, E2): the onboarding wizard promises "nothing runs until
 * you say so", and keeps it by creating its tasks in `backlog`. This is the
 * server half of that promise: creating an assigned issue wakes the assignee
 * unless the issue is parked in `backlog`. If the backlog case ever starts a
 * run, launching the wizard starts one run per task again.
 */
describe("queueIssueAssignmentWakeup", () => {
  function heartbeat() {
    return { wakeup: vi.fn(async () => ({ id: "run-1" })) };
  }

  it("starts no run for an assigned issue created in backlog", async () => {
    const hb = heartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat: hb,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "backlog" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });
    expect(hb.wakeup).not.toHaveBeenCalled();
  });

  it("wakes the assignee of an assigned issue created in todo", async () => {
    const hb = heartbeat();
    await queueIssueAssignmentWakeup({
      heartbeat: hb,
      issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "todo" },
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
    });
    expect(hb.wakeup).toHaveBeenCalledTimes(1);
    expect(hb.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ source: "assignment", payload: { issueId: "issue-1", mutation: "create" } }),
    );
  });
});
