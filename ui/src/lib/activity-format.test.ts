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

  // AgentDash (review-1015): the audit carries the identifier — "ACM-3 was
  // marked done", not "the issue was marked done".
  it("names the issue the close came from", () => {
    const details = { agentId: "agent-scout", source: "issue_status_done", identifier: "ACM-3" };
    const agents = new Map<string, Agent>([["agent-scout", { id: "agent-scout", name: "Scout" } as Agent]]);
    expect(formatActivityVerb("heartbeat.cancelled", details, { agentMap: agents })).toBe(
      "stopped Scout's run — ACM-3 was marked done",
    );
    expect(formatIssueActivityAction("heartbeat.cancelled", details, { agentMap: agents })).toBe(
      "stopped Scout's run — ACM-3 was marked done",
    );
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

// AgentDash (review-1015): the other reasons the server logs on
// issue.work_product_updated must not fall back to "updated a deliverable".
describe("deliverable review reasons", () => {
  it("reads requested changes, not updated", () => {
    const details = { reason: "changes_requested" };
    expect(formatActivityVerb("issue.work_product_updated", details)).toBe("requested changes to the deliverable on");
    expect(formatIssueActivityAction("issue.work_product_updated", details)).toBe("requested changes to the deliverable");
  });

  it("reads resubmitted for review", () => {
    const details = { reason: "resubmitted_for_review" };
    expect(formatActivityVerb("issue.work_product_updated", details)).toBe("resubmitted the deliverable for review on");
    expect(formatIssueActivityAction("issue.work_product_updated", details)).toBe("resubmitted the deliverable for review");
  });

  it("reads reopened", () => {
    const details = { reason: "issue_reopened" };
    expect(formatActivityVerb("issue.work_product_updated", details)).toBe("reopened the deliverable on");
    expect(formatIssueActivityAction("issue.work_product_updated", details)).toBe("reopened the deliverable");
  });

  it("humanises slugged document keys for every reason", () => {
    expect(formatIssueActivityAction("issue.work_product_updated", { reason: "issue_accepted", documentKey: "product-description" })).toBe(
      "accepted the product description",
    );
    expect(formatIssueActivityAction("issue.work_product_updated", { reason: "changes_requested", documentKey: "launch-plan" })).toBe(
      "requested changes to the launch plan",
    );
  });
});

/**
 * AgentDash (c4 trust): every action string the server can write. The feed
 * used to fall back to the raw name — "agent.stewardship_assigned",
 * "goal.created", "join.auto_approved" rendered verbatim for owners.
 * Regenerate with:
 *   grep -rhoE 'action: `?"[a-z][a-zA-Z0-9_.]+"' server/src --include="*.ts" | sort -u
 * (plus the template families below, expanded to their literal values).
 */
const SERVER_WRITTEN_ACTIVITY_ACTIONS = [
  // agent lifecycle and configuration
  "agent.approved",
  "agent.budget_updated",
  "agent.config_rolled_back",
  "agent.connect_code_created",
  "agent.connect_code_redeemed",
  "agent.created",
  "agent.deleted",
  "agent.directives_pushed",
  "agent.governance_change_rejected",
  "agent.governance_configuration_clamped",
  "agent.governance_harness_request_clamped",
  "agent.harness_preflight_failed",
  "agent.harness_preflight_passed",
  "agent.hire_created",
  "agent.hired",
  "agent.instructions_bundle_updated",
  "agent.instructions_file_deleted",
  "agent.instructions_file_updated",
  "agent.instructions_path_updated",
  "agent.key_created",
  "agent.key_revoked",
  "agent.memory_written",
  "agent.paused",
  "agent.permissions_updated",
  "agent.resumed",
  "agent.runtime_session_reset",
  "agent.secret_activity",
  "agent.skills_synced",
  "agent.stewardship_assigned",
  "agent.stewardship_ended",
  "agent.stewardship_transferred",
  "agent.terminated",
  "agent.token_ceiling_paused",
  "agent.token_ceiling_updated",
  "agent.updated",
  "agent.updated_from_join_replay",
  "agent.visible_activity",
  "agent_api_key.claimed",
  // agent-fact Q&A
  "agent_fact.answer_discarded",
  "agent_fact.answer_held",
  "agent_fact.answer_released",
  "agent_fact.answered",
  "agent_fact.asked",
  "agent_fact.declined",
  "agent_fact.escalated",
  // approvals
  "approval.approved",
  "approval.comment_added",
  "approval.created",
  "approval.emergency_override",
  "approval.rejected",
  "approval.requester_wakeup_failed",
  "approval.requester_wakeup_queued",
  "approval.resubmitted",
  "approval.revision_requested",
  "asset.created",
  "assistant.gated_action",
  "authz.refused",
  "board_api_key.created",
  "board_api_key.revoked",
  // local-harness bridge
  "bridge.endpoint_enrolled",
  "bridge.endpoint_revoked",
  "bridge.task_completed",
  "bridge.task_created",
  "bridge.task_declined",
  // budgets
  "budget.hard_threshold_crossed",
  "budget.incident_resolved",
  "budget.policy_upserted",
  "budget.soft_threshold_crossed",
  // company
  "company.archived",
  "company.branding_updated",
  "company.budget_updated",
  "company.created",
  "company.feedback_data_sharing_updated",
  "company.imported",
  "company.skill_created",
  "company.skill_deleted",
  "company.skill_file_updated",
  "company.skill_update_installed",
  "company.skills_imported",
  "company.skills_scanned",
  "company.updated",
  "company_member.access_updated",
  "company_member.archived",
  "company_member.permissions_updated",
  "company_member.updated",
  // connectors and send reconciliation
  "connection.created",
  "connection.hubspot_connected",
  "connection.hubspot_rotated",
  "connection.hubspot_write_requested",
  "connection.revoked",
  "connection.sharepoint_connected",
  "connector_send.failed",
  "connector_send.outcome_unknown",
  "connector_send.reconciled",
  "connector_send.refused",
  "connector_send.succeeded",
  "connector_send.undelivered_reported",
  "cost.reported",
  // deliverables
  "deliverable.corrected",
  "deliverable.defined",
  "deliverable.presented",
  "deliverable.sent_back",
  "deliverable.shipped",
  // environments
  "environment.created",
  "environment.deleted",
  "environment.lease_acquired",
  "environment.lease_released",
  "environment.probed",
  "environment.probed_unsaved",
  "environment.updated",
  // evaluator machinery
  "evaluation.contract_declared",
  "evaluation.correction_filed",
  "evaluation.correction_noted",
  "evaluation.disposition_recorded",
  "evaluation.finding_noted",
  "evaluation.ingest_run",
  "evaluation.principal_provisioned",
  "evaluation.review_items_synced",
  "evaluation.scorecard_snapshot",
  "execution_workspace.runtime_restart",
  "execution_workspace.runtime_run",
  "execution_workspace.runtime_start",
  "execution_workspace.runtime_stop",
  "execution_workspace.updated",
  "finance_event.reported",
  "github_connection.credential_issued",
  "github_connection.disconnected",
  // connector tool calls
  "gmail.draft",
  "gmail.list",
  "gmail.read_thread",
  "gmail.search",
  "gmail.send",
  // goals
  "goal.created",
  "goal.deleted",
  "goal.updated",
  "goal_created_from_onboarding",
  // run lifecycle
  "heartbeat.cancel_failed",
  "heartbeat.cancelled",
  "heartbeat.completed",
  "heartbeat.invoked",
  "heartbeat.output_stale_detected",
  "heartbeat.output_stale_escalated",
  "hermes_provider.configured",
  "hire_hook.error",
  "hire_hook.failed",
  "hire_hook.succeeded",
  "human_channel.binding_revoked",
  "human_channel.binding_verified",
  "human_channel.message_received",
  "inbox.cadence_changed",
  "inbox.dismissed",
  "inbox.work_assigned",
  // instance
  "instance.admin_self_serve_bootstrap",
  "instance.mcp_signup",
  "instance.settings.experimental_updated",
  "instance.settings.general_updated",
  "instance.settings.issue_graph_liveness_auto_recovery_run",
  "instructions_backfilled",
  "instructions_refreshed",
  // invites and joins
  "invite.created",
  "invite.openclaw_prompt_created",
  "invite.revoked",
  // issues
  "issue.admin_force_release",
  "issue.approval_linked",
  "issue.approval_unlinked",
  "issue.approvers_updated",
  "issue.assignment_wakeup_requested",
  "issue.attachment_added",
  "issue.attachment_removed",
  "issue.blockers.updated",
  "issue.blockers_updated",
  "issue.checked_out",
  "issue.checkout_lock_adopted",
  "issue.child_created",
  "issue.comment.created",
  "issue.comment_added",
  "issue.comment_cancelled",
  "issue.created",
  "issue.deleted",
  "issue.document_deleted",
  "issue.document_restored",
  "issue.document_updated",
  "issue.document_upserted",
  "issue.feedback_vote_saved",
  "issue.harness_liveness_escalation_created",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
  "issue.productivity_review_continuation_held",
  "issue.productivity_review_created",
  "issue.productivity_review_updated",
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.recovery_budget_exhausted",
  "issue.relations.updated",
  "issue.released",
  "issue.reviewers_updated",
  "issue.task_recovery_permit_consumed",
  "issue.task_recovery_permit_denied",
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_cancelled",
  "issue.thread_interaction_created",
  "issue.thread_interaction_expired",
  "issue.thread_interaction_rejected",
  "issue.touched",
  "issue.tree_hold_run_interrupted",
  "issue.tree_hold_wakeup_deferred",
  "issue.updated",
  "issue.work_product_created",
  "issue.work_product_deleted",
  "issue.work_product_updated",
  "join.approved",
  "join.auto_approved",
  "join.rejected",
  "label.created",
  "label.deleted",
  "model_key.requested",
  "onboarding.member_advanced",
  "onboarding.member_completed",
  // plugins
  "plugin.config.updated",
  "plugin.disabled",
  "plugin.enabled",
  "plugin.installed",
  "plugin.uninstalled",
  "plugin.upgraded",
  // projects
  "project.access_replaced",
  "project.created",
  "project.deleted",
  "project.updated",
  "project.workspace_created",
  "project.workspace_deleted",
  "project.workspace_runtime_restart",
  "project.workspace_runtime_run",
  "project.workspace_runtime_start",
  "project.workspace_runtime_stop",
  "project.workspace_updated",
  "queue_state_changed",
  // routines
  "routine.created",
  "routine.run_triggered",
  "routine.trigger_created",
  "routine.trigger_deleted",
  "routine.trigger_secret_rotated",
  "routine.trigger_updated",
  "routine.updated",
  "secret.created",
  "secret.deleted",
  "secret.rotated",
  "secret.updated",
  "sidebar_preferences.project_order_updated",
  "steward_webhook.registered",
  "steward_webhook.revoked",
  // verdict service rows (underscore actions predate the dotted convention)
  "dod_set",
  "escalated_to_human",
  "human_decision_recorded",
  "metric_updated",
  "reviewer_assignment_retired",
  "reviewer_hire_provision_failed",
  "reviewer_hire_requested",
  "reviewer_hire_throttled",
  "verdict_escalated",
  "verdict_escalation_payload_invalid",
  "verdict_recorded",
  "workflow_recommendation.accepted",
  "workflow_recommendation.declined",
  "workflow_recommendation.raised",
] as const;

describe("every server-written action has a plain verb", () => {
  it.each(SERVER_WRITTEN_ACTIVITY_ACTIONS)("%s", (action) => {
    const verb = formatActivityVerb(action, null);
    // The raw-name fallback at the bottom of formatActivityVerb would return
    // the action with punctuation stripped — never allow it to surface.
    expect(verb).not.toBe(action.replace(/[._]/g, " "));
    expect(verb).not.toMatch(/\./);
    expect(verb).not.toMatch(/_/);
  });
});

// AgentDash (c4 trust): the hosted gaps — bare names, missing objects, and
// system actions credited to the person.
describe("hosted activity gaps", () => {
  it("names what was rejected or approved, not just the verdict", () => {
    expect(formatActivityVerb("approval.rejected", { type: "connector_send" })).toBe(
      "rejected a send request",
    );
    expect(formatActivityVerb("approval.approved", { type: "hire_agent" })).toBe(
      "approved an agent hire",
    );
    expect(formatActivityVerb("approval.created", { type: "deliverable_review" })).toBe(
      "requested approval for a deliverable review",
    );
  });

  it("reads an automatic reopen as a reopen, not a bare update", () => {
    expect(
      formatActivityVerb("issue.updated", { status: "todo", reopened: true, reopenedFrom: "done", source: "comment" }),
    ).toBe("reopened");
    expect(
      formatIssueActivityAction("issue.updated", { status: "todo", reopened: true, reopenedFrom: "done" }),
    ).toContain("reopened the issue");
  });

  it("reads the request-changes flow as requesting changes", () => {
    expect(formatActivityVerb("issue.updated", { status: "in_progress", requestedChanges: true })).toBe(
      "requested changes on",
    );
    expect(
      formatIssueActivityAction("issue.updated", { status: "in_progress", requestedChanges: true }),
    ).toContain("requested changes");
  });

  it("explains a references-only update instead of leaving a stray line", () => {
    const details = {
      addedReferencedIssues: [],
      removedReferencedIssues: [{ id: "i1", identifier: "ACM-2" }],
    };
    expect(formatActivityVerb("issue.updated", details)).toBe("updated references on");
    expect(formatIssueActivityAction("issue.updated", details)).toContain("updated the references");
  });

  it("says what changed on the company, not just 'updated company'", () => {
    expect(formatActivityVerb("company.updated", { requireBoardApprovalForNewAgents: true })).toBe(
      "changed the hire-approval rule",
    );
    expect(formatActivityVerb("company.updated", { name: "Acme" })).toBe("renamed the company");
    expect(formatActivityVerb("company.updated", { brandColor: "#fff", logoAssetId: null })).toBe(
      "updated company settings",
    );
  });

  it("names stewards and join requests in plain words", () => {
    const agentMap = new Map<string, Agent>([["agent-1", { id: "agent-1", name: "Scout" } as Agent]]);
    expect(
      formatActivityVerb("agent.stewardship_assigned", { userId: "local-board", agentId: "agent-1" }, { agentMap }),
    ).toBe("made Board the steward of Scout");
    expect(formatActivityVerb("join.auto_approved", { requestType: "human" })).toBe(
      "auto-approved a join request",
    );
    expect(formatActivityVerb("goal.created")).toBe("created");
    expect(formatActivityVerb("instance.admin_self_serve_bootstrap")).toBe(
      "claimed the instance admin role",
    );
    expect(formatActivityVerb("onboarding.member_completed")).toBe("finished onboarding");
    expect(formatActivityVerb("invite.created", { inviteType: "agent" })).toBe("created an agent invite");
  });

  it("keeps preflight check results in plain words, hidden or shown", () => {
    expect(formatActivityVerb("agent.harness_preflight_passed")).toBe("confirmed this agent can run:");
    expect(formatActivityVerb("agent.harness_preflight_failed")).toBe("found a setup problem on");
  });
});

// AgentDash (c4 trust): pure plumbing is hidden by default; the owner-facing
// events stay.
describe("plumbing hidden by default", () => {
  it("hides tool calls, run internals, and bookkeeping", () => {
    for (const action of [
      "gmail.send",
      "gmail.search",
      "bridge.task_created",
      "cost.reported",
      "heartbeat.completed",
      "heartbeat.cancel_failed",
      "issue.touched",
      "issue.thread_interaction_created",
      "routine.run_triggered",
      "sidebar_preferences.project_order_updated",
      "instructions_refreshed",
      "metric_updated",
      "connector_send.reconciled",
    ]) {
      expect(isSystemPlumbingActivity(action)).toBe(true);
    }
  });

  it("keeps the owner-visible events shown", () => {
    for (const action of [
      "issue.created",
      "issue.updated",
      "agent.harness_preflight_failed",
      "heartbeat.output_stale_escalated",
      "issue.recovery_budget_exhausted",
      "issue.task_recovery_permit_denied",
      "connector_send.refused",
      "approval.rejected",
      "agent.stewardship_assigned",
    ]) {
      expect(isSystemPlumbingActivity(action)).toBe(false);
    }
  });
});
