// AgentDash: shared canonical issue-question continuation; no alternate executor.
import type { heartbeatService } from "./heartbeat.js";
import { DELIBERATE_PERSON_WAKE_REASONS } from "./run-facts.js";
/**
 * Whether a resolved interaction's continuation policy wakes the issue's
 * assignee. One rule for every answer path (web, inbox, send-back).
 */
export function continuationWakesAssignee(interaction: { continuationPolicy: string; status: string }) {
  if (interaction.status === "expired") return false;
  if (interaction.continuationPolicy === "wake_assignee") return true;
  return interaction.continuationPolicy === "wake_assignee_on_accept" && interaction.status === "accepted";
}

/** The wake reason of a resolved interaction's continuation, by who resolved it. */
export function interactionContinuationWakeReason(actorType: "user" | "agent") {
  return actorType === "user" ? DELIBERATE_PERSON_WAKE_REASONS.interactionResolved : "issue_commented";
}

export function dispatchResolvedInteractionContinuation(input: {
  heartbeat: Pick<ReturnType<typeof heartbeatService>, "wakeup">;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
  };
  actor: { actorType: "user" | "agent"; actorId: string };
  source: string;
}) {
  if (!continuationWakesAssignee(input.interaction)) return;
  if (!input.issue.assigneeAgentId || ["done", "cancelled"].includes(input.issue.status)) return;
  // A person resolving what the agent asked them is a wake they aimed at the
  // agent, not a comment: the daily token ceiling must not pause it. An agent
  // resolving another agent's interaction stays a comment wake.
  const wakeReason = interactionContinuationWakeReason(input.actor.actorType);

  return input.heartbeat.wakeup(input.issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: wakeReason,
    payload: {
      issueId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      mutation: "interaction",
    },
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      wakeReason,
      source: input.source,
    },
  });
}
