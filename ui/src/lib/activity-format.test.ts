import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
 * The scan below covers the same writes plus ternary, multi-line, and
 * interpolated `action:` expressions.
 */
const SERVER_WRITTEN_ACTIVITY_ACTIONS = [
  // agent lifecycle and configuration
  "agent.accountability_changed",
  "agent.approved",
  "agent.budget_updated",
  "agent.config_rolled_back",
  "agent.connect_code_created",
  "agent.connect_code_redeemed",
  "agent.created",
  "agent.deleted",
  "agent.directives_pushed",
  "agent.governance_ceiling_updated",
  "agent.governance_change_rejected",
  "agent.governance_configuration_clamped",
  "agent.governance_harness_request_clamped",
  "agent.governance_request_updated",
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
  "github_connection.connected",
  "github_connection.credential_issued",
  "github_connection.disconnected",
  "github_connection.rotated",
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
  "heartbeat.watchdog_decision_recorded",
  "heartbeat.watchdog_snoozed",
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
  "issue.document_created",
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
  "issue.recovery_budget_cleared",
  "issue.recovery_budget_exhausted",
  "issue.relations.updated",
  "issue.released",
  "issue.reviewers_updated",
  "issue.task_recovery_authorized",
  "issue.task_recovery_permit_consumed",
  "issue.task_recovery_permit_denied",
  "issue.task_recovery_permit_superseded",
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_cancelled",
  "issue.thread_interaction_created",
  "issue.thread_interaction_expired",
  "issue.thread_interaction_rejected",
  "issue.touched",
  "issue.tree_hold_effect_unresolved",
  "issue.tree_hold_run_interrupted",
  "issue.tree_hold_wakeup_deferred",
  "issue.tree_restore_wakeup_requested",
  "issue.updated",
  "issue.work_product_created",
  "issue.work_product_deleted",
  "issue.work_product_updated",
  "join.approved",
  "join.auto_approved",
  "join.rejected",
  "join.request_replayed",
  "join.requested",
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
  "workspace.persistence_recovery_cleared",
] as const;

/**
 * AgentDash (c4 trust, review #1026): `action:` fields in server code that are
 * NOT activity rows — step kinds, healer skip reasons, decision payloads.
 * Anything else the scan finds must land in SERVER_WRITTEN_ACTIVITY_ACTIONS.
 */
const NON_ACTIVITY_ACTION_FIELDS = new Set([
  "ask_next", // deep-interview step kinds (inside a prompt-doc string)
  "force_crystallize",
  "skipped_cost_limit", // run-healer skip reasons
  "skipped_daily_limit",
  "skipped_low_confidence",
  "skipped_no_diagnosis",
]);

/**
 * `action:` writes whose value is a named constant. The scan flags the
 * identifier; each entry records the value it resolves to (null when the
 * constant is not an activity action, e.g. an attestation scope).
 */
const CONSTANT_ACTION_WRITES = new Map<string, string | null>([
  ["AUTHZ_REFUSED_ACTION", "authz.refused"], // services/activity-log.ts
  ["ISSUE_RECOVERY_BUDGET_CLEARED_ACTION", "issue.recovery_budget_cleared"], // services/issue-recovery-budget.ts
  ["DEMO_SCOPE", null], // services/handshake-demo.ts — attestation scope, not an activity action
]);

/**
 * Interpolated action writes — `action: `foo.${x}`` — keyed by the static
 * prefix before the first `${}`, valued by every action string the template
 * can produce (verified at the write site, not inferred).
 */
