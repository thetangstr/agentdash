/**
 * AgentDash (batch 2 review lane / review #1003): the activity-feed visibility
 * lists, shared by the server feed query and the UI so they cannot drift apart.
 */

/** Bookkeeping actions that never surface in feeds: local read/inbox markers. */
export const ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

/**
 * Actions hidden from the default feeds — local bookkeeping plus workspace/env
 * machinery and review-queue churn. The company Activity feed filters these in
 * SQL when "Show system events" is off; Home hides them unconditionally; the
 * issue feed hides the inbox/queue subset.
 *
 * AgentDash (c4 trust): the hidden set now covers every plumbing event that
 * can reach the feed — tool calls (gmail.*, bridge.*), evaluator machinery
 * (evaluation.*, agent_fact.* except its escalations), wake/interaction
 * internals, per-run cost rows, and trigger bookkeeping. They still have plain
 * verbs for the "Show system events" view; they just do not interrupt reading
 * what the company actually did.
 */
export const HIDDEN_FEED_ACTIVITY_ACTIONS = [
  ...ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS,
  "queue_state_changed",
  "environment.lease_acquired",
  "environment.lease_released",
  "environment.probed",
  "environment.probed_unsaved",
  "agent.harness_preflight_passed",
  // Agent memory/skills internals
  "agent.memory_written",
  "agent.secret_activity",
  "agent.skills_synced",
  "agent.updated_from_join_replay",
  "agent.visible_activity",
  // Agent-fact Q&A internals (escalations stay visible)
  "agent_fact.answer_discarded",
  "agent_fact.answer_held",
  "agent_fact.answer_released",
  "agent_fact.answered",
  "agent_fact.asked",
  "agent_fact.declined",
  // Approval wake plumbing
  "approval.requester_wakeup_failed",
  "approval.requester_wakeup_queued",
  // Local-harness bridge plumbing
  "bridge.endpoint_enrolled",
  "bridge.endpoint_revoked",
  "bridge.task_completed",
  "bridge.task_created",
  "bridge.task_declined",
  // Skill scanning machinery
  "company.skills_scanned",
  // Send-reconciliation bookkeeping (refusals and undelivered reports stay)
  "connector_send.reconciled",
  // Per-run cost rows — the Costs page owns these
  "cost.reported",
  // Evaluator machinery
  "evaluation.contract_declared",
  "evaluation.correction_filed",
  "evaluation.correction_noted",
  "evaluation.disposition_recorded",
  "evaluation.finding_noted",
  "evaluation.ingest_run",
  "evaluation.principal_provisioned",
  "evaluation.review_items_synced",
  "evaluation.scorecard_snapshot",
  "execution_workspace.updated",
  "finance_event.reported",
  "github_connection.credential_issued",
  // Connector tool calls
  "gmail.draft",
  "gmail.list",
  "gmail.read_thread",
  "gmail.search",
  "gmail.send",
  // Run lifecycle internals
  "heartbeat.cancel_failed",
  "heartbeat.completed",
  "heartbeat.output_stale_detected",
  // Successful hire hooks (failures and errors stay visible)
  "hire_hook.succeeded",
  "human_channel.message_received",
  // Delivered connector sends (failures and refusals stay visible)
  "connector_send.succeeded",
  // Inbox bookkeeping
  "inbox.cadence_changed",
  "inbox.dismissed",
  "instance.mcp_signup",
  "instance.settings.issue_graph_liveness_auto_recovery_run",
  "instructions_backfilled",
  "instructions_refreshed",
  "metric_updated",
  // Issue machinery
  "issue.assignment_wakeup_requested",
  "issue.blockers.updated",
  "issue.checkout_lock_adopted",
  "issue.productivity_review_continuation_held",
  "issue.productivity_review_created",
  "issue.productivity_review_updated",
  "issue.task_recovery_permit_consumed",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_cancelled",
  "issue.thread_interaction_created",
  "issue.thread_interaction_expired",
  "issue.touched",
  "issue.tree_hold_run_interrupted",
  "issue.tree_hold_wakeup_deferred",
  // Routine trigger internals
  "routine.run_triggered",
  "routine.trigger_created",
  "routine.trigger_deleted",
  "routine.trigger_secret_rotated",
  "routine.trigger_updated",
  "sidebar_preferences.project_order_updated",
  "steward_webhook.registered",
  "steward_webhook.revoked",
  // Reviewer auto-hire machinery (a failed provision stays visible)
  "reviewer_hire_requested",
  "reviewer_hire_throttled",
  "verdict_escalation_payload_invalid",
] as const;

/**
 * AgentDash (review #1003): system-actor events an owner DOES need to see —
 * budget hard-stops, ceiling pauses, failed recovery, verdict and liveness
 * escalations, failed hire hooks and undelivered sends. Home hides system-actor
 * plumbing but keeps these.
 */
export const IMPORTANT_SYSTEM_ACTIVITY_ACTIONS = new Set<string>([
  "budget.hard_threshold_crossed",
  "agent.token_ceiling_paused",
  "agent.paused",
  "issue.recovery_budget_exhausted",
  "heartbeat.recovery_budget_refusal",
  "issue.task_recovery_permit_denied",
  "heartbeat.output_stale_escalated",
  "issue.harness_liveness_escalation_created",
  "agent_fact.escalated",
  "hire_hook.failed",
  "hire_hook.error",
  "verdict_escalated",
  "reviewer_hire_provision_failed",
  "connector_send.undelivered_reported",
]);
