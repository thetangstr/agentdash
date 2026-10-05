// AgentDash: canonical PATCH acceptance. Plans are private and confer no authority.
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { companies, heartbeatRuns, issues, issueExecutionDecisions, issueThreadInteractions, issueWorkProducts, type Db } from "@paperclipai/db";
import { extractIssueReferenceMatches, preserveIssueRecoveryBudget, updateIssueRouteSchema } from "@paperclipai/shared";
import { z } from "zod";
import { conflict, notFound, HttpError } from "../errors.js";
import { issueService } from "./issues.js";
import { issueReferenceService } from "./issue-references.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { routineService } from "./routines.js";
import { agentService } from "./agents.js";
import { dodGuardService } from "./dod-guard.js";
import { featureFlagsService } from "./feature-flags.js";
import { resolveAgentClosingStatus } from "./issue-blocked-declaration.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { insertActivity, publishActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";
import { issueDocumentKey, listIssueDocumentsByKey, resubmitSentBackDeliverables, workProductDocumentKey } from "./work-products.js";
import {
  digestIssueIntentFacts, IssueCommentPolicyRefusal, selectActiveIssueRun, isClosedIssueStatus, shouldImplicitlyMoveCommentedIssueToTodo,
  summarizeIssueReferenceActivityDetails, summarizeIssueRelationForActivity, type IssueCommentExecutor, type IssueCommentContext
} from "./issue-mutation-actions.js";
import type { heartbeatService } from "./heartbeat.js";

// The route schema is shared so the API contract can name it; re-exported for existing importers.
export { updateIssueRouteSchema };
type Issue = typeof issues.$inferSelect;
type Intent = z.infer<typeof updateIssueRouteSchema>;
type Runtime = Pick<ReturnType<typeof heartbeatService>, "cancelRun" | "wakeup" | "reportRunActivity">;
export type IssuePatchSnapshot = {
  version: number; companyId: string; issueId: string; intentDigest: string; stateDigest: string; policyDigest: string;
  interruptRunId: string | null; statusCancelRunIds: string[]; mentionedIds: string[]; confirmationIds: string[]; blockedByIds: string[]
};
export interface IssuePatchContext extends Omit<IssueCommentContext, "intent" | "validate" | "expectedSnapshot"> {
  intent: Intent;
  decisionId?: string;
  // Private planner provenance: the same normalized ID is never re-resolved
  // from a reused name at confirmation. It grants no assignment authority.
  resolvedAssigneeAgentId?: string | null;
  expectedSnapshot?: IssuePatchSnapshot;
  validate(executor: IssueCommentExecutor, issue: Issue, intent: Intent): Promise<void>;
  validateResume(executor: IssueCommentExecutor, issue: Issue): Promise<void>;
  validateAssignment(executor: IssueCommentExecutor, issue: Issue): Promise<void>;
  // AgentDash (GH #830 A5 follow-up): blockedByIssueIds replaces the whole
  // set, but an off-list actor never sees blockers in a restricted project.
  // Returns the current blocker ids the actor cannot see; they are kept.
  retainHiddenBlockerIds?(executor: IssueCommentExecutor, companyId: string, blockerIds: string[]): Promise<string[]>;
  // AgentDash (MVP launch lane B): the request actor's source. An
  // `assistant_grant` board actor is a client acting for the person, so its
  // move to done does not accept deliverables on the person's behalf.
  actorSource?: string;
  // AgentDash (Scan 3 lane I): POST /issues/:id/request-changes. In the same
  // transaction as the comment and status change, the work products that were
  // waiting for review are recorded as sent back.
  requestChanges?: boolean;
}
export class IssuePatchAcceptanceUncertain extends IssueCommentPolicyRefusal {
  constructor(readonly recovery: { mutationId: string; companyId: string; issueId: string; commentId: string | null; decisionId: string | null }) {
    super(500, { error: "Issue update acceptance is uncertain. Read the issue before retrying." });
  }
}
type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;
type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeIssueExecutionPolicy>>;
type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;
type ExecutionStageWakeContext = {
  wakeRole: "reviewer" | "approver" | "executor";
  stageId: string | null;
  stageType: ParsedExecutionState["currentStageType"];
  currentParticipant: ParsedExecutionState["currentParticipant"];
  returnAssignee: ParsedExecutionState["returnAssignee"];
  reviewRequest: ParsedExecutionState["reviewRequest"];
  lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"];
  allowedActions: string[];
};

function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent" ? left.agentId === right.agentId : left.userId === right.userId;
}

function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

function activityExecutionParticipantKey(participant: ActivityExecutionParticipant): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

function summarizeExecutionParticipants(
  policy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
): ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

function diffExecutionParticipants(
  previousPolicy: NormalizedExecutionPolicy | null,
  nextPolicy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(previousParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));
  const nextByKey = new Map(nextParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter((participant) => !previousByKey.has(activityExecutionParticipantKey(participant))),
    removedParticipants: previousParticipants.filter((participant) => !nextByKey.has(activityExecutionParticipantKey(participant))),
  };
}