const TEMPLATE_ACTION_FAMILIES = new Map<string, readonly string[]>([
  // routes/execution-workspaces.ts and routes/projects.ts — the `action`
  // route param is validated to start|stop|restart|run.
  ["execution_workspace.runtime_", [
    "execution_workspace.runtime_start",
    "execution_workspace.runtime_stop",
    "execution_workspace.runtime_restart",
    "execution_workspace.runtime_run",
  ]],
  ["project.workspace_runtime_", [
    "project.workspace_runtime_start",
    "project.workspace_runtime_stop",
    "project.workspace_runtime_restart",
    "project.workspace_runtime_run",
  ]],
  // services/connector-send-execution.ts — result.outcome is
  // succeeded|failed|outcome_unknown.
  ["connector_send.", [
    "connector_send.succeeded",
    "connector_send.failed",
    "connector_send.outcome_unknown",
  ]],
  // services/workflow-recommendations.ts — status is accepted|declined.
  ["workflow_recommendation.", [
    "workflow_recommendation.accepted",
    "workflow_recommendation.declined",
  ]],
  // services/human-control/questions.ts — respond→answered,
  // cancel→cancelled, anything else→created.
  ["issue.thread_interaction_", [
    "issue.thread_interaction_answered",
    "issue.thread_interaction_cancelled",
    "issue.thread_interaction_created",
  ]],
]);

type ServerActionScan = {
  literals: string[];
  templatePrefixes: string[];
  constantWrites: string[];
};

/**
 * Scan every `action:` expression in production server code (tests excluded).
 *
 * The value is read until the next sibling property key (`name:` after a
 * `,`, `{`, newline, or `;`) or a closing `}`/`]`/`;`, so multi-line
 * ternaries contribute every quoted literal. Quoted literals that are
 * comparison operands (`x === "lit"`, `"lit" === x`) and anything inside a
 * template literal are scrubbed first — they are conditions or suffix arms,
 * not actions. Interpolated templates contribute their static prefix (for
 * TEMPLATE_ACTION_FAMILIES), found by looking forward from `action:` since
 * `${}` braces can close the window mid-template. Member-expression values
 * (`r.action`, `input.action`) forward already-written actions and are
 * skipped; a SHOUTED identifier must resolve in CONSTANT_ACTION_WRITES.
 */
