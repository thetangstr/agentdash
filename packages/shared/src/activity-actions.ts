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
 */
export const HIDDEN_FEED_ACTIVITY_ACTIONS = [
  ...ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS,
  "queue_state_changed",
  "environment.lease_acquired",
  "environment.lease_released",
  "environment.probed",
  "environment.probed_unsaved",
  "agent.harness_preflight_passed",
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
