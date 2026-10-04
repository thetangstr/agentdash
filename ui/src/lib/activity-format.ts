import type { Agent } from "@paperclipai/shared";
import { HIDDEN_FEED_ACTIVITY_ACTIONS, IMPORTANT_SYSTEM_ACTIVITY_ACTIONS } from "@paperclipai/shared";
import type { CompanyUserProfile } from "./company-members";
import { issueStatusLabel } from "./issue-status-label";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
};

type ActivityIssueReference = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
}

/**
 * AgentDash (Scan 3, lane J): machinery events a non-technical owner should
 * not have to read. "environment lease acquired" and "agent harness preflight
 * passed" filled the feed, attributed to whichever agent or person triggered
 * them (the preflight one read as the CEO's own action). They are hidden from
 * the default feeds and, when shown, are relabelled and attributed to System.
 * The list lives in packages/shared so this and the server feed stay in step.
 */
const SYSTEM_PLUMBING_ACTIONS = new Set<string>(HIDDEN_FEED_ACTIVITY_ACTIONS);

export function isSystemPlumbingActivity(action: string): boolean {
  return SYSTEM_PLUMBING_ACTIONS.has(action);
}

export { IMPORTANT_SYSTEM_ACTIVITY_ACTIONS };

/**
 * AgentDash (c4 trust): every action the server writes must land here — a
 * dotted name rendered raw ("agent.stewardship_assigned") reads as a system
 * glitch to a non-technical owner. `activity-format.test.ts` keeps a catalogue
 * of every server-written action and asserts none reach the `.replace`
 * fallback at the bottom of `formatActivityVerb`.
 */
