import type { Agent } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { formatActivityVerb, formatIssueActivityAction, isSystemPlumbingActivity } from "./activity-format";

describe("activity formatting", () => {
  const agentMap = new Map<string, Agent>([
    ["agent-reviewer", { id: "agent-reviewer", name: "Reviewer Bot" } as Agent],
    ["agent-approver", { id: "agent-approver", name: "Approver Bot" } as Agent],
  ]);

  // Scan 4 (lane O2): "backlog → todo" read as stored values.
  it("words status changes the way the board does", () => {
    const details = { status: "todo", _previous: { status: "backlog" } };
    expect(formatIssueActivityAction("issue.updated", details)).toBe("changed the status from Backlog to To do");
    expect(formatActivityVerb("issue.updated", { status: "in_review", _previous: { status: "in_progress" } })).toBe(
      "changed status from In progress to In review on",
    );
  });

  it("formats blocker activity using linked issue identifiers", () => {
    const details = {
      addedBlockedByIssues: [
        { id: "issue-2", identifier: "PAP-22", title: "Blocked task" },
      ],
      removedBlockedByIssues: [],
    };

    expect(formatActivityVerb("issue.blockers_updated", details)).toBe("added blocker PAP-22 to");
    expect(formatIssueActivityAction("issue.blockers_updated", details)).toBe("added blocker PAP-22");
  });

  it("formats reviewer activity using agent names", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot to");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("added reviewer Reviewer Bot");
  });

  it("formats approver removals using user-aware labels", () => {
    const details = {
      addedParticipants: [],
      removedParticipants: [
        { type: "user", agentId: null, userId: "local-board" },
      ],
    };

    expect(formatActivityVerb("issue.approvers_updated", details)).toBe("removed approver Board from");
    expect(formatIssueActivityAction("issue.approvers_updated", details)).toBe("removed approver Board");
  });

  it("falls back to updated wording when reviewers are both added and removed", () => {
    const details = {
      addedParticipants: [
        { type: "agent", agentId: "agent-reviewer", userId: null },
      ],
      removedParticipants: [
        { type: "agent", agentId: "agent-approver", userId: null },
      ],
    };

    expect(formatActivityVerb("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers on");
    expect(formatIssueActivityAction("issue.reviewers_updated", details, { agentMap })).toBe("updated reviewers");
  });
});

// AgentDash (Scan 3, lane J): plumbing events are system events in plain words.
describe("system plumbing activity", () => {
  it("marks lease and preflight events as system plumbing, and leaves real work alone", () => {
    expect(isSystemPlumbingActivity("environment.lease_acquired")).toBe(true);
    expect(isSystemPlumbingActivity("agent.harness_preflight_passed")).toBe(true);
    expect(isSystemPlumbingActivity("issue.created")).toBe(false);
    expect(isSystemPlumbingActivity("agent.hired")).toBe(false);
  });

  it("relabels them without the machinery words", () => {
    expect(formatActivityVerb("environment.lease_acquired")).not.toMatch(/lease/);
    expect(formatActivityVerb("agent.harness_preflight_passed")).not.toMatch(/harness|preflight/);
  });
});

// AgentDash (batch 2 review lane): read markers, inbox moves and review-queue
// churn are bookkeeping — hidden by default, plain words when shown.
describe("bookkeeping activity", () => {
  it("marks read/inbox/queue actions as system plumbing", () => {
    expect(isSystemPlumbingActivity("issue.read_marked")).toBe(true);
    expect(isSystemPlumbingActivity("issue.read_unmarked")).toBe(true);
    expect(isSystemPlumbingActivity("issue.inbox_archived")).toBe(true);
    expect(isSystemPlumbingActivity("issue.inbox_unarchived")).toBe(true);
    expect(isSystemPlumbingActivity("queue_state_changed")).toBe(true);
    expect(isSystemPlumbingActivity("issue.work_product_updated")).toBe(false);
  });

  it("says them in plain language, not raw action names", () => {
    expect(formatActivityVerb("issue.read_marked")).not.toMatch(/read_marked|issue\./);
    expect(formatActivityVerb("queue_state_changed")).not.toMatch(/queue_state_changed/);
    expect(formatActivityVerb("issue.work_product_updated")).toBe("updated a deliverable on");
    expect(formatIssueActivityAction("issue.work_product_updated")).toBe("updated a deliverable");
  });
});

// AgentDash (c3 copy): "cancelled heartbeat" hid who and why — the row names
// the agent's run and the reason it stopped.
describe("heartbeat cancellations", () => {
  it("names the agent's run and the reason it stopped", () => {
    const details = { agentId: "agent-scout", source: "issue_status_done" };
    const agents = new Map<string, Agent>([["agent-scout", { id: "agent-scout", name: "Scout" } as Agent]]);
    expect(formatActivityVerb("heartbeat.cancelled", details, { agentMap: agents })).toBe(
      "stopped Scout's run — the issue was marked done",
    );
    expect(formatIssueActivityAction("heartbeat.cancelled", details, { agentMap: agents })).toBe(
      "stopped Scout's run — the issue was marked done",
    );
  });

  it("humanizes other sources and falls back to a generic agent name", () => {
    expect(formatActivityVerb("heartbeat.cancelled", { agentId: "agent-x", source: "issue_comment_interrupt" })).toBe(
      "stopped the agent's run — a new comment interrupted it",
    );
    expect(formatActivityVerb("heartbeat.cancelled", { agentId: "agent-x", source: "watchdog_stop" })).toBe(
      "stopped the agent's run — watchdog stop",
    );
    expect(formatActivityVerb("heartbeat.cancelled", {})).toBe("stopped the agent's run");
  });
});

// AgentDash (c3 copy): closing an issue accepts its deliverable — say so.
describe("deliverable acceptance", () => {
  it("reads accepted, not updated, when the reason is issue acceptance", () => {
    const details = { reason: "issue_accepted" };
    expect(formatActivityVerb("issue.work_product_updated", details)).toBe("accepted the deliverable on");
    expect(formatIssueActivityAction("issue.work_product_updated", details)).toBe("accepted the deliverable");
  });

  it("names the document when it is not the generic deliverable", () => {
    expect(formatIssueActivityAction("issue.work_product_updated", { reason: "issue_accepted", documentKey: "report" })).toBe(
      "accepted the report",
    );
  });
});