function buildExecutionStageWakeup(input: {
  issueId: string;
  previousState: ParsedExecutionState | null;
  nextState: ParsedExecutionState | null;
  interruptedRunId: string | null;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
}) {
  const { issueId, previousState, nextState, interruptedRunId } = input;
  if (!nextState) return null;

  if (nextState.status === "pending") {
    const agentId =
      nextState.currentParticipant?.type === "agent" ? (nextState.currentParticipant.agentId ?? null) : null;
    const stageChanged =
      previousState?.status !== "pending" ||
      previousState?.currentStageId !== nextState.currentStageId ||
      !executionPrincipalsEqual(previousState?.currentParticipant ?? null, nextState.currentParticipant ?? null);
    if (!agentId || !stageChanged) return null;

    const reason =
      nextState.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: nextState.currentStageType === "approval" ? "approver" : "reviewer",
      allowedActions: ["approve", "request_changes"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason,
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: reason,
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  if (nextState.status === "changes_requested") {
    const agentId = nextState.returnAssignee?.type === "agent" ? (nextState.returnAssignee.agentId ?? null) : null;
    const becameChangesRequested =
      previousState?.status !== "changes_requested" ||
      previousState?.lastDecisionId !== nextState.lastDecisionId ||
      !executionPrincipalsEqual(previousState?.returnAssignee ?? null, nextState.returnAssignee ?? null);
    if (!agentId || !becameChangesRequested) return null;

    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: "executor",
      allowedActions: ["address_changes", "resubmit"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_changes_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  return null;
}

// Reference persistence consumes the identifier/first matched spelling, not
// character offsets, surrounding prose or the order of distinct references.
function retainedReferenceFacts(text: string | null) {
  return extractIssueReferenceMatches(text ?? "")
    .map(({ identifier, matchedText }) => ({ identifier, matchedText }))
    .sort((left, right) => left.identifier.localeCompare(right.identifier));
}

// AgentDash (batch 2 review lane): document/revision helpers and the
// resubmission flip live in work-products.ts so the run-finish path can reuse
// them (see resubmitSentBackDeliverablesAfterRunFinished).

// AgentDash (batch 2 review lane): every queued, scheduled or running run that
// was woken for this issue — not only the active one — so a queued wake cannot
// start after the issue is already done or cancelled. The calling run is
// excluded: it is finishing the transition it just made.
async function selectIssueRunsForClose(
  executor: IssueCommentExecutor,
  issue: Pick<Issue, "id" | "companyId" | "executionRunId" | "checkoutRunId">,
  actorRunId: string | null,
) {
  return executor
    .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      or(
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}`,
        issue.executionRunId ? eq(heartbeatRuns.id, issue.executionRunId) : undefined,
        issue.checkoutRunId ? eq(heartbeatRuns.id, issue.checkoutRunId) : undefined,
      ),
      actorRunId ? sql`${heartbeatRuns.id} <> ${actorRunId}` : undefined,
    ));
}

export function issuePatchActions(db: Db, heartbeat: Runtime, hooks: {
  statusChanged?(issueId: string, before: string, after: string): Promise<unknown>;
  completed?(agentId: string): Promise<unknown>;
} = {}) {
  const svc = issueService(db);
  const issueReferencesSvc = issueReferenceService(db);
  const routinesSvc = routineService(db);
  async function normalize(context: IssuePatchContext, executor: IssueCommentExecutor = db): Promise<IssuePatchContext> {
    const intent = updateIssueRouteSchema.parse(context.intent);
    if (typeof intent.assigneeAgentId === "string" && intent.assigneeAgentId.trim() && context.resolvedAssigneeAgentId !== intent.assigneeAgentId) {
      const resolved = await agentService(executor as Db).resolveByReference(context.companyId, intent.assigneeAgentId.trim());
      if (resolved.ambiguous) throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
      if (!resolved.agent) throw notFound("Agent not found");
      intent.assigneeAgentId = resolved.agent.id;
    }
    if (intent.executionPolicy !== undefined) intent.executionPolicy = normalizeIssueExecutionPolicy(intent.executionPolicy);
    return { ...context, intent, resolvedAssigneeAgentId: intent.assigneeAgentId, decisionId: context.decisionId ?? randomUUID() };
  }
  async function prepare(context: IssuePatchContext, executor: IssueCommentExecutor = db, beforePolicy?: (issue: Issue) => Promise<void>) {
    let intent = updateIssueRouteSchema.parse(context.intent);
    const [existing] = await executor.select().from(issues).where(and(eq(issues.id, context.issueId), eq(issues.companyId, context.companyId)));
    if (!existing) throw notFound("Issue not found");
    if (intent.resume && !intent.comment) throw new IssueCommentPolicyRefusal(400, { error: "Follow-up intent requires a comment" });
    if (intent.interrupt && !intent.comment) throw new IssueCommentPolicyRefusal(400, { error: "Interrupt is only supported when posting a comment" });
    if (intent.interrupt && context.actorKind !== "board") throw new IssueCommentPolicyRefusal(403, { error: "Only board users can interrupt active runs from issue comments" });
    // AgentDash: guard this newly selected source before any policy callback
    // can include protected workspace facts in a refusal.
    await beforePolicy?.(existing);
    await context.validate(executor, existing, intent);
    context = await normalize(context, executor);
    intent = context.intent;
    const reads = issueService(executor as Db);
    const actor = context.actor;
    const isClosed = isClosedIssueStatus(existing.status);
    const isBlocked = existing.status === "blocked";
    const normalizedAssigneeAgentId = intent.assigneeAgentId;
    const titleOrDescriptionChanged = intent.title !== undefined || intent.description !== undefined;
    const existingRelations =
      Array.isArray(intent.blockedByIssueIds)
        ? await reads.getRelationSummaries(existing.id)
        : null;
    if (existingRelations && context.retainHiddenBlockerIds && Array.isArray(intent.blockedByIssueIds)
      && existingRelations.blockedBy.length > 0) {
      const hidden = await context.retainHiddenBlockerIds(executor, existing.companyId, existingRelations.blockedBy.map((relation) => relation.id));
      if (hidden.length > 0) intent = { ...intent, blockedByIssueIds: [...new Set([...intent.blockedByIssueIds, ...hidden])] };
    }
    const {
      comment: commentBody,
      reviewRequest,
      reopen: reopenRequested,
      resume: resumeRequested,
      interrupt: _interruptRequested,
      hiddenAt: hiddenAtRaw,
      acceptedDocumentRevisions: _acceptedDocumentRevisions,
      ...rawUpdateFields
    } = intent;
    const updateFields: Parameters<typeof svc.update>[1] = { ...rawUpdateFields };
    if (resumeRequested === true) await context.validateResume(executor, existing);
    if (resumeRequested !== true && reopenRequested === true && context.actorKind === "agent") {
      await context.validateResume(executor, existing);
    }

    const requestedAssigneeAgentId =
      normalizedAssigneeAgentId === undefined ? existing.assigneeAgentId : normalizedAssigneeAgentId;
    const explicitMoveToTodoRequested = reopenRequested || resumeRequested === true;
    const effectiveMoveToTodoRequested =
      explicitMoveToTodoRequested ||
      (!!commentBody &&
        shouldImplicitlyMoveCommentedIssueToTodo({
          issueStatus: existing.status,
          assigneeAgentId: requestedAssigneeAgentId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          assigneeChangedToAgent:
            requestedAssigneeAgentId !== null && requestedAssigneeAgentId !== existing.assigneeAgentId,
        }));
    const updateReferenceSummaryBefore = titleOrDescriptionChanged
      ? await issueReferencesSvc.listIssueReferenceSummary(existing.id, executor)
      : null;
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(existing.id, executor)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      throw new IssueCommentPolicyRefusal(409, { error: "Issue follow-up blocked by unresolved blockers" });
    }
    const interruptRun = intent.interrupt ? await selectActiveIssueRun(executor, existing) : null;

    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (
      commentBody &&
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers)) &&
      updateFields.status === undefined
    ) {
      updateFields.status = "todo";
    }
    if (intent.executionPolicy !== undefined) {
      updateFields.executionPolicy = intent.executionPolicy ? { ...intent.executionPolicy } : null;
    }
    const previousExecutionPolicy = normalizeIssueExecutionPolicy(existing.executionPolicy ?? null);
    const nextExecutionPolicy =
      updateFields.executionPolicy !== undefined
        ? (updateFields.executionPolicy as NormalizedExecutionPolicy | null)
        : previousExecutionPolicy;
    if (normalizedAssigneeAgentId !== undefined) {
      updateFields.assigneeAgentId = normalizedAssigneeAgentId;
    }

    // An agent that just said "BLOCKED" does not get to also say "done".
    //
    // The two arrive as separate calls — comment, then status — so the comment
    // has to be read back rather than taken from this request. Only an agent
    // closing an issue is checked; a person closing one an agent called blocked
    // is overruling it knowingly, which is theirs to do.
    if (actor.actorType === "agent" && actor.agentId && updateFields.status === "done") {
      // Partial injected services may omit this method. Production reads the
      // latest own comment on the actual executor; a read failure must refuse.
      const latestOwnCommentBody =
        typeof reads.latestAgentCommentBody === "function"
          ? await reads.latestAgentCommentBody(existing.id, actor.agentId)
          : null;
      const resolved = resolveAgentClosingStatus({
        actorIsAgent: true,
        requestedStatus: "done",
        commentBody,
        latestOwnCommentBody,
      });
      if (resolved.overridden) {
        updateFields.status = "blocked";
      }
    }

    const transition = applyIssueExecutionPolicyTransition({
      issue: existing,
      policy: nextExecutionPolicy,
      requestedStatus: typeof updateFields.status === "string" ? updateFields.status : undefined,
      requestedAssigneePatch: {
        assigneeAgentId: normalizedAssigneeAgentId,
        assigneeUserId:
          intent.assigneeUserId === undefined ? undefined : (intent.assigneeUserId as string | null),
      },
      actor: {
        agentId: actor.agentId ?? null,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
      commentBody,
      reviewRequest: reviewRequest === undefined ? undefined : reviewRequest,
    });
    const decisionId = transition.decision ? context.decisionId : null;
    if (decisionId) {
      const nextExecutionState = transition.patch.executionState;
      if (!nextExecutionState || typeof nextExecutionState !== "object") {
        throw new Error("Execution policy decision patch is missing executionState");
      }
      transition.patch.executionState = {
        ...nextExecutionState,
        lastDecisionId: decisionId,
      };
    }
    Object.assign(updateFields, transition.patch);
    // AgentDash (batch 2 review lane): computed on the final target status, so
    // both done and cancelled stop every queued, scheduled or running run that
    // was woken for this issue — not just the one currently active.
    const runsToCancelForClosedStatus =
      ["done", "cancelled"].includes(String(updateFields.status)) && existing.status !== updateFields.status
        ? await selectIssueRunsForClose(executor, existing, actor.runId ?? null)
        : [];
    if (reviewRequest !== undefined && transition.patch.executionState === undefined) {
      const existingExecutionState = parseIssueExecutionState(existing.executionState);
      if (!existingExecutionState || existingExecutionState.status !== "pending") {
        if (reviewRequest !== null) {
          throw new IssueCommentPolicyRefusal(422, { error: "reviewRequest requires an active review or approval stage" });
        }
      } else {
        // AgentDash (recovery budget, explicit clear): the parsed stage state
        // drops unknown keys; keep an exhausted recovery marker.
        updateFields.executionState = preserveIssueRecoveryBudget(existing.executionState, {
          ...existingExecutionState,
          reviewRequest,
        });
      }
    }

    const nextAssigneeAgentId =
      updateFields.assigneeAgentId === undefined ? existing.assigneeAgentId : (updateFields.assigneeAgentId as string | null);
    const nextAssigneeUserId =
      updateFields.assigneeUserId === undefined ? existing.assigneeUserId : (updateFields.assigneeUserId as string | null);
    const assigneeWillChange =
      nextAssigneeAgentId !== existing.assigneeAgentId || nextAssigneeUserId !== existing.assigneeUserId;
    const isAgentReturningIssueToCreator =
      context.actorKind === "agent" &&
      !!actor.agentId &&
      existing.assigneeAgentId === actor.agentId &&
      nextAssigneeAgentId === null &&
      typeof nextAssigneeUserId === "string" &&
      !!existing.createdByUserId &&
      nextAssigneeUserId === existing.createdByUserId;

    if (assigneeWillChange && !transition.workflowControlledAssignment) {
      if (!isAgentReturningIssueToCreator) {
        await context.validateAssignment(executor, existing);
      }
    }

    // AgentDash: goals-eval-hitl
    // DoD guard: when leaving `backlog`, require Issue.definitionOfDone
    // (gated per-tenant by feature_flags.dod_guard_enabled).
    if (
      typeof updateFields.status === "string" &&
      existing.status === "backlog" &&
      updateFields.status !== "backlog"
    ) {
      try {
        await dodGuardService(executor as Db, featureFlagsService(executor as Db)).assertDoDOrThrow(
          existing.companyId,
          "issue",
          existing.id,
          updateFields.status,
          existing.status,
        );
      } catch (err) {
        if (err instanceof HttpError && err.status === 422) {
          throw new IssueCommentPolicyRefusal(422, {
            error: err.message,
            ...(err.details && typeof err.details === "object" ? err.details : {}),
          });
        }
        throw err;
      }
    }

    // Resolve exactly the canonical domain update, using SELECT-only reads on
    // this executor, before snapshot comparison or any checkout application.
    const domain = await svc.prepareUpdate(existing.id, updateFields, executor);
    const checkout = actor.actorType === "agent" && existing.status === "in_progress" && existing.assigneeAgentId === actor.agentId
      ? await svc.evaluateCheckoutOwner(existing.id, actor.agentId!, actor.runId!, executor) : null;
    const mentionedIds = commentBody ? await reads.findMentionedAgents(existing.companyId, commentBody) : [];
    const confirmations = commentBody && actor.actorType === "user"
      ? await executor.select({ id: issueThreadInteractions.id, payload: issueThreadInteractions.payload }).from(issueThreadInteractions)
        .where(and(eq(issueThreadInteractions.issueId, existing.id), eq(issueThreadInteractions.kind, "request_confirmation"), eq(issueThreadInteractions.status, "pending"))) : [];
    const confirmationIds = confirmations.filter(row => "supersedeOnUserComment" in row.payload && row.payload.supersedeOnUserComment).map(row => row.id).sort();
    const snapshot = {
      version: 1, companyId: existing.companyId, issueId: existing.id,
      intentDigest: digestIssueIntentFacts(intent),
      stateDigest: digestIssueIntentFacts({
        // Previous values of submitted/derived fields determine audit and lost-edit intent.
        previous: Object.fromEntries(Object.keys(updateFields).filter(key => key in existing)
          .map(key => [key, existing[key as keyof Issue]])),
        // Field-only board edits do not depend on unrelated status/assignment.
        // Request guards and transition/comment effects re-evaluate on every prepare.
        ...(commentBody || updateFields.status !== undefined || actor.actorType === "agent" ? { status: existing.status } : {}),
        ...(commentBody || updateFields.status !== undefined || actor.actorType === "agent" ||
          updateFields.assigneeAgentId !== undefined || updateFields.assigneeUserId !== undefined ? {
          assigneeAgentId: existing.assigneeAgentId, assigneeUserId: existing.assigneeUserId,
        } : {}),
        ...(assigneeWillChange && context.actorKind === "agent" ? { createdByUserId: existing.createdByUserId } : {}),
        // Workspace IDs select canonical domain/request guards. Settings matter only
        // when submitted (above), or when an execution workspace config is propagated.
        projectWorkspaceId: existing.projectWorkspaceId, executionWorkspaceId: existing.executionWorkspaceId,
        ...(existing.projectWorkspaceId || existing.executionWorkspaceId ? { projectId: existing.projectId } : {}),
        ...(domain.patch.executionWorkspaceSettings !== undefined ? {
          executionWorkspacePreference: existing.executionWorkspacePreference,
        } : {}),
        ...(updateFields.status !== undefined ? {
          ...(["done", "cancelled"].includes(String(updateFields.status)) ? { parentId: existing.parentId } : {}),
          ...(updateFields.status === existing.status && ["done", "cancelled", "in_progress"].includes(updateFields.status) ? {
            statusTimestampPresent: Boolean(updateFields.status === "done" ? existing.completedAt :
              updateFields.status === "cancelled" ? existing.cancelledAt : existing.startedAt),
          } : {}),
        } : {}),
        ...(existing.originKind === "routine_execution" && ["done", "blocked", "cancelled"].includes(domain.patch.status ?? existing.status)
          ? { routineRunId: existing.originRunId, routineStatus: domain.patch.status ?? existing.status } : {}),
        ...(assigneeWillChange || (updateFields.status !== undefined && updateFields.status !== "in_progress") ? {
          checkoutRunId: existing.checkoutRunId, executionRunId: existing.executionRunId,
        } : {}),
        // syncIssue reads both text sources. Pin reference matches in the untouched
        // source, not unrelated prose or incoming reference/source row contents.
        ...(titleOrDescriptionChanged ? {
          retainedTitleReferences: intent.title === undefined ? retainedReferenceFacts(existing.title) : undefined,
          retainedDescriptionReferences: intent.description === undefined ? retainedReferenceFacts(existing.description) : undefined,
        } : {}),
      }),
      policyDigest: digestIssueIntentFacts({
        updateFields, domainPatch: domain.patch, transition, checkout, hasUnresolvedFirstClassBlockers,
        // Pin workflow effects, not unrelated stages or arbitrary stored state.
        executionStageWakeup: buildExecutionStageWakeup({
          issueId: existing.id, previousState: parseIssueExecutionState(existing.executionState),
          nextState: parseIssueExecutionState(updateFields.executionState === undefined ? existing.executionState : updateFields.executionState),
          interruptedRunId: interruptRun?.id ?? null,
          requestedByActorType: actor.actorType, requestedByActorId: actor.actorId,
        }),
        // The audit diff consumes outbound IDs/labels only; inbound rows, status,
        // priority, mention counts and source text are unrelated dependencies.
        referencedBefore: updateReferenceSummaryBefore?.outbound
          .map(row => summarizeIssueRelationForActivity(row.issue)).sort((a, b) => a.id.localeCompare(b.id)),
      }),
      interruptRunId: interruptRun?.id ?? null,
      statusCancelRunIds: runsToCancelForClosedStatus.map((run) => run.id).sort(),
      mentionedIds: [...mentionedIds].sort(), confirmationIds,
      blockedByIds: existingRelations?.blockedBy.map(row => row.id).sort() ?? [],
    };
    if (context.expectedSnapshot && JSON.stringify(context.expectedSnapshot) !== JSON.stringify(snapshot)) throw conflict("Issue changed since update preparation");
    return {
      context, existing, intent, snapshot, domain, updateFields, transition, decisionId, checkout, interruptRun, runsToCancelForClosedStatus,
      mentionedIds, titleOrDescriptionChanged, existingRelations, updateReferenceSummaryBefore, commentBody, resumeRequested,
      effectiveMoveToTodoRequested, isClosed, isBlocked, hasUnresolvedFirstClassBlockers, previousExecutionPolicy, nextExecutionPolicy
    };
  }
  async function accept(context: IssuePatchContext) {
    const mutationId = randomUUID();
    const publications: ActivityPublication[] = [];
    let readyToCommit = false;
    let commentId: string | null = null;
    let acceptedDecisionId: string | null = null;
    try {
      return await db.transaction(async tx => {
        const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, context.companyId)).for("no key update");
        if (!company) throw notFound("Issue not found");
        const [preflight] = await tx.select().from(issues).where(and(eq(issues.id, context.issueId), eq(issues.companyId, company.id)));
        if (!preflight) throw notFound("Issue not found");
        const finalAuthorityGuard = await context.stageAuthority?.(tx, preflight, async beforePolicy => (await prepare(context, tx, beforePolicy)).domain.patch);
        await svc.lockBlockerIssues(context.issueId, company.id, [...(context.intent.blockedByIssueIds ?? []), ...(context.intent.parentId ? [context.intent.parentId] : [])], tx);
        const [target] = await tx.select().from(issues).where(and(eq(issues.id, context.issueId), eq(issues.companyId, context.companyId))).for("update");
        if (!target) throw notFound("Issue not found");
        finalAuthorityGuard?.validateIssue(target);
        const plan = await prepare(context, tx);
        const { existing, intent, updateFields, transition, decisionId, titleOrDescriptionChanged, existingRelations,
          updateReferenceSummaryBefore, commentBody, resumeRequested, effectiveMoveToTodoRequested, isClosed, isBlocked,
          hasUnresolvedFirstClassBlockers, previousExecutionPolicy, nextExecutionPolicy } = plan;
        const id = existing.id;
        const actor = context.actor;
        const reads = issueService(tx as unknown as Db);
        const audit = async (input: LogActivityInput) => {
          publications.push(await insertActivity(tx, { ...input, details: { ...input.details, mutationId } }));
        };
        await finalAuthorityGuard?.beforeWrite(existing, plan.domain.patch);
        if (plan.checkout) {
          const ownership = await svc.applyCheckoutOwner(plan.checkout, tx);
          if (ownership.adoptedFromRunId) await audit({
            companyId: company.id, ...actor,
            action: "issue.checkout_lock_adopted", entityType: "issue", entityId: id,
            details: { previousCheckoutRunId: ownership.adoptedFromRunId, checkoutRunId: actor.runId, reason: "stale_checkout_run" }
          });
        }
        const issue = await svc.update(id, {
          ...updateFields, actorAgentId: actor.agentId ?? null,
          actorUserId: actor.actorType === "user" ? actor.actorId : null
        }, tx);
        if (!issue) throw notFound("Issue not found");
        if (transition.decision && decisionId) {
          acceptedDecisionId = decisionId;
          await tx.insert(issueExecutionDecisions).values({
            id: decisionId, companyId: issue.companyId, issueId: id,
            ...transition.decision, actorAgentId: actor.agentId, actorUserId: actor.actorType === "user" ? actor.actorId : null, createdByRunId: actor.runId
          });
        }
        if (titleOrDescriptionChanged) {
          await issueReferencesSvc.syncIssue(issue.id, tx);
        }
        const updateReferenceSummaryAfter = titleOrDescriptionChanged
          ? await issueReferencesSvc.listIssueReferenceSummary(issue.id, tx)
          : null;
        const updateReferenceDiff = updateReferenceSummaryBefore && updateReferenceSummaryAfter
          ? issueReferencesSvc.diffIssueReferenceSummary(updateReferenceSummaryBefore, updateReferenceSummaryAfter)
          : null;
        let issueResponse: typeof issue & {
          blockedBy?: unknown;
          blocks?: unknown;
          relatedWork?: Awaited<ReturnType<typeof issueReferencesSvc.listIssueReferenceSummary>>;
          referencedIssueIdentifiers?: string[];
        } = issue;
        let updatedRelations: Awaited<ReturnType<typeof svc.getRelationSummaries>> | null = null;
        if (issue && Array.isArray(intent.blockedByIssueIds)) {
          updatedRelations = await reads.getRelationSummaries(issue.id);
          issueResponse = {
            ...issue,
            blockedBy: updatedRelations.blockedBy,
            blocks: updatedRelations.blocks,
          };
        }
        await routinesSvc.syncRunStatusForIssue(issue.id, tx);

        // Build activity details with previous values for changed fields
        const previous: Record<string, unknown> = {};
        for (const key of Object.keys(updateFields)) {
          if (key in existing && (existing as Record<string, unknown>)[key] !== (updateFields as Record<string, unknown>)[key]) {
            previous[key] = (existing as Record<string, unknown>)[key];
          }
        }
        if (Array.isArray(intent.blockedByIssueIds)) {
          previous.blockedByIssueIds = existingRelations?.blockedBy.map((relation) => relation.id) ?? [];
        }

        const hasFieldChanges = Object.keys(previous).length > 0;
        const reopened =
          commentBody &&
          effectiveMoveToTodoRequested &&
          (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers)) &&
          previous.status !== undefined &&
          issue.status === "todo";
        const reopenFromStatus = reopened ? existing.status : null;
        await audit({
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            ...updateFields,
            identifier: issue.identifier,
            // AgentDash (GH #678): provenance when the write came via an assistant grant.
            ...context.attribution,
            ...(commentBody ? { source: "comment" } : {}),
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
            ...(plan.interruptRun ? { requestedInterruptRunId: plan.interruptRun.id } : {}),
            ...(plan.runsToCancelForClosedStatus.length > 0
              ? { requestedStatusCancelRunIds: plan.runsToCancelForClosedStatus.map((run) => run.id) }
              : {}),
            _previous: hasFieldChanges ? previous : undefined,
            ...summarizeIssueReferenceActivityDetails(
              updateReferenceDiff
                ? {
                  addedReferencedIssues: updateReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
                  removedReferencedIssues: updateReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
                  currentReferencedIssues: updateReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
                }
                : null,
            ),
          },
        });

        // AgentDash (MVP launch lane B, item 6): a human board user moving
        // the issue to done is the acceptance of what the agent shipped. Its
        // work products still waiting for review are recorded as accepted in
        // the same transaction, so Shipped and Home stop saying "ready for
        // review". Agent-driven transitions and assistant-grant writes (a
        // client acting for the person) are not an acceptance. The marker in
        // metadata.acceptance lets a reopen undo exactly this.
        const humanBoardActor = context.actorKind === "board" && context.actorSource !== "assistant_grant" && actor.actorType === "user";
        if (humanBoardActor && existing.status !== "done" && issue.status === "done") {
          // AgentDash (batch 2 review lane): acceptance binds to the document
          // revision the person saw. The issue row is locked for update here,
          // so a document write cannot slip a newer revision between this read
          // and the commit; if the client sent a revision older than the
          // latest, the whole PATCH is refused with 409.
          const awaiting = await tx
            .select({ id: issueWorkProducts.id, metadata: issueWorkProducts.metadata })
            .from(issueWorkProducts)
            .where(and(
              eq(issueWorkProducts.companyId, issue.companyId),
              eq(issueWorkProducts.issueId, issue.id),
              inArray(issueWorkProducts.status, ["ready_for_review", "changes_requested"]),
            ));
          const docsByKey = await listIssueDocumentsByKey(tx, issue.companyId,
            new Map([[issue.id, awaiting.map((product) => workProductDocumentKey(product.metadata)).filter((key): key is string => !!key)]]));
          const seenRevisions = intent.acceptedDocumentRevisions ?? {};
          for (const product of awaiting) {
            const documentKey = workProductDocumentKey(product.metadata);
            const doc = documentKey ? docsByKey.get(issueDocumentKey(issue.id, documentKey)) : null;
            if (doc) {
              const seenRevision = seenRevisions[documentKey!];
              // AgentDash (review #1003): a missing baseline is not a stale
              // one — it gets its own code and wording so clients (and
              // people) can tell "say what you saw" apart from "it changed".
              if (seenRevision === undefined) {
                throw conflict("Open the issue and review the latest document before marking it done.", {
                  code: "document_revision_required",
                  documentKey,
                  latestRevisionNumber: doc.latestRevisionNumber,
                });
              }
              if (doc.latestRevisionNumber > seenRevision) {
                throw conflict("The document changed after you reviewed it. Read the newest revision before accepting.", {
                  code: "document_revision_stale",
                  documentKey,
                  seenRevisionNumber: seenRevision,
                  latestRevisionNumber: doc.latestRevisionNumber,
                });
              }
            }
            const acceptance = {
              reason: "issue_accepted",
              acceptedAt: new Date().toISOString(),
              acceptedByUserId: actor.actorId,
              ...(doc ? {
                documentKey,
                acceptedRevisionId: doc.latestRevisionId,
                acceptedRevisionNumber: doc.latestRevisionNumber,
              } : {}),
            };
            // AgentDash (Scan 4 lane M): a person closing the issue accepts
            // what was sent back too (they decided to take it as it is);
            // otherwise it stayed changes_requested and never reached Shipped.
            await tx.update(issueWorkProducts)
              .set({
                status: "approved",
                reviewState: "approved",
                metadata: sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || jsonb_build_object('acceptance',
                  ${JSON.stringify(acceptance)}::jsonb || jsonb_build_object('previousReviewState', ${issueWorkProducts.reviewState}, 'previousStatus', ${issueWorkProducts.status}))`,
                updatedAt: new Date(),
              })
              .where(eq(issueWorkProducts.id, product.id));
            await audit({
              companyId: issue.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.work_product_updated",
              entityType: "issue",
              entityId: issue.id,
              details: {
                identifier: issue.identifier,
                workProductId: product.id,
                changedKeys: ["metadata", "reviewState", "status"],
                status: "approved",
                reviewState: "approved",
                reason: "issue_accepted",
                ...(documentKey ? { documentKey } : {}),
                ...(doc ? { acceptedRevisionNumber: doc.latestRevisionNumber } : {}),
                ...context.attribution,
              },
            });
          }
        }
        // Reopening an accepted issue (done to an open status) withdraws that
        // acceptance: work products approved by it go back to waiting for
        // review. Products approved any other way are left alone.
        if (existing.status === "done" && !["done", "cancelled"].includes(issue.status)) {
          const withoutAcceptance = sql`(${issueWorkProducts.metadata} - 'acceptance')`;
          const reopenedProducts = await tx.update(issueWorkProducts)
            .set({
              // AgentDash (Scan 4 lane M): a product accepted while it was
              // changes_requested goes back to changes_requested.
              status: sql`case when ${issueWorkProducts.metadata} -> 'acceptance' ->> 'previousStatus' = 'changes_requested' then 'changes_requested' else 'ready_for_review' end`,
              // Only a review state a product can be waiting in is restored;
              // anything else (e.g. "approved") falls back to needs_board_review.
              reviewState: sql`case when ${issueWorkProducts.metadata} -> 'acceptance' ->> 'previousReviewState' in ('none', 'needs_board_review', 'changes_requested') then ${issueWorkProducts.metadata} -> 'acceptance' ->> 'previousReviewState' else 'needs_board_review' end`,
              metadata: sql`case when ${withoutAcceptance} = '{}'::jsonb then null else ${withoutAcceptance} end`,
              updatedAt: new Date(),
            })
            .where(and(
              eq(issueWorkProducts.companyId, issue.companyId),
              eq(issueWorkProducts.issueId, issue.id),
              eq(issueWorkProducts.status, "approved"),
              sql`${issueWorkProducts.metadata} -> 'acceptance' ->> 'reason' = 'issue_accepted'`,
            ))
            .returning({ id: issueWorkProducts.id, status: issueWorkProducts.status, reviewState: issueWorkProducts.reviewState, metadata: issueWorkProducts.metadata });
          for (const product of reopenedProducts) {
            const documentKey = workProductDocumentKey(product.metadata);
            await audit({
              companyId: issue.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.work_product_updated",
              entityType: "issue",
              entityId: issue.id,
              details: {
                identifier: issue.identifier,
                workProductId: product.id,
                changedKeys: ["metadata", "reviewState", "status"],
                status: product.status,
                reviewState: product.reviewState,
                reason: "issue_reopened",
                ...(documentKey ? { documentKey } : {}),
                ...context.attribution,
              },
            });
          }
        }

        // AgentDash (Scan 3 lane I): request changes. Only products that were
        // waiting for review when the request was made are sent back; the
        // update and its audit rows commit with the comment and status.
        if (context.requestChanges && humanBoardActor) {
          const waitingForReview = await tx
            .select({ id: issueWorkProducts.id, metadata: issueWorkProducts.metadata })
            .from(issueWorkProducts)
            .where(and(
              eq(issueWorkProducts.companyId, issue.companyId),
              eq(issueWorkProducts.issueId, issue.id),
              eq(issueWorkProducts.status, "ready_for_review"),
            ));
          const docsByKey = await listIssueDocumentsByKey(tx, issue.companyId,
            new Map([[issue.id, waitingForReview.map((product) => workProductDocumentKey(product.metadata)).filter((key): key is string => !!key)]]));
          const changesRequestedAt = new Date().toISOString();
          for (const product of waitingForReview) {
            const documentKey = workProductDocumentKey(product.metadata);
            const doc = documentKey ? docsByKey.get(issueDocumentKey(issue.id, documentKey)) : null;
            // AgentDash (batch 2 review lane): the revision the request was
            // made against is the baseline. Resubmission only counts once a
            // strictly newer revision exists (or the run that would write it
            // has finished).
            await tx.update(issueWorkProducts)
              .set({
                status: "changes_requested",
                reviewState: "changes_requested",
                // AgentDash (Scan 4 lane M): marks it as reviewed under the new
                // rule, so the legacy "done means accepted" read never applies.
                // The revision keys are only written when the deliverable is
                // document-bound — no null-valued keys in metadata.
                metadata: doc
                  ? sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || jsonb_build_object(
                      'changesRequestedAt', ${changesRequestedAt}::text,
                      'changesRequestedAtRevision', ${doc.latestRevisionNumber}::int,
                      'changesRequestedRevisionId', ${doc.latestRevisionId}::text)`
                  : sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || jsonb_build_object(
                      'changesRequestedAt', ${changesRequestedAt}::text)`,
                updatedAt: new Date(),
              })
              .where(eq(issueWorkProducts.id, product.id));
          }
          for (const product of waitingForReview) {
            const documentKey = workProductDocumentKey(product.metadata);
            await audit({
              companyId: issue.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.work_product_updated",
              entityType: "issue",
              entityId: issue.id,
              details: {
                identifier: issue.identifier,
                workProductId: product.id,
                changedKeys: ["reviewState", "status"],
                status: "changes_requested",
                reviewState: "changes_requested",
                reason: "changes_requested",
                ...(documentKey ? { documentKey } : {}),
                ...context.attribution,
              },
            });
          }
        }

        // AgentDash (Scan 4 lane M): resubmission. When the issue comes back
        // to in_review (the assignee resubmitting, or anyone else moving it),
        // deliverables that were sent back are waiting for review again, so
        // Accept and Request changes reappear instead of a dead end. This only
        // returns them to ready_for_review; acceptance stays with a person.
        //
        // AgentDash (batch 2 review lane): a document-bound deliverable only
        // comes back when the document has a revision newer than the one the
        // changes request was made against, or when no ASSIGNEE run is live —
        // a queued reviewer or CoS run bound to the issue does not count. The
        // calling run is live too when it is the assignee's: an agent
        // resubmitting mid-run has not finished, so only an already-written
        // revision lets the deliverable back to review. When the run later
        // finishes, resubmitSentBackDeliverablesAfterRunFinished re-runs this
        // same flip — the "or your run has finished" half.
        if (existing.status !== "in_review" && issue.status === "in_review") {
          await resubmitSentBackDeliverables(tx, issue, {
            actor,
            audit,
            callingRunIsLive: true,
            activityDetails: context.attribution,
          });
        }

        if (Array.isArray(intent.blockedByIssueIds)) {
          const previousBlockedByIds = new Set((existingRelations?.blockedBy ?? []).map((relation) => relation.id));
          const nextBlockedByIds = new Set(intent.blockedByIssueIds as string[]);
          const addedBlockedByIssueIds = [...nextBlockedByIds].filter((candidate) => !previousBlockedByIds.has(candidate));
          const removedBlockedByIssueIds = [...previousBlockedByIds].filter((candidate) => !nextBlockedByIds.has(candidate));
          const nextBlockedByRelations = updatedRelations?.blockedBy ?? [];
          const previousBlockedByRelations = existingRelations?.blockedBy ?? [];
          if (addedBlockedByIssueIds.length > 0 || removedBlockedByIssueIds.length > 0) {
            await audit({
              companyId: issue.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.blockers_updated",
              entityType: "issue",
              entityId: issue.id,
              details: {
                identifier: issue.identifier,
                blockedByIssueIds: intent.blockedByIssueIds,
                addedBlockedByIssueIds,
                removedBlockedByIssueIds,
                blockedByIssues: nextBlockedByRelations.map(summarizeIssueRelationForActivity),
                addedBlockedByIssues: nextBlockedByRelations
                  .filter((relation) => addedBlockedByIssueIds.includes(relation.id))
                  .map(summarizeIssueRelationForActivity),
                removedBlockedByIssues: previousBlockedByRelations
                  .filter((relation) => removedBlockedByIssueIds.includes(relation.id))
                  .map(summarizeIssueRelationForActivity),
              },
            });
          }
        }

        const reviewerChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "review");
        if (reviewerChanges.addedParticipants.length > 0 || reviewerChanges.removedParticipants.length > 0) {
          await audit({
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.reviewers_updated",
            entityType: "issue",
            entityId: issue.id,
            details: {
              identifier: issue.identifier,
              participants: reviewerChanges.participants,
              addedParticipants: reviewerChanges.addedParticipants,
              removedParticipants: reviewerChanges.removedParticipants,
            },
          });
        }

        const approverChanges = diffExecutionParticipants(previousExecutionPolicy, nextExecutionPolicy, "approval");
        if (approverChanges.addedParticipants.length > 0 || approverChanges.removedParticipants.length > 0) {
          await audit({
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.approvers_updated",
            entityType: "issue",
            entityId: issue.id,
            details: {
              identifier: issue.identifier,
              participants: approverChanges.participants,
              addedParticipants: approverChanges.addedParticipants,
              removedParticipants: approverChanges.removedParticipants,
            },
          });
        }

        let comment = null;
        if (commentBody) {
          const commentReferenceSummaryBefore = updateReferenceSummaryAfter
            ?? await issueReferencesSvc.listIssueReferenceSummary(issue.id, tx);
          comment = await svc.addComment(id, commentBody, {
            agentId: actor.agentId ?? undefined,
            userId: actor.actorType === "user" ? actor.actorId : undefined,
            runId: actor.runId,
          }, tx);
          await issueReferencesSvc.syncComment(comment.id, tx);
          const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id, tx);
          const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
            commentReferenceSummaryBefore,
            commentReferenceSummaryAfter,
          );
          issueResponse = {
            ...issueResponse,
            relatedWork: commentReferenceSummaryAfter,
            referencedIssueIdentifiers: commentReferenceSummaryAfter.outbound.map(
              (item) => item.issue.identifier ?? item.issue.id,
            ),
          };

          await audit({
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: issue.id,
            details: {
              commentId: comment.id,
              bodySnippet: comment.body.slice(0, 120),
              identifier: issue.identifier,
              issueTitle: issue.title,
              // AgentDash (GH #678): provenance when the write came via an assistant grant.
              ...context.attribution,
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
              ...(plan.interruptRun ? { requestedInterruptRunId: plan.interruptRun.id } : {}),
              ...(hasFieldChanges ? { updated: true } : {}),
              ...summarizeIssueReferenceActivityDetails({
                addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
                removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
                currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
              }),
            },
          });

          const expiredInteractions = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
            issue,
            comment,
            {
              agentId: actor.agentId,
              userId: actor.actorType === "user" ? actor.actorId : null,
            }, tx,
          );
          for (const interaction of expiredInteractions) await audit({
            companyId: issue.companyId, ...actor,
            action: "issue.thread_interaction_expired", entityType: "issue", entityId: issue.id,
            details: {
              identifier: issue.identifier ?? null, interactionId: interaction.id, interactionKind: interaction.kind,
              interactionStatus: interaction.status, source: "issue.comment", result: interaction.result ?? null
            }
          });

        } else if (updateReferenceSummaryAfter) {
          issueResponse = {
            ...issueResponse,
            relatedWork: updateReferenceSummaryAfter,
            referencedIssueIdentifiers: updateReferenceSummaryAfter.outbound.map(
              (item) => item.issue.identifier ?? item.issue.id,
            ),
          };
        }

        commentId = comment?.id ?? null;
        const dependents = existing.status !== "done" && issue.status === "done" ? await reads.listWakeableBlockedDependents(issue.id) : [];
        const parent = !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status) && issue.parentId
          ? await reads.getWakeableParentAfterChildCompletion(issue.parentId) : null;
        readyToCommit = true;
        return { status: "committed" as const, mutationId, publications, plan, actor, issue, comment, issueResponse, reopened, reopenFromStatus, dependents, parent };
      });
    } catch (error) {
      if (readyToCommit) throw new IssuePatchAcceptanceUncertain({
        mutationId, companyId: context.companyId,
        issueId: context.issueId, commentId, decisionId: acceptedDecisionId
      });
      throw error;
    }
  }

  // A process-local receipt prevents accidental repeat dispatch on this exact
  // accepted object. It provides no durable replay or crash recovery guarantee.
  const dispatched = new WeakMap<object, Promise<PatchEffects>>();
  type PatchEffects = {
    unresolved: boolean; status: "confirmed" | "partial" | "unknown";
    outcomes: Array<{ effect: string; targetId?: string; status: "confirmed" | "withheld" | "unknown" }>
  };
  async function runEffects(accepted: Awaited<ReturnType<typeof accept>>): Promise<PatchEffects> {
    const { plan, actor, issue, comment, reopened, reopenFromStatus } = accepted;
    const { existing, intent, commentBody, resumeRequested, isClosed, mentionedIds } = plan;
    const id = issue.id;
    const outcomes: PatchEffects["outcomes"] = [];
    async function effect(name: string, targetId: string | undefined, run: () => Promise<unknown>) {
      try { const result = await run(); outcomes.push({ effect: name, targetId, status: result === null ? "withheld" : "confirmed" }); return result; }
      catch { outcomes.push({ effect: name, targetId, status: "unknown" }); return undefined; }
    }
    for (const publication of accepted.publications) await effect("publication", undefined, async () => publishActivity(publication));
    let interruptedRunId: string | null = null;
    const closedStatusCancelRunIds = new Set(plan.runsToCancelForClosedStatus.map((run) => run.id));
    const statusCancelSource = issue.status === "done" ? "issue_status_done" : "issue_status_cancelled";
    const statusCancelReason = issue.status === "done" ? "Cancelled because the issue was marked done" : "Cancelled because the issue was cancelled";
    const cancellations = new Map<string, { run: { id: string; agentId: string | null }; source: string; reason: string }>();
    if (plan.interruptRun) cancellations.set(plan.interruptRun.id, { run: plan.interruptRun, source: "issue_comment_interrupt", reason: "Interrupted by a new comment" });
    for (const run of plan.runsToCancelForClosedStatus) {
      if (!cancellations.has(run.id)) cancellations.set(run.id, { run, source: statusCancelSource, reason: statusCancelReason });
    }
    for (const [runId, { run, source, reason }] of cancellations) {
      const cancelled = await effect("cancel", runId, async () => {
        const result = await heartbeat.cancelRun(runId, reason);
        return result?.status === "cancelled" ? result : null;
      });
      if (cancelled) {
        if (plan.interruptRun?.id === runId) interruptedRunId = runId;
        await effect("cancel_audit", runId, async () => {
          const publication = await insertActivity(db, {
            companyId: issue.companyId, ...actor,
            action: "heartbeat.cancelled", entityType: "heartbeat_run", entityId: runId,
            // AgentDash (review-1015): identifier lets the activity row name
            // the issue — "ACM-3 was marked done", not "the issue was …".
            details: { agentId: run.agentId, source, issueId: id, identifier: issue.identifier, mutationId: accepted.mutationId }
          });
          publishActivity(publication);
        });
      } else if (cancelled === undefined && closedStatusCancelRunIds.has(runId)) {
        await effect("cancel_failure_audit", runId, async () => {
          const publication = await insertActivity(db, {
            companyId: issue.companyId, ...actor,
            action: "heartbeat.cancel_failed", entityType: "heartbeat_run", entityId: runId,
            details: { source: statusCancelSource, issueId: id, mutationId: accepted.mutationId }
          });
          publishActivity(publication);
        });
      }
    }
    if (actor.runId) await effect("run_activity", actor.runId, () => heartbeat.reportRunActivity(actor.runId!));
    if (existing.status !== issue.status && hooks.statusChanged) await effect("verdict", id, () => hooks.statusChanged!(id, existing.status, issue.status));
    if (existing.status !== "done" && issue.status === "done" && actor.agentId && hooks.completed) await effect("telemetry", actor.agentId, () => hooks.completed!(actor.agentId!));
    const assigneeChanged =
      issue.assigneeAgentId !== existing.assigneeAgentId || issue.assigneeUserId !== existing.assigneeUserId;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      intent.status !== undefined;
    const statusChangedFromBlockedToTodo =
      existing.status === "blocked" &&
      issue.status === "todo" &&
      (intent.status !== undefined || reopened);
    const statusChangedFromClosedToTodo =
      isClosedIssueStatus(existing.status) &&
      issue.status === "todo" &&
      intent.status !== undefined;
    const previousExecutionState = parseIssueExecutionState(existing.executionState);
    const nextExecutionState = parseIssueExecutionState(issue.executionState);
    const executionStageWakeup = buildExecutionStageWakeup({
      issueId: issue.id,
      previousState: previousExecutionState,
      nextState: nextExecutionState,
      interruptedRunId,
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.

    type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
    const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
    const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
      const wakeIssueId =
        wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
          ? wakeup.payload.issueId
          : issue.id;
      wakeups.set(`${agentId}:${wakeIssueId}`, { agentId, wakeup });
    };

    if (executionStageWakeup) {
      addWakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup);
    } else if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
      addWakeup(issue.assigneeAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: {
          issueId: issue.id,
          ...(comment ? { commentId: comment.id } : {}),
          mutation: "update",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          ...(comment
            ? {
              taskId: issue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
            }
            : {}),
          source: "issue.update",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      });
    }

    if (
      !assigneeChanged &&
      (statusChangedFromBacklog || statusChangedFromBlockedToTodo || statusChangedFromClosedToTodo) &&
      issue.assigneeAgentId
    ) {
      addWakeup(issue.assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: {
          issueId: issue.id,
          mutation: "update",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
        contextSnapshot: {
          issueId: issue.id,
          source: "issue.status_change",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      });
    }

    if (commentBody && comment) {
      const assigneeId = issue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const skipAssigneeCommentWake = selfComment || isClosed;

      if (assigneeId && !assigneeChanged && (reopened || !skipAssigneeCommentWake)) {
        addWakeup(assigneeId, {
          source: "automation",
          triggerDetail: "system",
          reason: reopened ? "issue_reopened_via_comment" : "issue_commented",
          payload: {
            issueId: id,
            commentId: comment.id,
            mutation: "comment",
            ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            source: reopened ? "issue.comment.reopen" : "issue.comment",
            wakeReason: reopened ? "issue_reopened_via_comment" : "issue_commented",
            ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      // AgentDash (c4-stops review): same closed-issue rule as the comment
      // path — an @-mention on a done/cancelled issue is FYI and must not
      // wake; only an explicit reopen makes the issue live again.
      if (!isClosed || reopened) {
        for (const mentionedId of mentionedIds) {
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          addWakeup(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }
    }

    const becameDone = existing.status !== "done" && issue.status === "done";
    if (becameDone) {
      const dependents = accepted.dependents;
      for (const dependent of dependents) {
        addWakeup(dependent.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_blockers_resolved",
          payload: {
            issueId: dependent.id,
            resolvedBlockerIssueId: issue.id,
            blockerIssueIds: dependent.blockerIssueIds,
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: dependent.id,
            taskId: dependent.id,
            wakeReason: "issue_blockers_resolved",
            source: "issue.blockers_resolved",
            resolvedBlockerIssueId: issue.id,
            blockerIssueIds: dependent.blockerIssueIds,
          },
        });
      }
    }

    const becameTerminal =
      !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
    if (becameTerminal && issue.parentId) {
      const parent = accepted.parent;
      if (parent) {
        addWakeup(parent.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_children_completed",
          payload: {
            issueId: parent.id,
            completedChildIssueId: issue.id,
            childIssueIds: parent.childIssueIds,
            childIssueSummaries: parent.childIssueSummaries,
            childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: parent.id,
            taskId: parent.id,
            wakeReason: "issue_children_completed",
            source: "issue.children_completed",
            completedChildIssueId: issue.id,
            childIssueIds: parent.childIssueIds,
            childIssueSummaries: parent.childIssueSummaries,
            childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
          },
        });
      }
    }

    for (const { agentId, wakeup } of wakeups.values()) await effect("wakeup", agentId, () => heartbeat.wakeup(agentId, wakeup));
    const unresolved = outcomes.some(result => result.status === "unknown");
    return { unresolved, outcomes, status: !unresolved ? "confirmed" : outcomes.some(result => result.status === "confirmed") ? "partial" : "unknown" };
  }
  function dispatch(accepted: Awaited<ReturnType<typeof accept>>) {
    const prior = dispatched.get(accepted);
    if (prior) return prior;
    const result = runEffects(accepted);
    dispatched.set(accepted, result);
    return result;
  }
  return { prepare, accept, dispatch };
}