const ACTIVITY_ROW_VERBS: Record<string, string> = {
  // Agent lifecycle and configuration
  "agent.accountability_changed": "changed accountability for",
  "agent.approved": "approved",
  "agent.budget_updated": "updated budget for",
  "agent.config_rolled_back": "rolled back the configuration of",
  "agent.connect_code_created": "created a connect code for",
  "agent.connect_code_redeemed": "redeemed a connect code for",
  "agent.created": "created",
  "agent.deleted": "deleted",
  "agent.directives_pushed": "pushed operating directives to",
  "agent.governance_ceiling_updated": "updated the governance ceiling on",
  "agent.governance_change_rejected": "rejected a governance change on",
  "agent.governance_configuration_clamped": "narrowed the governance settings of",
  "agent.governance_request_updated": "updated a governance request on",
  "agent.governance_harness_request_clamped": "narrowed a harness request on",
  "agent.harness_preflight_failed": "found a setup problem on",
  "agent.harness_preflight_passed": "confirmed this agent can run:",
  "agent.hire_created": "created a hire for",
  "agent.hired": "hired",
  "agent.instructions_bundle_updated": "updated the instruction files of",
  "agent.instructions_file_deleted": "deleted an instruction file on",
  "agent.instructions_file_updated": "updated an instruction file on",
  "agent.instructions_path_updated": "changed where instructions live for",
  "agent.key_created": "created API key for",
  "agent.key_revoked": "revoked an API key for",
  "agent.memory_written": "saved a memory for",
  "agent.paused": "paused",
  "agent.permissions_updated": "updated permissions for",
  "agent.resumed": "resumed",
  "agent.runtime_session_reset": "reset session for",
  "agent.secret_activity": "worked with a secret on",
  "agent.skills_synced": "synced skills for",
  "agent.terminated": "terminated",
  "agent.token_ceiling_paused": "paused after hitting the token ceiling on",
  "agent.token_ceiling_updated": "updated the token ceiling for",
  "agent.updated": "updated",
  "agent.updated_from_join_replay": "replayed a setup change on",
  "agent.visible_activity": "recorded activity on",
  "agent_api_key.claimed": "claimed an API key",
  "agent_fact.answer_discarded": "discarded an answer to a question",
  "agent_fact.answer_held": "held an answer to a question",
  "agent_fact.answer_released": "released an answer to a question",
  "agent_fact.answered": "answered a question",
  "agent_fact.asked": "asked a question",
  "agent_fact.declined": "declined a question",
  "agent_fact.escalated": "escalated a question to a person",
  "approval.comment_added": "commented on an approval request",
  "approval.redacted": "redacted an approval request",
  "approval.requester_wakeup_failed": "could not notify the requester of",
  "approval.requester_wakeup_queued": "queued a notification for the requester of",
  "asset.created": "added an asset",
  "assistant.gated_action": "performed a gated action with an assistant grant",
  "authz.refused": "was denied access",
  "board_api_key.created": "created a board API key",
  "board_api_key.revoked": "revoked a board API key",
  "bridge.endpoint_enrolled": "connected a local machine",
  "bridge.endpoint_revoked": "disconnected a local machine",
  "bridge.task_completed": "finished a local task",
  "bridge.task_created": "created a local task",
  "bridge.task_declined": "declined a local task",
  "budget.hard_threshold_crossed": "hit the hard budget limit",
  "budget.incident_resolved": "resolved a budget incident",
  "budget.policy_upserted": "updated the budget policy",
  "budget.soft_threshold_crossed": "crossed the soft budget limit",
  "company.archived": "archived",
  "company.branding_updated": "updated the company branding",
  "company.budget_updated": "updated budget for",
  "company.created": "created company",
  "company.feedback_data_sharing_updated": "changed the feedback data-sharing setting on",
  "company.imported": "imported",
  "company.skill_created": "created a company skill",
  "company.skill_deleted": "deleted a company skill",
  "company.skill_file_updated": "updated a company skill file",
  "company.skill_update_installed": "installed a skill update",
  "company.skills_imported": "imported company skills",
  "company.skills_scanned": "scanned for available skills",
  "company_member.access_updated": "updated a member's access",
  "company_member.archived": "archived a member",
  "company_member.permissions_updated": "updated a member's permissions",
  "company_member.updated": "updated a member",
  "connection.created": "connected an integration",
  "connection.hubspot_connected": "connected HubSpot",
  "connection.hubspot_rotated": "rotated the HubSpot credential",
  "connection.hubspot_write_requested": "asked to write to HubSpot",
  "connection.revoked": "disconnected an integration",
  "connection.sharepoint_connected": "connected SharePoint",
  "connector_send.failed": "could not deliver a connector send",
  "connector_send.outcome_unknown": "cannot confirm a connector send was delivered",
  "connector_send.reconciled": "reconciled a connector send",
  "connector_send.refused": "refused a connector send",
  "connector_send.succeeded": "delivered a connector send",
  "connector_send.undelivered_reported": "reported a connector send undelivered",
  "cost.recorded": "recorded cost for",
  "cost.reported": "reported cost for",
  "deliverable.corrected": "corrected a deliverable",
  "deliverable.defined": "defined a deliverable",
  "deliverable.presented": "presented a deliverable",
  "deliverable.sent_back": "sent a deliverable back for changes",
  "deliverable.shipped": "shipped a deliverable",
  "environment.created": "created an environment",
  "environment.deleted": "deleted an environment",
  "environment.lease_acquired": "prepared a workspace for a run",
  "environment.lease_released": "cleaned up a run's workspace",
  "environment.probed": "checked a run environment",
  "environment.probed_unsaved": "checked a run environment",
  "environment.updated": "updated an environment",
  "evaluation.contract_declared": "declared an evaluation contract",
  "evaluation.correction_filed": "filed an evaluation correction",
  "evaluation.correction_noted": "noted an evaluation correction",
  "evaluation.disposition_recorded": "recorded an evaluation disposition",
  "evaluation.finding_noted": "noted an evaluation finding",
  "evaluation.ingest_run": "ingested an evaluation run",
  "evaluation.principal_provisioned": "provisioned an evaluation principal",
  "evaluation.review_items_synced": "synced evaluation review items",
  "evaluation.scorecard_snapshot": "took a scorecard snapshot",
  "execution_workspace.runtime_restart": "restarted a workspace command on",
  "execution_workspace.runtime_run": "ran a workspace command on",
  "execution_workspace.runtime_start": "started a workspace command on",
  "execution_workspace.runtime_stop": "stopped a workspace command on",
  "execution_workspace.updated": "updated a workspace",
  "finance_event.reported": "recorded a charge",
  "github_connection.connected": "connected GitHub",
  "github_connection.credential_issued": "issued a GitHub credential",
  "github_connection.disconnected": "disconnected GitHub",
  "github_connection.rotated": "rotated the GitHub credential",
  "gmail.draft": "drafted an email",
  "gmail.list": "listed emails",
  "gmail.read_thread": "read an email thread",
  "gmail.search": "searched email",
  "gmail.send": "sent an email",
  "goal.created": "created",
  "goal.deleted": "deleted",
  "goal.updated": "updated",
  "goal_created_from_onboarding": "created a goal during onboarding",
  "heartbeat.cancel_failed": "could not stop a run",
  "heartbeat.cancelled": "cancelled heartbeat for",
  "heartbeat.completed": "finished a run",
  "heartbeat.invoked": "started a run for",
  "heartbeat.output_stale_detected": "detected a stalled run",
  "heartbeat.output_stale_escalated": "escalated a stalled run",
  "heartbeat.watchdog_decision_recorded": "recorded a decision on a stalled run",
  "heartbeat.watchdog_snoozed": "snoozed run monitoring",
  "hermes_provider.configured": "configured the local model provider",
  "hire_hook.error": "a hire hook hit an error",
  "hire_hook.failed": "a hire hook failed",
  "hire_hook.succeeded": "a hire hook ran",
  "human_channel.binding_revoked": "revoked a messaging-channel pairing",
  "human_channel.binding_verified": "verified a messaging-channel pairing",
  "human_channel.message_received": "received a message on a channel",
  "inbox.cadence_changed": "changed the inbox cadence",
  "inbox.dismissed": "dismissed an inbox item",
  "inbox.work_assigned": "assigned work from the inbox",
  "instance.admin_self_serve_bootstrap": "claimed the instance admin role",
  "instance.mcp_signup": "signed up through MCP onboarding",
  "instance.settings.experimental_updated": "updated experimental settings",
  "instance.settings.general_updated": "updated instance settings",
  "instance.settings.issue_graph_liveness_auto_recovery_run": "ran issue-graph auto-recovery",
  "instructions_backfilled": "backfilled instruction files for",
  "instructions_refreshed": "refreshed instruction files for",
  "invite.openclaw_prompt_created": "created an agent invite prompt",
  "invite.revoked": "revoked an invite",
  "issue.admin_force_release": "force-released the checkout lock on",
  "issue.approval_linked": "linked an approval to",
  "issue.approval_unlinked": "unlinked an approval from",
  "issue.approvers_updated": "updated approvers on",
  "issue.assignment_wakeup_requested": "requested a wake-up for the assignee of",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.blockers.updated": "updated blockers on",
  "issue.blockers_updated": "updated blockers on",
  "issue.checked_out": "checked out",
  "issue.checkout_lock_adopted": "adopted the checkout lock on",
  "issue.child_created": "created a sub-issue of",
  "issue.comment.created": "commented on",
  "issue.comment_added": "commented on",
  "issue.comment_cancelled": "cancelled a queued comment on",
  "issue.commented": "commented on",
  "issue.created": "created",
  "issue.deleted": "deleted",
  "issue.document_created": "created document for",
  "issue.document_deleted": "deleted document from",
  "issue.document_restored": "restored a document on",
  "issue.document_updated": "updated document on",
  "issue.document_upserted": "updated a document on",
  "issue.feedback_vote_saved": "saved feedback on an AI output on",
  "issue.harness_liveness_escalation_created": "escalated a stalled run on",
  "issue.inbox_archived": "archived",
  "issue.inbox_unarchived": "unarchived",
  "issue.productivity_review_continuation_held": "held a productivity review on",
  "issue.productivity_review_created": "opened a productivity review on",
  "issue.productivity_review_updated": "updated a productivity review on",
  "issue.read_marked": "marked as read",
  "issue.read_unmarked": "marked as unread",
  "issue.recovery_budget_cleared": "reset recovery attempts on",
  "issue.recovery_budget_exhausted": "ran out of recovery attempts on",
  "issue.relations.updated": "updated references on",
  "issue.released": "released",
  "issue.reviewers_updated": "updated reviewers on",
  "issue.task_recovery_authorized": "authorized a recovery attempt on",
  "issue.task_recovery_permit_consumed": "used a recovery attempt on",
  "issue.task_recovery_permit_denied": "was denied a recovery attempt on",
  "issue.task_recovery_permit_superseded": "replaced a recovery attempt on",
  "issue.thread_interaction_accepted": "accepted a suggestion on",
  "issue.thread_interaction_answered": "answered a question on",
  "issue.thread_interaction_cancelled": "withdrew a request on",
  "issue.thread_interaction_created": "asked for input on",
  "issue.thread_interaction_expired": "a request expired on",
  "issue.thread_interaction_rejected": "declined a suggestion on",
  "issue.touched": "touched",
  "issue.tree_hold_effect_unresolved": "could not resolve a held action on",
  "issue.tree_hold_run_interrupted": "interrupted a run held by",
  "issue.tree_hold_wakeup_deferred": "deferred a wake-up for",
  "issue.tree_restore_wakeup_requested": "requested a wake-up to restore",
  "issue.updated": "updated",
  "issue.work_product_created": "added a deliverable to",
  "issue.work_product_deleted": "removed a deliverable from",
  "issue.work_product_updated": "updated a deliverable on",
  "join.request_replayed": "requested to join again",
  "join.requested": "requested to join",
  "label.created": "created a label",
  "label.deleted": "deleted a label",
  "model_key.requested": "requested a model key",
  "onboarding.member_advanced": "moved onboarding forward",
  "onboarding.member_completed": "finished onboarding",
  "plugin.config.updated": "updated a plugin's settings",
  "plugin.disabled": "disabled a plugin",
  "plugin.enabled": "enabled a plugin",
  "plugin.installed": "installed a plugin",
  "plugin.uninstalled": "uninstalled a plugin",
  "plugin.upgraded": "upgraded a plugin",
  "project.access_replaced": "updated access to",
  "project.created": "created",
  "project.deleted": "deleted",
  "project.updated": "updated",
  "project.workspace_created": "added a workspace to",
  "project.workspace_deleted": "removed a workspace from",
  "project.workspace_runtime_restart": "restarted a workspace command on",
  "project.workspace_runtime_run": "ran a workspace command on",
  "project.workspace_runtime_start": "started a workspace command on",
  "project.workspace_runtime_stop": "stopped a workspace command on",
  "project.workspace_updated": "updated a workspace on",
  "queue_state_changed": "updated the review queue on",
  "routine.created": "created a routine",
  "routine.run_triggered": "triggered a routine run",
  "routine.trigger_created": "created a routine trigger",
  "routine.trigger_deleted": "deleted a routine trigger",
  "routine.trigger_secret_rotated": "rotated a routine trigger secret",
  "routine.trigger_updated": "updated a routine trigger",
  "routine.updated": "updated a routine",
  "secret.created": "created a secret",
  "secret.deleted": "deleted a secret",
  "secret.rotated": "rotated a secret",
  "secret.updated": "updated a secret",
  "sidebar_preferences.project_order_updated": "reordered projects",
  "steward_webhook.registered": "registered a webhook",
  "steward_webhook.revoked": "revoked a webhook",
  "verdict_escalated": "escalated a verdict to a person on",
  "verdict_escalation_payload_invalid": "ignored an invalid verdict escalation",
  "verdict_recorded": "recorded a review verdict on",
  "workspace.persistence_recovery_cleared": "cleared a workspace recovery",
  "workflow_recommendation.accepted": "accepted a workflow suggestion",
  "workflow_recommendation.declined": "declined a workflow suggestion",
  "workflow_recommendation.raised": "raised a workflow suggestion",
  // Verdict service rows (underscore actions predate the dotted convention)
  "dod_set": "set the definition of done on",
  "escalated_to_human": "asked a person to review",
  "human_decision_recorded": "recorded a person's decision",
  "metric_updated": "updated a metric",
  "reviewer_assignment_retired": "retired a reviewer assignment",
  "reviewer_hire_provision_failed": "could not provision a reviewer hire",
  "reviewer_hire_requested": "requested a reviewer hire",
  "reviewer_hire_throttled": "delayed a reviewer hire",
};

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.comment_cancelled": "cancelled a queued comment",
  "issue.feedback_vote_saved": "saved feedback on an AI output",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.read_marked": "marked the issue as read",
  "issue.read_unmarked": "marked the issue as unread",
  "issue.inbox_archived": "archived the issue",
  "issue.inbox_unarchived": "unarchived the issue",
  "queue_state_changed": "updated the review queue",
  "issue.work_product_created": "added a deliverable",
  "issue.work_product_updated": "updated a deliverable",
  "issue.work_product_deleted": "removed a deliverable",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** "in_progress" -> "In progress": the board's own status words, not the stored value. */
