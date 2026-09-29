import type { Request } from 'express';
import { assertProjectIdVisible } from '../routes/visibility.js';
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documents,
  companies,
  companyMemberships,
  workforceEnrollments,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type {
  AcceptIssueThreadInteraction,
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  CancelIssueThreadInteraction,
  CreateIssueThreadInteraction,
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  RequestConfirmationTarget,
  RejectIssueThreadInteraction,
  RespondIssueThreadInteraction,
  SuggestTasksInteraction,
  SuggestTasksResultCreatedTask,
} from "@paperclipai/shared";
import {
  acceptIssueThreadInteractionSchema,
  askUserQuestionsPayloadSchema,
  askUserQuestionsResultSchema,
  cancelIssueThreadInteractionSchema,
  createIssueThreadInteractionSchema,
  rejectIssueThreadInteractionSchema,
  respondIssueThreadInteractionSchema,
  resolveWorkforceTemplate,
  requestConfirmationPayloadSchema,
  requestConfirmationResultSchema,
  suggestTasksPayloadSchema,
  suggestTasksResultSchema,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { isUniqueViolation, pgConstraintName } from "../lib/pg-error.js";
import { issueService } from "./issues.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { workforceService } from "./workforce.js";

type InteractionActor = {
  agentId?: string | null;
  userId?: string | null;
};

const ISSUE_THREAD_INTERACTION_IDEMPOTENCY_CONSTRAINT =
  "issue_thread_interactions_company_issue_idempotency_uq";

type IssueWakeTarget = {
  id: string;
  assigneeAgentId: string | null;
  assigneeUserId?: string | null;
  status: string;
};

type ResolvedInteractionResult = {
  interaction: IssueThreadInteraction;
  createdIssues: IssueWakeTarget[];
  continuationIssue?: IssueWakeTarget | null;
};

type IssueThreadInteractionRow = typeof issueThreadInteractions.$inferSelect;
type IssueTouchDb = Pick<Db, "update">;

type IssueResolutionContext = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function isIssueThreadInteractionIdempotencyConflict(error: unknown): boolean {
  return (
    isUniqueViolation(error) &&
    pgConstraintName(error) === ISSUE_THREAD_INTERACTION_IDEMPOTENCY_CONSTRAINT
  );
}

function isEquivalentCreateRequest(
  row: IssueThreadInteractionRow,
  input: CreateIssueThreadInteraction,
  actor: InteractionActor,
) {
  return (
    row.kind === input.kind
    && row.continuationPolicy === input.continuationPolicy
    && (row.idempotencyKey ?? null) === (input.idempotencyKey ?? null)
    && (row.sourceCommentId ?? null) === (input.sourceCommentId ?? null)
    && (row.sourceRunId ?? null) === (input.sourceRunId ?? null)
    && (row.title ?? null) === (input.title ?? null)
    && (row.summary ?? null) === (input.summary ?? null)
    && (row.createdByAgentId ?? null) === (actor.agentId ?? null)
    && (row.createdByUserId ?? null) === (actor.userId ?? null)
    && isDeepStrictEqual(row.payload, input.payload)
  );
}

function hydrateInteraction(
  row: IssueThreadInteractionRow,
): IssueThreadInteraction {
  const base = {
    ...row,
    idempotencyKey: row.idempotencyKey ?? null,
    status: row.status as IssueThreadInteraction["status"],
    continuationPolicy: row.continuationPolicy as IssueThreadInteraction["continuationPolicy"],
  };

  switch (row.kind) {
    case "suggest_tasks":
      return {
        ...base,
        kind: "suggest_tasks",
        payload: suggestTasksPayloadSchema.parse(row.payload),
        result: row.result ? suggestTasksResultSchema.parse(row.result) : null,
      } satisfies SuggestTasksInteraction;
    case "ask_user_questions":
      return {
        ...base,
        kind: "ask_user_questions",
        payload: askUserQuestionsPayloadSchema.parse(row.payload),
        result: row.result ? askUserQuestionsResultSchema.parse(row.result) : null,
      } satisfies AskUserQuestionsInteraction;
    case "request_confirmation":
      return {
        ...base,
        kind: "request_confirmation",
        payload: requestConfirmationPayloadSchema.parse(row.payload),
        result: row.result ? requestConfirmationResultSchema.parse(row.result) : null,
      } satisfies RequestConfirmationInteraction;
    default:
      throw unprocessable(`Unknown interaction kind: ${row.kind}`);
  }
}

async function touchIssue(db: IssueTouchDb, issueId: string) {
  await db
    .update(issues)
    .set({ updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}

function isTerminalIssueStatus(status: string) {
  return status === "done" || status === "cancelled";
}

function shouldReturnAcceptedConfirmationToCreatorAgent(args: {
  issue: IssueResolutionContext;
  current: IssueThreadInteractionRow;
  actor: InteractionActor;
}) {
  if (args.current.kind !== "request_confirmation") return false;
  if (!args.current.createdByAgentId) return false;
  if (!args.actor.userId) return false;
  if (!args.issue.assigneeUserId) return false;
  if (args.issue.assigneeAgentId) return false;
  if (isTerminalIssueStatus(args.issue.status)) return false;
  return true;
}

function buildTaskCreationOrder(tasks: ReadonlyArray<SuggestTasksInteraction["payload"]["tasks"][number]>) {
  const taskByClientKey = new Map(tasks.map((task) => [task.clientKey, task] as const));
  const ordered: Array<SuggestTasksInteraction["payload"]["tasks"][number]> = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (clientKey: string) => {
    const currentState = state.get(clientKey);
    if (currentState === "done") return;
    if (currentState === "visiting") {
      throw unprocessable("Suggested tasks contain a parentClientKey cycle");
    }

    const task = taskByClientKey.get(clientKey);
    if (!task) {
      throw unprocessable(`Unknown parentClientKey: ${clientKey}`);
    }

    state.set(clientKey, "visiting");
    if (task.parentClientKey) {
      visit(task.parentClientKey);
    }
    state.set(clientKey, "done");
    ordered.push(task);
  };

  for (const task of tasks) {
    visit(task.clientKey);
  }

  return ordered;
}

function resolveSelectedSuggestedTasks(args: {
  interaction: SuggestTasksInteraction;
  selectedClientKeys?: AcceptIssueThreadInteraction["selectedClientKeys"];
}) {
  const taskByClientKey = new Map(
    args.interaction.payload.tasks.map((task) => [task.clientKey, task] as const),
  );
  const selectedClientKeys = args.selectedClientKeys ?? args.interaction.payload.tasks.map((task) => task.clientKey);
  const selectedClientKeySet = new Set<string>();

  for (const clientKey of selectedClientKeys) {
    const task = taskByClientKey.get(clientKey);
    if (!task) {
      throw unprocessable(`Unknown suggested task clientKey: ${clientKey}`);
    }
    selectedClientKeySet.add(clientKey);
  }

  if (selectedClientKeySet.size === 0) {
    throw unprocessable("Select at least one suggested task to accept");
  }

  for (const clientKey of selectedClientKeySet) {
    let parentClientKey = taskByClientKey.get(clientKey)?.parentClientKey ?? null;
    while (parentClientKey) {
      if (!selectedClientKeySet.has(parentClientKey)) {
        throw unprocessable(`Suggested task ${clientKey} requires its parent ${parentClientKey} to also be selected`);
      }
      parentClientKey = taskByClientKey.get(parentClientKey)?.parentClientKey ?? null;
    }
  }

  return {
    selectedTasks: args.interaction.payload.tasks.filter((task) => selectedClientKeySet.has(task.clientKey)),
    skippedClientKeys: args.interaction.payload.tasks
      .filter((task) => !selectedClientKeySet.has(task.clientKey))
      .map((task) => task.clientKey),
  };
}

function normalizeQuestionAnswers(args: {
  questions: AskUserQuestionsInteraction["payload"]["questions"];
  answers: RespondIssueThreadInteraction["answers"];
}) {
  const questionById = new Map(args.questions.map((question) => [question.id, question] as const));
  const answerByQuestionId = new Map<string, AskUserQuestionsAnswer>();

  for (const answer of args.answers) {
    const question = questionById.get(answer.questionId);
    if (!question) {
      throw unprocessable(`Unknown questionId: ${answer.questionId}`);
    }
    if (answerByQuestionId.has(answer.questionId)) {
      throw unprocessable(`Duplicate answer for questionId: ${answer.questionId}`);
    }

    const text = answer.text?.trim();
    if (question.selectionMode === "text" ? answer.optionIds.length > 0 : answer.text !== undefined) {
      throw unprocessable(`Question ${answer.questionId} requires ${question.selectionMode === "text" ? "text without selected options" : "selected options without text"}`);
    }
    const uniqueOptionIds = [...new Set(answer.optionIds)];
    const validOptionIds = new Set(question.options.map((option) => option.id));
    for (const optionId of uniqueOptionIds) {
      if (!validOptionIds.has(optionId)) {
        throw unprocessable(`Unknown optionId for question ${answer.questionId}: ${optionId}`);
      }
    }

    if (question.selectionMode === "single" && uniqueOptionIds.length > 1) {
      throw unprocessable(`Question ${answer.questionId} only allows one answer`);
    }

    answerByQuestionId.set(answer.questionId, {
      questionId: answer.questionId,
      optionIds: uniqueOptionIds,
      ...(question.selectionMode === "text" ? { text: text ?? "" } : {}),
    });
  }

  for (const question of args.questions) {
    const answer = answerByQuestionId.get(question.id);
    if (question.required && (!answer || (question.selectionMode === "text" ? !answer.text : answer.optionIds.length === 0))) {
      throw unprocessable(`Question ${question.id} requires an answer`);
    }
  }

  return args.questions
    .map((question) => answerByQuestionId.get(question.id))
    .filter((answer): answer is AskUserQuestionsAnswer => Boolean(answer));
}

async function getIssueDocumentTargetSnapshot(db: Db | any, args: {
  companyId: string;
  issueId: string;
  target: RequestConfirmationTarget;
}) {
  if (args.target.type !== "issue_document") return null;
  const targetIssueId = args.target.issueId ?? args.issueId;
  const row = await db
    .select({
      issueId: issueDocuments.issueId,
      documentId: issueDocuments.documentId,
      key: issueDocuments.key,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(issueDocuments.companyId, args.companyId),
      eq(issueDocuments.issueId, targetIssueId),
      eq(issueDocuments.key, args.target.key),
    ))
    .then((rows: Array<{
      issueId: string;
      documentId: string;
      key: string;
      latestRevisionId: string | null;
      latestRevisionNumber: number;
    }>) => rows[0] ?? null);

  if (!row) return null;
  if (args.target.documentId && args.target.documentId !== row.documentId) return null;
  return row;
}

function buildIssueDocumentTargetFromSnapshot(args: {
  issueId: string;
  snapshot: {
    issueId: string;
    documentId: string;
    key: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
  } | null;
}): RequestConfirmationTarget | null {
  if (!args.snapshot?.latestRevisionId) return null;
  return {
    type: "issue_document",
    issueId: args.snapshot.issueId ?? args.issueId,
    documentId: args.snapshot.documentId,
    key: args.snapshot.key,
    revisionId: args.snapshot.latestRevisionId,
    revisionNumber: args.snapshot.latestRevisionNumber,
  };
}

function buildIssueDocumentTargetFromDocument(args: {
  issueId: string;
  document: { id: string; key: string; latestRevisionId?: string | null; latestRevisionNumber?: number | null } | null;
}): RequestConfirmationTarget | null {
  if (!args.document?.latestRevisionId) return null;
  return {
    type: "issue_document",
    issueId: args.issueId,
    documentId: args.document.id,
    key: args.document.key,
    revisionId: args.document.latestRevisionId,
    revisionNumber: args.document.latestRevisionNumber ?? null,
  };
}

async function assertRequestConfirmationTargetIsCurrent(db: Db | any, args: {
  companyId: string;
  issueId: string;
  target?: RequestConfirmationTarget | null;
}) {
  if (!args.target) return;
  if (args.target.type !== "issue_document") return;
  const snapshot = await getIssueDocumentTargetSnapshot(db, {
    companyId: args.companyId,
    issueId: args.issueId,
    target: args.target,
  });
  if (!snapshot || snapshot.latestRevisionId !== args.target.revisionId) {
    throw unprocessable("request_confirmation target must reference the current issue document revision");
  }
  if (args.target.revisionNumber && snapshot.latestRevisionNumber !== args.target.revisionNumber) {
    throw unprocessable("request_confirmation target revisionNumber must match the current issue document revision");
  }
}

async function expireStaleRequestConfirmationTarget(db: Db | any, args: {
  row: IssueThreadInteractionRow;
  actor: InteractionActor;
}): Promise<IssueThreadInteraction | null> {
  if (args.row.kind !== "request_confirmation" || args.row.status !== "pending") return null;
  const interaction = hydrateInteraction(args.row) as RequestConfirmationInteraction;
  const target = interaction.payload.target ?? null;
  if (!target) return null;
  if (target.type !== "issue_document") return null;

  const snapshot = await getIssueDocumentTargetSnapshot(db, {
    companyId: args.row.companyId,
    issueId: args.row.issueId,
    target,
  });
  const isCurrent =
    snapshot
    && snapshot.latestRevisionId === target.revisionId
    && (!target.revisionNumber || snapshot.latestRevisionNumber === target.revisionNumber);
  if (isCurrent) return null;

  const now = new Date();
  const currentTarget = buildIssueDocumentTargetFromSnapshot({
    issueId: args.row.issueId,
    snapshot,
  });
  const [updated] = await db
    .update(issueThreadInteractions)
    .set({
      status: "expired",
      payload: currentTarget
        ? {
            ...interaction.payload,
            target: currentTarget,
          }
        : interaction.payload,
      result: {
        version: 1,
        outcome: "stale_target",
        staleTarget: target,
      },
      resolvedByAgentId: args.actor.agentId ?? null,
      resolvedByUserId: args.actor.userId ?? null,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(issueThreadInteractions.id, args.row.id),
      eq(issueThreadInteractions.status, "pending"),
    ))
    .returning();

  if (!updated) {
    throw conflict("Interaction has already been resolved");
  }
  await touchIssue(db, args.row.issueId);
  return hydrateInteraction(updated);
}

export function issueThreadInteractionService(db: Db) {
  async function getIdempotentInteraction(args: {
    issueId: string;
    companyId: string;
    idempotencyKey: string;
  }) {
    return db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, args.companyId),
        eq(issueThreadInteractions.issueId, args.issueId),
        eq(issueThreadInteractions.idempotencyKey, args.idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function getPendingInteractionForResolution(args: {
    issue: { id: string; companyId: string };
    interactionId: string;
  }) {
    const current = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, args.interactionId))
      .then((rows) => rows[0] ?? null);

    if (!current) throw notFound("Interaction not found");
    if (current.companyId !== args.issue.companyId || current.issueId !== args.issue.id) {
      throw notFound("Interaction not found");
    }
    if (current.status !== "pending") {
      throw conflict("Interaction has already been resolved");
    }
    return current;
  }

  async function acceptRequestConfirmation(args: {
    issue: { id: string; companyId: string };
    current: IssueThreadInteractionRow;
    actor: InteractionActor;
  }): Promise<{
    interaction: IssueThreadInteraction;
    continuationIssue: IssueWakeTarget | null;
  }> {
    const expired = await expireStaleRequestConfirmationTarget(db, {
      row: args.current,
      actor: args.actor,
    });
    if (expired) {
      return { interaction: expired, continuationIssue: null };
    }

    const now = new Date();
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(issueThreadInteractions)
        .set({
          status: "accepted",
          result: {
            version: 1,
            outcome: "accepted",
          },
          resolvedByAgentId: args.actor.agentId ?? null,
          resolvedByUserId: args.actor.userId ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(issueThreadInteractions.id, args.current.id),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      const issueContext = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issues)
        .where(eq(issues.id, args.issue.id))
        .then((rows: IssueResolutionContext[]) => rows[0] ?? null);

      if (!issueContext || issueContext.companyId !== args.issue.companyId) {
        throw notFound("Issue not found");
      }

      let continuationIssue: IssueWakeTarget | null = null;
      if (shouldReturnAcceptedConfirmationToCreatorAgent({
        issue: issueContext,
        current: args.current,
        actor: args.actor,
      })) {
        const returnStatus = issueContext.status === "blocked" ? "blocked" : "todo";
        const returnedIssue = await issueService(db).update(args.issue.id, {
          status: returnStatus,
          assigneeAgentId: args.current.createdByAgentId,
          assigneeUserId: null,
          actorAgentId: args.actor.agentId ?? null,
          actorUserId: args.actor.userId ?? null,
        }, tx);

        if (returnedIssue) {
          continuationIssue = {
            id: returnedIssue.id,
            assigneeAgentId: returnedIssue.assigneeAgentId ?? null,
            assigneeUserId: returnedIssue.assigneeUserId ?? null,
            status: returnedIssue.status,
          };
        }
      } else {
        await touchIssue(tx, args.issue.id);
      }

      return {
        interaction: hydrateInteraction(updated),
        continuationIssue,
      };
    });
  }

  async function rejectRequestConfirmation(args: {
    issue: { id: string; companyId: string };
    current: IssueThreadInteractionRow;
    input: RejectIssueThreadInteraction;
    actor: InteractionActor;
  }): Promise<IssueThreadInteraction> {
    const expired = await expireStaleRequestConfirmationTarget(db, {
      row: args.current,
      actor: args.actor,
    });
    if (expired) {
      return expired;
    }

    const interaction = hydrateInteraction(args.current) as RequestConfirmationInteraction;
    const reason = args.input.reason?.trim() ?? "";
    if (interaction.payload.rejectRequiresReason === true && reason.length === 0) {
      throw unprocessable("A decline reason is required for this confirmation");
    }

    const now = new Date();
    const [updated] = await db
      .update(issueThreadInteractions)
      .set({
        status: "rejected",
        result: {
          version: 1,
          outcome: "rejected",
          reason: reason || null,
        },
        resolvedByAgentId: args.actor.agentId ?? null,
        resolvedByUserId: args.actor.userId ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(issueThreadInteractions.id, args.current.id),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .returning();

    if (!updated) {
      throw conflict("Interaction has already been resolved");
    }
    await touchIssue(db, args.issue.id);
    return hydrateInteraction(updated);
  }

  async function resolveCreateInput(connection: Db,
    issue: { id: string; companyId: string },
    input: CreateIssueThreadInteraction,
    actor: InteractionActor,
  ) {
    const data = createIssueThreadInteractionSchema.parse(input);
    if (data.kind === 'ask_user_questions') {
      const [persistedIssue] = await connection.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for('update');
      if (!persistedIssue) throw notFound('Issue not found');
      const [enrollment] = persistedIssue.assigneeAgentId ? await connection.select().from(workforceEnrollments).where(and(eq(workforceEnrollments.companyId, issue.companyId), eq(workforceEnrollments.agentId, persistedIssue.assigneeAgentId))) : [];
      const template = enrollment && resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
      const accountability = agentAccountabilityService(connection);
      // The server pins the target, never a body-supplied agent identifier.
      delete data.payload.workforceAgentId;
      delete data.payload.workforceEnrollmentId;
      delete data.payload.workforceTemplateId;
      delete data.payload.workforceTemplateVersion;
      if (data.payload.questions.some(q => q.companyFactKey) && !template && !data.payload.replacesInteractionId) throw unprocessable('Assign an enrolled worker before requesting workforce facts');
      if (template && persistedIssue.assigneeAgentId) {
        if (['done', 'cancelled'].includes(persistedIssue.status)) throw conflict('Cannot request required input on a closed job');
        if (actor.agentId && actor.agentId !== persistedIssue.assigneeAgentId) throw forbidden('Only the enrolled assignee may request workforce input');
        if (!actor.agentId && !actor.userId) throw forbidden('An authenticated human or assigned worker is required');
        if (data.payload.questions.some(q => q.companyFactKey && !template.requiredFactKeys.includes(q.companyFactKey))) throw unprocessable('Question must reference a known fact key of the assigned workforce template');
        const owner = await accountability.escalationUserId(issue.companyId, persistedIssue.assigneeAgentId);
        if (!owner) throw conflict('Assign an active accountable company member before asking workforce questions');
        if (data.payload.answerOwnerUserId && data.payload.answerOwnerUserId !== owner) throw conflict('Question owner must be the assignee’s current accountable member');
        data.payload.answerOwnerUserId = owner;
        data.payload.workforceAgentId = persistedIssue.assigneeAgentId;
        data.payload.workforceEnrollmentId = enrollment!.id;
        data.payload.workforceTemplateId = template.id;
        data.payload.workforceTemplateVersion = template.version;
      }
      if (data.payload.answerOwnerUserId) await accountability.assertAccountableMember(issue.companyId, data.payload.answerOwnerUserId);
      if (data.payload.replacesInteractionId) {
        const [prior] = await connection.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, data.payload.replacesInteractionId), eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id)));
        if (!prior || prior.kind !== 'ask_user_questions' || prior.status !== 'cancelled') throw unprocessable('Replace an explicitly cancelled question on this issue');
        const previous = askUserQuestionsPayloadSchema.parse(prior.payload);
        if (previous.workforceAgentId && !data.payload.workforceAgentId) {
          if (actor.agentId || !actor.userId) throw forbidden('A human must replace a workforce question after reassignment to an unenrolled worker');
          if (['done', 'cancelled'].includes(persistedIssue.status)) throw conflict('Cannot request required input on a closed job');
          const owner = await accountability.escalationUserId(issue.companyId, previous.workforceAgentId);
          if (!owner) throw conflict('Assign an active accountable member before replacing this question');
          await accountability.assertAccountableMember(issue.companyId, owner);
          data.payload.answerOwnerUserId = owner;
          data.payload.workforceAgentId = previous.workforceAgentId;
          data.payload.workforceEnrollmentId = previous.workforceEnrollmentId;
          data.payload.workforceTemplateId = previous.workforceTemplateId;
          data.payload.workforceTemplateVersion = previous.workforceTemplateVersion;
        }
        const originTemplate = resolveWorkforceTemplate(data.payload.workforceTemplateId ?? '', data.payload.workforceTemplateVersion);
        if (originTemplate && data.payload.questions.some(q => q.companyFactKey && !originTemplate.requiredFactKeys.includes(q.companyFactKey))) throw unprocessable('Replacement must use known fact keys of its workforce template');
        if (previous.questions.some(q => q.required && !data.payload.questions.some(replacement => replacement.id === q.id && replacement.required && replacement.companyFactKey === q.companyFactKey))) throw unprocessable('Replacement must retain every required question and fact key');
      }
    }

    return data;
  }

  async function createInteraction(connection: Db,
    issue: { id: string; companyId: string },
    input: CreateIssueThreadInteraction,
    actor: InteractionActor,
  ) {
    const data = await resolveCreateInput(connection, issue, input, actor);
    if (data.idempotencyKey) {
      const existing = await getIdempotentInteraction({
        issueId: issue.id,
        companyId: issue.companyId,
        idempotencyKey: data.idempotencyKey,
      });
      if (existing) {
        if (!isEquivalentCreateRequest(existing, data, actor)) {
          throw conflict("Interaction idempotency key already exists for a different request", {
            idempotencyKey: data.idempotencyKey,
          });
        }
        return hydrateInteraction(existing);
      }
    }

    if (data.sourceCommentId) {
      const sourceComment = await connection
        .select({
          companyId: issueComments.companyId,
          issueId: issueComments.issueId,
        })
        .from(issueComments)
        .where(eq(issueComments.id, data.sourceCommentId))
        .then((rows) => rows[0] ?? null);
      if (!sourceComment || sourceComment.companyId !== issue.companyId || sourceComment.issueId !== issue.id) {
        throw unprocessable("sourceCommentId must belong to the same issue and company");
      }
    }

    if (data.sourceRunId) {
      const sourceRun = await connection
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, data.sourceRunId))
        .then((rows) => rows[0] ?? null);
      if (!sourceRun || sourceRun.companyId !== issue.companyId || (actor.agentId && sourceRun.agentId !== actor.agentId)) {
        throw unprocessable("sourceRunId must belong to the same company");
      }
    }

    if (data.kind === "request_confirmation") {
      await assertRequestConfirmationTargetIsCurrent(connection, {
        companyId: issue.companyId,
        issueId: issue.id,
        target: data.payload.target ?? null,
      });
    }

    let created: IssueThreadInteractionRow;
    try {
      [created] = await connection
        .insert(issueThreadInteractions)
        .values({
          companyId: issue.companyId,
          issueId: issue.id,
          kind: data.kind,
          status: "pending",
          continuationPolicy: data.continuationPolicy,
          idempotencyKey: data.idempotencyKey ?? null,
          sourceCommentId: data.sourceCommentId ?? null,
          sourceRunId: data.sourceRunId ?? null,
          title: data.title ?? null,
          summary: data.summary ?? null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          payload: data.payload,
        })
        .returning();
    } catch (error) {
      if (!data.idempotencyKey || !isIssueThreadInteractionIdempotencyConflict(error)) {
        throw error;
      }
      const existing = await getIdempotentInteraction({
        issueId: issue.id,
        companyId: issue.companyId,
        idempotencyKey: data.idempotencyKey,
      });
      if (!existing) throw error;
      if (!isEquivalentCreateRequest(existing, data, actor)) {
        throw conflict("Interaction idempotency key already exists for a different request", {
          idempotencyKey: data.idempotencyKey,
        });
      }
      return hydrateInteraction(existing);
    }

    await touchIssue(connection, issue.id);
    return hydrateInteraction(created);
  }

  async function answerQuestions(connection: Db,
    issue: { id: string; companyId: string },
    interactionId: string,
    input: RespondIssueThreadInteraction,
    actor: InteractionActor,
    validationOnly = false,
  ) {
    input = respondIssueThreadInteractionSchema.parse(input);
    const current = await connection
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId))
      .then((rows) => rows[0] ?? null);

    if (!current) throw notFound("Interaction not found");
    if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
      throw notFound("Interaction not found");
    }
    if (current.kind !== "ask_user_questions") {
      throw unprocessable("Only ask_user_questions interactions can be answered");
    }
    if (current.status !== "pending") {
      throw conflict("Interaction has already been resolved");
    }

    const interaction = hydrateInteraction(current) as AskUserQuestionsInteraction;
    if (interaction.payload.answerOwnerUserId) {
      if (actor.agentId || actor.userId !== interaction.payload.answerOwnerUserId) throw forbidden('Only the named human answer owner may respond');
      const accountability = agentAccountabilityService(connection);
      await accountability.assertAccountableMember(issue.companyId, actor.userId!);
      const [member] = await connection.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, issue.companyId), eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, actor.userId!), eq(companyMemberships.status, 'active')));
      const [job] = await connection.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
      await assertProjectIdVisible(connection, { actor: { type: 'board', userId: actor.userId, memberships: member ? [member] : [] } } as unknown as Request, issue.companyId, job?.projectId);
    }
    const normalizedAnswers = normalizeQuestionAnswers({
      questions: interaction.payload.questions,
      answers: input.answers,
    });

    let publish: (() => Promise<unknown>) | null = null;
    if (input.shareWithCompany) {
      if (!actor.userId || actor.agentId || !interaction.payload.answerOwnerUserId) throw forbidden('Named human confirmation is required to publish company facts');
      const [job] = await connection.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
      if (!job || job.projectId || !interaction.payload.workforceAgentId) throw unprocessable('Only company-level workforce jobs may share answers with the company');
      const svc = workforceService(connection);
      const enrollment = await svc.getEnrollment(issue.companyId, interaction.payload.workforceAgentId!);
      const template = enrollment && resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
      const facts = interaction.payload.questions.filter(q => q.companyFactKey).map(q => ({ key: q.companyFactKey!, value: normalizedAnswers.find(a => a.questionId === q.id)?.text ?? '', sourceReference: `interaction:${interaction.id}/question:${q.id}` }));
      if (!template || !facts.length || facts.some(f => !template.requiredFactKeys.includes(f.key) || !f.value.trim())) throw unprocessable('Only answered template fact keys may be shared');
      const prior = await svc.getBrief(issue.companyId);
      publish = () => svc.updateBrief(issue.companyId, { expectedRevision: prior.revision, sources: prior.sources, facts: [...prior.facts.filter(f => !facts.some(next => next.key === f.key)), ...facts] }, { userId: actor.userId! });
    }
    if (validationOnly) return interaction;
    if (publish) await publish();
    const [updated] = await connection
      .update(issueThreadInteractions)
      .set({
        status: "answered",
        result: {
          version: 1,
          answers: normalizedAnswers,
          ...(input.shareWithCompany !== undefined || interaction.payload.workforceAgentId ? { shareWithCompany: input.shareWithCompany ?? false } : {}),
          summaryMarkdown: input.summaryMarkdown ?? null,
        },
        resolvedByAgentId: actor.agentId ?? null,
        resolvedByUserId: actor.userId ?? null,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(issueThreadInteractions.id, interactionId),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .returning();

    if (!updated) {
      throw conflict("Interaction has already been resolved");
    }

    await touchIssue(connection, issue.id);
    return hydrateInteraction(updated);
  }

  return {
    // AgentDash: read-only preflight uses the canonical validation and owner
    // resolution. No answer, company fact or interaction row is written.
    previewCreate: (issue: { id: string; companyId: string }, input: CreateIssueThreadInteraction, actor: InteractionActor) => resolveCreateInput(db, issue, input, actor),
    previewAnswer: (issue: { id: string; companyId: string }, interactionId: string, input: RespondIssueThreadInteraction, actor: InteractionActor) => answerQuestions(db, issue, interactionId, input, actor, true),
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId))
        .orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id));

      return rows.map((row) => hydrateInteraction(row));
    },

    getById: async (interactionId: string) => {
      const row = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      return row ? hydrateInteraction(row) : null;
    },

    create: async (issue: { id: string; companyId: string }, input: CreateIssueThreadInteraction, actor: InteractionActor) => {
      const namedQuestion = input.kind === 'ask_user_questions';
      return namedQuestion ? db.transaction(tx => createInteraction(tx as unknown as Db, issue, input, actor)) : createInteraction(db, issue, input, actor);
    },

    acceptInteraction: async (
      issue: { id: string; companyId: string; projectId: string | null; goalId: string | null },
      interactionId: string,
      input: AcceptIssueThreadInteraction,
      actor: InteractionActor,
    ): Promise<ResolvedInteractionResult> => {
      const data = acceptIssueThreadInteractionSchema.parse(input);
      const current = await getPendingInteractionForResolution({ issue, interactionId });
      switch (current.kind) {
        case "suggest_tasks":
          return issueThreadInteractionService(db).acceptSuggestedTasks(issue, interactionId, data, actor);
        case "request_confirmation": {
          const accepted = await acceptRequestConfirmation({
            issue,
            current,
            actor,
          });
          return {
            interaction: accepted.interaction,
            continuationIssue: accepted.continuationIssue,
            createdIssues: [],
          };
        }
        default:
          throw unprocessable(`Interactions of kind ${current.kind} cannot be accepted`);
      }
    },

    acceptSuggestedTasks: async (
      issue: { id: string; companyId: string; projectId: string | null; goalId: string | null },
      interactionId: string,
      input: AcceptIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Interaction not found");
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "suggest_tasks") {
        throw unprocessable("Only suggest_tasks interactions can be accepted");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const interaction = hydrateInteraction(current) as SuggestTasksInteraction;
      const { selectedTasks, skippedClientKeys } = resolveSelectedSuggestedTasks({
        interaction,
        selectedClientKeys: input.selectedClientKeys,
      });
      const orderedTasks = buildTaskCreationOrder(selectedTasks);
      const explicitParentIds = [...new Set([
        issue.id,
        ...(interaction.payload.defaultParentId ? [interaction.payload.defaultParentId] : []),
        ...selectedTasks
          .map((task) => task.parentId ?? null)
          .filter((value): value is string => Boolean(value)),
      ])];

      const parentRows = explicitParentIds.length === 0
        ? []
        : await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            companyId: issues.companyId,
          })
          .from(issues)
          .where(and(eq(issues.companyId, issue.companyId), inArray(issues.id, explicitParentIds)));
      if (parentRows.length !== explicitParentIds.length) {
        throw unprocessable("Suggested tasks reference parent issues outside this company or issue tree");
      }

      const parentById = new Map(parentRows.map((row) => [row.id, row] as const));
      const createdByClientKey = new Map<string, SuggestTasksResultCreatedTask>();
      const createdWakeTargets: IssueWakeTarget[] = [];

      await db.transaction(async (tx) => {
        const resolvedAt = new Date();
        const [claimed] = await tx
          .update(issueThreadInteractions)
          .set({
            status: "accepted",
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt,
            updatedAt: resolvedAt,
          })
          .where(and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();

        if (!claimed) {
          throw conflict("Interaction has already been resolved");
        }

        for (const task of orderedTasks) {
          const parentIssueId = task.parentClientKey
            ? createdByClientKey.get(task.parentClientKey)?.issueId ?? null
            : task.parentId ?? interaction.payload.defaultParentId ?? issue.id;
          if (!parentIssueId) {
            throw unprocessable(`Unable to resolve parent for suggested task ${task.clientKey}`);
          }

          const { issue: createdIssue } = await issueService(tx as unknown as Db).createChild(parentIssueId, {
            title: task.title,
            description: task.description ?? null,
            status: "todo",
            priority: task.priority ?? "medium",
            assigneeAgentId: task.assigneeAgentId ?? null,
            assigneeUserId: task.assigneeUserId ?? null,
            projectId: task.projectId ?? issue.projectId,
            goalId: task.goalId ?? issue.goalId,
            billingCode: task.billingCode ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.userId ?? null,
          } as Parameters<ReturnType<typeof issueService>["createChild"]>[1]);

          const parentIdentifier = createdByClientKey.get(task.parentClientKey ?? "")?.identifier
            ?? parentById.get(parentIssueId)?.identifier
            ?? null;
          createdByClientKey.set(task.clientKey, {
            clientKey: task.clientKey,
            issueId: createdIssue.id,
            identifier: createdIssue.identifier ?? null,
            title: createdIssue.title,
            parentIssueId,
            parentIdentifier,
          });
          createdWakeTargets.push({
            id: createdIssue.id,
            assigneeAgentId: createdIssue.assigneeAgentId ?? null,
            status: createdIssue.status,
          });
        }

        const [updated] = await tx
          .update(issueThreadInteractions)
          .set({
            result: {
              version: 1,
              createdTasks: [...createdByClientKey.values()],
              ...(skippedClientKeys.length > 0 ? { skippedClientKeys } : {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(issueThreadInteractions.id, interactionId))
          .returning();

        await touchIssue(tx, issue.id);
        current.status = updated.status;
        current.result = updated.result;
        current.resolvedByAgentId = updated.resolvedByAgentId;
        current.resolvedByUserId = updated.resolvedByUserId;
        current.resolvedAt = updated.resolvedAt;
        current.updatedAt = updated.updatedAt;
      });

      return {
        interaction: hydrateInteraction(current),
        createdIssues: createdWakeTargets,
      };
    },

    rejectInteraction: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      input: RejectIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const data = rejectIssueThreadInteractionSchema.parse(input);
      const current = await getPendingInteractionForResolution({ issue, interactionId });
      switch (current.kind) {
        case "suggest_tasks":
          return issueThreadInteractionService(db).rejectSuggestedTasks(issue, interactionId, data, actor, current);
        case "request_confirmation":
          return rejectRequestConfirmation({
            issue,
            current,
            input: data,
            actor,
          });
        default:
          throw unprocessable(`Interactions of kind ${current.kind} cannot be rejected`);
      }
    },

    rejectSuggestedTasks: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      input: RejectIssueThreadInteraction,
      actor: InteractionActor,
      current: IssueThreadInteractionRow,
    ) => {
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "suggest_tasks") {
        throw unprocessable("Only suggest_tasks interactions can be rejected");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const [updated] = await db
        .update(issueThreadInteractions)
        .set({
          status: "rejected",
          result: {
            version: 1,
            rejectionReason: input.reason?.trim() || null,
          },
          resolvedByAgentId: actor.agentId ?? null,
          resolvedByUserId: actor.userId ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      await touchIssue(db, issue.id);
      return hydrateInteraction(updated);
    },

    expireRequestConfirmationsSupersededByComment: async (
      issue: { id: string; companyId: string },
      comment: { id: string; authorUserId?: string | null },
      actor: InteractionActor,
      executor: Pick<Db, "select" | "update"> = db,
    ) => {
      if (!comment.authorUserId) return [];

      const rows = await executor
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
        ));

      const superseded = rows.filter((row) => {
        const interaction = hydrateInteraction(row) as RequestConfirmationInteraction;
        return interaction.payload.supersedeOnUserComment === true;
      });

      if (superseded.length === 0) return [];

      const now = new Date();
      const expired: IssueThreadInteraction[] = [];
      for (const row of superseded) {
        const [updated] = await executor
          .update(issueThreadInteractions)
          .set({
            status: "expired",
            result: {
              version: 1,
              outcome: "superseded_by_comment",
              commentId: comment.id,
            },
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(issueThreadInteractions.id, row.id),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();
        if (updated) expired.push(hydrateInteraction(updated));
      }

      if (expired.length > 0) {
        await touchIssue(executor, issue.id);
      }
      return expired;
    },

    expireStaleRequestConfirmationsForIssueDocument: async (
      issue: { id: string; companyId: string },
      document: { id: string; key: string; latestRevisionId?: string | null; latestRevisionNumber?: number | null } | null,
      actor: InteractionActor,
    ) => {
      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
        ));

      const staleRows = rows.filter((row) => {
        const interaction = hydrateInteraction(row) as RequestConfirmationInteraction;
        const target = interaction.payload.target;
        if (!target || target.type !== "issue_document") return false;
        const targetIssueId = target.issueId ?? issue.id;
        if (targetIssueId !== issue.id) return false;
        if (document && target.documentId && target.documentId !== document.id) return false;
        if (document && target.key !== document.key) return false;
        if (!document) return true;
        return (
          target.revisionId !== document.latestRevisionId
          || (target.revisionNumber != null && target.revisionNumber !== document.latestRevisionNumber)
        );
      });

      if (staleRows.length === 0) return [];

      const now = new Date();
      const expired: IssueThreadInteraction[] = [];
      for (const row of staleRows) {
        const interaction = hydrateInteraction(row) as RequestConfirmationInteraction;
        const target = interaction.payload.target ?? null;
        const currentTarget = buildIssueDocumentTargetFromDocument({
          issueId: issue.id,
          document,
        });
        const [updated] = await db
          .update(issueThreadInteractions)
          .set({
            status: "expired",
            payload: currentTarget
              ? {
                  ...interaction.payload,
                  target: currentTarget,
                }
              : interaction.payload,
            result: {
              version: 1,
              outcome: "stale_target",
              staleTarget: target,
            },
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(issueThreadInteractions.id, row.id),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();
        if (updated) expired.push(hydrateInteraction(updated));
      }

      if (expired.length > 0) {
        await touchIssue(db, issue.id);
      }
      return expired;
    },

    answerQuestions: async (issue: { id: string; companyId: string }, interactionId: string, input: RespondIssueThreadInteraction, actor: InteractionActor) => db.transaction(async tx => {
      const connection = tx as unknown as Db;
      // Lock company before issue, matching brief publication and job creation.
      await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, issue.companyId)).for('update');
      await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for('update');
      return answerQuestions(connection, issue, interactionId, input, actor);
    }),

    cancelQuestions: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      input: CancelIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const data = cancelIssueThreadInteractionSchema.parse(input);
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Interaction not found");
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "ask_user_questions") {
        throw unprocessable("Only ask_user_questions interactions can be cancelled");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const reason = data.reason?.trim() || null;
      const [updated] = await db
        .update(issueThreadInteractions)
        .set({
          status: "cancelled",
          result: {
            version: 1,
            answers: [],
            cancelled: true,
            cancellationReason: reason,
            summaryMarkdown: null,
          },
          resolvedByAgentId: actor.agentId ?? null,
          resolvedByUserId: actor.userId ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      await touchIssue(db, issue.id);
      return hydrateInteraction(updated);
    },
  };
}