function scanServerActions(): ServerActionScan {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../server/src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
      } else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root);

  const ACTION_KEY = /\baction\s*:/g;
  const VALUE_END = /[,\n{;]\s*[\w$]+\s*:|[{}\];]|\]/g;
  const HAS_BOUNDARY = /[,\n{;]\s*[\w$]+\s*:|[{}\];]|\]/;
  const QUOTED_LITERAL = /['"`]([a-z][a-zA-Z0-9]*(?:[._][a-zA-Z0-9]+)+)['"`]/g;
  const COMPARISON_OPERAND =
    /(["'`])([^"'`\n]*)\1\s*(?:!==?|===?)|(?:!==?|===?)\s*(["'`])([^"'`\n]*)\3/g;
  const ACTION_PREFIX = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*[._]$/;
  const ACTION_LITERAL = /^[a-z][a-zA-Z0-9]*(?:[._][a-zA-Z0-9]+)+$/;
  const SHOUTED_CONST = /^\s*([A-Z][A-Z0-9_]+)\b/;

  const literals = new Set<string>();
  const templatePrefixes = new Set<string>();
  const constantWrites = new Set<string>();

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const key of content.matchAll(ACTION_KEY)) {
      const start = key.index + key[0].length;
      VALUE_END.lastIndex = start;
      const end = VALUE_END.exec(content)?.index;
      const value = content.slice(start, end ?? content.length);

      // Interpolated write: the first template on the value (or in a ternary
      // arm) — any boundary before the backtick means it belongs to a later
      // property, not this action.
      const tail = content.slice(start, start + 800);
      const backtick = tail.indexOf("`");
      if (backtick !== -1 && !HAS_BOUNDARY.test(tail.slice(0, backtick))) {
        const close = tail.indexOf("`", backtick + 1);
        const body = tail.slice(backtick + 1, close === -1 ? undefined : close);
        if (body.includes("${")) {
          const prefix = body.slice(0, body.indexOf("${"));
          if (ACTION_PREFIX.test(prefix)) templatePrefixes.add(prefix);
        } else if (ACTION_LITERAL.test(body) && !NON_ACTIVITY_ACTION_FIELDS.has(body)) {
          literals.add(body); // `action: `pure literal``
        }
      }

      const scrubbed = value
        .replace(COMPARISON_OPERAND, " ")
        .replace(/`[^`]*`/g, " ")
        .replace(/`[^`]*$/g, " "); // window may end mid-template
      for (const literal of scrubbed.matchAll(QUOTED_LITERAL)) {
        if (!NON_ACTIVITY_ACTION_FIELDS.has(literal[1])) literals.add(literal[1]);
      }
      const constant = value.match(SHOUTED_CONST);
      if (constant) constantWrites.add(constant[1]);
    }
  }

  return {
    literals: [...literals].sort(),
    templatePrefixes: [...templatePrefixes].sort(),
    constantWrites: [...constantWrites].sort(),
  };
}

describe("every server-written action has a plain verb", () => {
  it.each(SERVER_WRITTEN_ACTIVITY_ACTIONS)("%s", (action) => {
    const verb = formatActivityVerb(action, null);
    // The raw-name fallback at the bottom of formatActivityVerb would return
    // the action with punctuation stripped — never allow it to surface.
    expect(verb).not.toBe(action.replace(/[._]/g, " "));
    expect(verb).not.toMatch(/\./);
    expect(verb).not.toMatch(/_/);
  });

  it("the catalogue covers every action the server writes — literal, ternary, or interpolated", () => {
    const known = new Set<string>(SERVER_WRITTEN_ACTIVITY_ACTIONS);
    const scan = scanServerActions();

    // Quoted literals — direct writes and every arm of a ternary.
    expect(scan.literals.filter((action) => !known.has(action))).toEqual([]);

    // Interpolated writes surface as their static prefix; every value the
    // template can produce must be catalogued.
    expect(scan.templatePrefixes.filter((prefix) => !TEMPLATE_ACTION_FAMILIES.has(prefix))).toEqual([]);
    for (const [prefix, actions] of TEMPLATE_ACTION_FAMILIES) {
      expect(
        actions.filter((action) => !known.has(action)),
        `${prefix}… expansions must all be catalogued`,
      ).toEqual([]);
    }

    // Named-constant writes resolve to an action (or a verified non-activity
    // value) — the identifier itself is what the scan can see.
    expect(scan.constantWrites.filter((name) => !CONSTANT_ACTION_WRITES.has(name))).toEqual([]);
    for (const [name, action] of CONSTANT_ACTION_WRITES) {
      if (action !== null) expect(known.has(action), `${name} → ${action}`).toBe(true);
    }
  });

  it("sees the write shapes a literal-only regex misses", () => {
    const scan = scanServerActions();
    // Ternary arms — including multi-line ternaries and a call in the
    // condition — all resolve to literal action strings.
    for (const action of [
      "issue.document_created", // issues.ts: result.created ? created : updated
      "agent.governance_ceiling_updated", // agent-governance.ts: multi-line ternary
      "agent.harness_preflight_failed", // agents.ts: isBlockingPreflightResult() ? … : …
      "issue.thread_interaction_rejected", // issues.ts: ternary across lines
    ]) {
      expect(scan.literals).toContain(action);
    }
    // Interpolated writes surface as the template's static prefix.
    for (const prefix of TEMPLATE_ACTION_FAMILIES.keys()) {
      expect(scan.templatePrefixes).toContain(prefix);
    }
    // Condition operands are not actions — "owner_ceiling" compares the
    // governance target, "expired" the interaction status.
    expect(scan.literals).not.toContain("owner_ceiling");
    expect(scan.literals).not.toContain("expired");
    expect(scan.constantWrites).toContain("AUTHZ_REFUSED_ACTION");
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
      "gmail.search",
      "gmail.draft",
      "bridge.task_created",
      "cost.reported",
      "heartbeat.completed",
      "heartbeat.cancel_failed",
      "issue.touched",
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
      // AgentDash (review #1026): these read as plumbing but are owner-visible
      // — a sent mail, a delivered send, a worker enroll, a credential handoff,
      // a secret rotation, a webhook registration, a thread prompt.
      "gmail.send",
      "connector_send.succeeded",
      "bridge.endpoint_enrolled",
      "github_connection.credential_issued",
      "routine.trigger_secret_rotated",
      "steward_webhook.registered",
      "issue.thread_interaction_created",
    ]) {
      expect(isSystemPlumbingActivity(action)).toBe(false);
    }
  });
});