function statusWords(value: unknown): string {
  return typeof value === "string" ? issueStatusLabel(value) : humanizeValue(value);
}

function humanizeValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "none");
  return value.replace(/_/g, " ");
}

function isActivityParticipant(value: unknown): value is ActivityParticipant {
  const record = asRecord(value);
  if (!record) return false;
  return record.type === "agent" || record.type === "user";
}

function isActivityIssueReference(value: unknown): value is ActivityIssueReference {
  return asRecord(value) !== null;
}

function readParticipants(details: ActivityDetails, key: string): ActivityParticipant[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityParticipant);
}

function readIssueReferences(details: ActivityDetails, key: string): ActivityIssueReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityIssueReference);
}

function formatUserLabel(userId: string | null | undefined, options: ActivityFormatOptions = {}): string {
  if (!userId || userId === "local-board") return "Board";
  if (options.currentUserId && userId === options.currentUserId) return "You";
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return `user ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? "agent";
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return "issue";
}

function formatChangedEntityLabel(
  singular: string,
  plural: string,
  labels: string[],
): string {
  if (labels.length <= 0) return plural;
  if (labels.length === 1) return `${singular} ${labels[0]}`;
  return `${labels.length} ${plural}`;
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  // AgentDash (c4 trust): a comment that reopens a closed issue and the
  // request-changes route both write `issue.updated`; the plain "updated" verb
  // hid what actually happened. The entity name follows the verb, so these
  // read "… reopened ACM-4" / "… requested changes on ACM-6".
  if (details.reopened === true) return "reopened";
  if (details.requestedChanges === true) return "requested changes on";
  if (details.status !== undefined) {
    const from = previous.status;
    return from
      ? `changed status from ${statusWords(from)} to ${statusWords(details.status)} on`
      : `changed status to ${statusWords(details.status)} on`;
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    return from
      ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)} on`
      : `changed priority to ${humanizeValue(details.priority)} on`;
  }
  // AgentDash (c4 trust): reference-only edits rendered as bare "updated"
  // while the added/removed chips appeared unexplained underneath — a stray
  // "Removed references ACM-2 ACM-5" line in the hosted feed.
  if (
    readIssueReferences(details, "addedReferencedIssues").length > 0 ||
    readIssueReferences(details, "removedReferencedIssues").length > 0
  ) {
    return "updated references on";
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? "agent";
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  // AgentDash (c4 trust): same special cases as formatIssueUpdatedVerb.
  if (details.reopened === true) parts.push("reopened the issue");
  if (details.requestedChanges === true) parts.push("requested changes");

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      from
        ? `changed the status from ${statusWords(from)} to ${statusWords(details.status)}`
        : `changed the status to ${statusWords(details.status)}`,
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
        : `changed the priority to ${humanizeValue(details.priority)}`,
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(assigneeName ? `assigned the issue to ${assigneeName}` : "unassigned the issue");
  }
  if (details.title !== undefined) parts.push("updated the title");
  if (details.description !== undefined) parts.push("updated the description");
  if (
    readIssueReferences(details, "addedReferencedIssues").length > 0 ||
    readIssueReferences(details, "removedReferencedIssues").length > 0
  ) {
    parts.push("updated the references");
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * AgentDash (c3 copy): a run stops for a reason the person should read —
 * "cancelled heartbeat" attributed it like a manual kill. The actor is who
 * stopped it; the reason is why ("the issue was marked done"), so a stop that
 * happened as a side effect no longer reads as the person ending the run.
 */
const HEARTBEAT_CANCEL_REASONS: Record<string, (issue: string) => string> = {
  issue_status_done: (issue) => `${issue} was marked done`,
  issue_status_cancelled: (issue) => `${issue} was cancelled`,
  issue_comment_interrupt: () => "a new comment interrupted it",
};

function formatHeartbeatCancelledPhrase(details: ActivityDetails, options: ActivityFormatOptions): string {
  const agentId = typeof details?.agentId === "string" ? details.agentId : null;
  const agentName = (agentId ? options.agentMap?.get(agentId)?.name : null) ?? "the agent";
  const source = typeof details?.source === "string" ? details.source : null;
  // AgentDash (review-1015): name the issue when the audit carries its
  // identifier — "ACM-3 was marked done" beats "the issue was marked done".
  const issue = typeof details?.identifier === "string" && details.identifier ? details.identifier : "the issue";
  const reason = source ? (HEARTBEAT_CANCEL_REASONS[source]?.(issue) ?? humanizeValue(source)) : null;
  return `stopped ${agentName === "the agent" ? "the agent's" : `${agentName}'s`} run${reason ? ` — ${reason}` : ""}`;
}

/** "product-description" -> "product description": document keys are slugs, not words. */
function humanizeDocumentKey(key: string): string {
  return key.replace(/[-_]+/g, " ");
}

/**
 * AgentDash (c3 copy): every deliverable transition the server logs as a
 * work_product_updated reason reads as what happened — "updated a
 * deliverable" hid accepts, change requests, resubmissions, and reopens.
 * The humanised document key names the deliverable when it is not the
 * generic one.
 */
const WORK_PRODUCT_UPDATE_PHRASES: Record<string, (target: string) => string> = {
  issue_accepted: (target) => `accepted ${target}`,
  changes_requested: (target) => `requested changes to ${target}`,
  resubmitted_for_review: (target) => `resubmitted ${target} for review`,
  issue_reopened: (target) => `reopened ${target}`,
};

function formatWorkProductUpdatePhrase(details: ActivityDetails): string | null {
  const reason = typeof details?.reason === "string" ? details.reason : null;
  const phrase = reason ? WORK_PRODUCT_UPDATE_PHRASES[reason] : undefined;
  if (!phrase) return null;
  const key = typeof details?.documentKey === "string" && details.documentKey && details.documentKey !== "deliverable"
    ? details.documentKey
    : null;
  return phrase(key ? `the ${humanizeDocumentKey(key)}` : "the deliverable");
}

/**
 * AgentDash (c4 trust): approval rows carried "requested approval" /
 * "rejected" with no object — "Yang rejected" told the owner nothing. The
 * approval's `type` names what was decided.
 */
const APPROVAL_TYPE_OBJECTS: Record<string, string> = {
  hire_agent: "an agent hire",
  approve_ceo_strategy: "a strategy proposal",
  budget_override_required: "a budget override",
  request_board_approval: "a request",
  mandate_violation: "a flagged mandate violation",
  connector_send: "a send request",
  inbound_content_review: "held inbound content",
  deliverable_review: "a deliverable review",
  workflow_recommendation: "a workflow suggestion",
  verdict_escalation: "a verdict escalation",
  governance_push: "a governance change",
};

function approvalObject(details: ActivityDetails): string {
  const type = typeof details?.type === "string" ? details.type : null;
  return (type && APPROVAL_TYPE_OBJECTS[type]) ?? (type ? `a ${humanizeValue(type)} request` : "an approval request");
}

const APPROVAL_ACTION_VERBS: Record<string, (object: string) => string> = {
  "approval.created": (object) => `requested approval for ${object}`,
  "approval.approved": (object) => `approved ${object}`,
  "approval.rejected": (object) => `rejected ${object}`,
  "approval.revision_requested": (object) => `asked for changes on ${object}`,
  "approval.resubmitted": (object) => `resubmitted ${object} for approval`,
  "approval.emergency_override": (object) => `used an emergency override on ${object}`,
};

/**
 * AgentDash (c4 trust): "updated company" said nothing; the update body is in
 * the row's details, so name what actually changed.
 */
const COMPANY_UPDATE_FIELD_LABELS: Record<string, string> = {
  name: "renamed the company",
  description: "updated the company description",
  status: "changed the company status",
  brandColor: "changed the brand color",
  logoAssetId: "changed the company logo",
  requireBoardApprovalForNewAgents: "changed the hire-approval rule",
  newIssuesStartAsTodo: "changed the default status for new issues",
  agentVisibilityDefault: "changed the default agent visibility",
  feedbackDataSharingEnabled: "changed the feedback data-sharing setting",
  attachmentMaxBytes: "changed the attachment size limit",
  budgetMonthlyCents: "updated the company budget",
  spentMonthlyCents: "updated the company's recorded spend",
};

function formatCompanyUpdatedVerb(details: ActivityDetails): string {
  if (!details) return "updated company settings";
  // Consent bookkeeping fields ride along on the setting change; skip them
  // when naming what the owner did.
  const skip = new Set(["feedbackDataSharingConsentAt", "feedbackDataSharingConsentByUserId", "feedbackDataSharingTermsVersion"]);
  const labels = Object.keys(details)
    .filter((key) => !skip.has(key) && details[key] !== undefined)
    .map((key) => COMPANY_UPDATE_FIELD_LABELS[key])
    .filter((label): label is string => Boolean(label));
  if (labels.length === 1) return labels[0]!;
  if (labels.length > 1) return "updated company settings";
  return "updated the company";
}

function formatInviteCreatedVerb(details: ActivityDetails): string {
  const inviteType = typeof details?.inviteType === "string" ? details.inviteType : null;
  if (inviteType === "agent") return "created an agent invite";
  const role = typeof details?.humanRole === "string" ? details.humanRole : null;
  return role ? `created a ${humanizeValue(role)} invite` : "created an invite";
}

function formatJoinVerb(action: string, details: ActivityDetails): string {
  const requestType = typeof details?.requestType === "string" ? details.requestType : null;
  const who = requestType === "agent" ? "an agent's join request" : "a join request";
  if (action === "join.approved") return `approved ${who}`;
  if (action === "join.rejected") return `rejected ${who}`;
  return `auto-approved ${who}`;
}

function formatStewardshipVerb(action: string, details: ActivityDetails, options: ActivityFormatOptions): string {
  const agentId = typeof details?.agentId === "string" ? details.agentId : null;
  const agentName = agentId ? options.agentMap?.get(agentId)?.name ?? "the agent" : "the agent";
  if (action === "agent.stewardship_transferred") {
    const to = formatUserLabel(typeof details?.toUserId === "string" ? details.toUserId : null, options);
    return `transferred stewardship of ${agentName} to ${to}`;
  }
  const user = formatUserLabel(typeof details?.userId === "string" ? details.userId : null, options);
  return action === "agent.stewardship_assigned"
    ? `made ${user} the steward of ${agentName}`
    : `ended ${user}'s stewardship of ${agentName}`;
}

function formatDetailAwareVerb(
  action: string,
  details: ActivityDetails,
  options: ActivityFormatOptions,
): string | null {
  const approvalVerb = APPROVAL_ACTION_VERBS[action];
  if (approvalVerb) return approvalVerb(approvalObject(details));
  if (action === "company.updated") return formatCompanyUpdatedVerb(details);
  if (action === "invite.created") return formatInviteCreatedVerb(details);
  if (action === "join.approved" || action === "join.rejected" || action === "join.auto_approved") {
    return formatJoinVerb(action, details);
  }
  if (action === "agent.stewardship_assigned" || action === "agent.stewardship_transferred" || action === "agent.stewardship_ended") {
    return formatStewardshipVerb(action, details, options);
  }
  return null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;

  if (input.action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", added);
      return input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", removed);
      return input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return input.forIssueDetail ? "updated blockers" : "updated blockers on";
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? "reviewer" : "approver";
    const plural = input.action === "issue.reviewers_updated" ? "reviewers" : "approvers";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return input.forIssueDetail ? `updated ${plural}` : `updated ${plural} on`;
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  if (action === "heartbeat.cancelled") {
    return formatHeartbeatCancelledPhrase(details, options);
  }

  if (action === "issue.work_product_updated") {
    const phrase = formatWorkProductUpdatePhrase(details);
    if (phrase) return `${phrase} on`;
  }

  const detailAware = formatDetailAwareVerb(action, details, options);
  if (detailAware) return detailAware;

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  return ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details, options);
    if (issueUpdatedAction) return issueUpdatedAction;
  }

  if (action === "heartbeat.cancelled") {
    return formatHeartbeatCancelledPhrase(details, options);
  }

  if (action === "issue.work_product_updated") {
    const phrase = formatWorkProductUpdatePhrase(details);
    if (phrase) return phrase;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
  });
  if (structuredChange) return structuredChange;

  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted") &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ISSUE_ACTIVITY_LABELS[action] ?? action} ${key}${title}`;
  }

  return ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
