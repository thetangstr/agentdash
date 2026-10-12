// AgentDash: shared canonical issue-question continuation; no alternate executor.
import type { heartbeatService } from "./heartbeat.js";
/**
 * Whether a resolved interaction's continuation policy wakes the issue's
 * assignee. One rule for every answer path (web, inbox, send-back).
 */
export function continuationWakesAssignee(interaction: { continuationPolicy: string; status: string }) {
  if (interaction.status === "expired") return false;
  if (interaction.continuationPolicy === "wake_assignee") return true;
  return interaction.continuationPolicy === "wake_assignee_on_accept" && interaction.status === "accepted";
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

  return input.heartbeat.wakeup(input.issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
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
      wakeReason: "issue_commented",
      source: input.source,
    },
  });
}
