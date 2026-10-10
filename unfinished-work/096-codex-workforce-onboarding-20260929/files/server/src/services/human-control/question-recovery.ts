// AgentDash: narrowly authorized metadata/cancellation; private rows never leave this service.
import type { Request } from 'express';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { agents, agentStewardships, companyMemberships, issues, issueThreadInteractions, projects, workforceEnrollments, type Db } from '@paperclipai/db';
import { resolveWorkforceTemplate, humanJsonSchema, questionRecoveryCancelInputSchema, questionRecoveryListInputSchema, questionRecoveryListSchema, questionRecoveryReceiptSchema,
  type AskUserQuestionsInteraction, type QuestionRecoveryList, type QuestionRecoveryReceipt } from '@paperclipai/shared';
import { badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { assertProjectVisible } from '../../routes/visibility.js';
import { hydrateInteraction, issueThreadInteractionService, resolveQuestionCreateInput, selectWorkforceQuestionOwner, type QuestionWriteGuards } from '../issue-thread-interactions.js';
import { insertActivity } from '../activity-log.js';
import type { ActivityAcceptance } from '../workforce.js';
import type { HumanOperation } from '../human-control.js';
import { questionReplacement } from './authority.js';
import { humanCompany } from './workforce.js';

type Reader = Pick<Db, 'select'>;
// Preserve database precision; Date's millisecond projection cannot pin a microsecond row.
const exactUpdatedAt = sql<string>`to_char(${issueThreadInteractions.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export async function recoveryIssue(reader: Reader, req: Request, companyId: string, issueId: string) {
  if (req.actor.type !== 'board' || !req.actor.userId?.trim()) throw forbidden('Named active human required');
  const [member] = await reader.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, req.actor.userId), eq(companyMemberships.status, 'active')));
  if (!member) throw forbidden('Named active company member required');
  const [issue] = await reader.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  if (!issue || issue.hiddenAt) throw notFound('Issue not found');
  if (issue.projectId) {
    const [project] = await reader.select().from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, companyId)));
    if (!project) throw notFound('Project not found');
    await assertProjectVisible(reader, req, project);
  }
  return issue;
}
export async function recoveryQuestion(reader: Reader, req: Request, companyId: string, issueId: string, interactionId: string, allowCancelled = false) {
  const issue = await recoveryIssue(reader, req, companyId, issueId);
  const [stored] = await reader.select({ row: issueThreadInteractions, updatedAt: exactUpdatedAt }).from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.id, interactionId)));
  if (!stored || stored.row.kind !== 'ask_user_questions') throw notFound('Recovery question not found');
  let q: AskUserQuestionsInteraction;
  try { q = hydrateInteraction(stored.row) as AskUserQuestionsInteraction; }
  catch { throw notFound('Recovery question not found'); } // Persisted private validation values must not become public errors.
  if ((q.status !== 'pending' && !(allowCancelled && q.status === 'cancelled')) || !q.payload.answerOwnerUserId || (q.status === 'pending' && q.payload.answerOwnerUserId === req.actor.userId) || !q.payload.workforceAgentId || !q.payload.questions.some(value => value.required)) throw notFound('Recovery question not found');
  const selection = await selectWorkforceQuestionOwner(reader, issue, q.payload);
  if (!selection.agentId || selection.owner !== req.actor.userId || ['done','cancelled'].includes(issue.status)) throw notFound('Recovery question not found');
  const [enrollment] = await reader.select().from(workforceEnrollments).where(and(eq(workforceEnrollments.companyId, companyId), eq(workforceEnrollments.agentId, selection.agentId)));
  if (!enrollment || !resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion) || (selection.branch === 'prior' && (enrollment.id !== q.payload.workforceEnrollmentId || enrollment.templateId !== q.payload.workforceTemplateId || enrollment.templateVersion !== q.payload.workforceTemplateVersion))) throw notFound('Recovery question not found');
  // A cancelled receipt depends on current replacement authority, not the former membership.
  const [oldMembership] = q.status === 'pending' ? await reader.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, q.payload.answerOwnerUserId))) : [];
  if (q.status === 'pending' && oldMembership?.status === 'active') throw notFound('Recovery question not found');
  if (q.status === 'cancelled') {
    const next = await resolveQuestionCreateInput(reader, issue, questionReplacement(q), { userId: req.actor.userId });
    if (next.kind !== 'ask_user_questions' || next.payload.answerOwnerUserId !== req.actor.userId) throw notFound('Recovery question not found');
  }
  const [ownerAgent] = await reader.select({ id: agents.id, accountableUserId: agents.accountableUserId, autonomy: agents.autonomy, updatedAt: agents.updatedAt }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, selection.agentId)));
  if (!ownerAgent) throw notFound('Recovery question not found');
  const stewardships = await reader.select({ id: agentStewardships.id, userId: agentStewardships.userId, updatedAt: agentStewardships.updatedAt }).from(agentStewardships).where(and(eq(agentStewardships.companyId, companyId), eq(agentStewardships.agentId, selection.agentId), isNull(agentStewardships.endedAt))).orderBy(asc(agentStewardships.id));
  const ownerPin = { branch: selection.branch, owner: selection.owner, agent: { ...ownerAgent, updatedAt: ownerAgent.updatedAt.toISOString() }, stewardships: stewardships.map(value => ({ ...value, updatedAt: value.updatedAt.toISOString() })) };
  return { issue, q, selection, enrollment, oldMembership, ownerPin, updatedAt: stored.updatedAt };
}
export function recoveryReceipt(issueId: string, interactionId: string): QuestionRecoveryReceipt {
  return { issueId, interactionId, status: 'cancelled', replacementRequired: true };
}
export async function listQuestionRecovery(reader: Reader, req: Request, companyId: string, raw: Record<string, unknown>, observe?: (value: Awaited<ReturnType<typeof recoveryQuestion>>) => Promise<void>): Promise<QuestionRecoveryList> {
  const input = questionRecoveryListInputSchema.parse(raw);
  await recoveryIssue(reader, req, companyId, input.issueId);
  const ids = input.interactionId ? [{ id: input.interactionId }] : await reader.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, input.issueId), eq(issueThreadInteractions.kind, 'ask_user_questions'), eq(issueThreadInteractions.status, 'pending'))).orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id));
  const eligible: QuestionRecoveryList['items'] = [];
  for (const { id } of ids) {
    let value: Awaited<ReturnType<typeof recoveryQuestion>>;
    try { value = await recoveryQuestion(reader, req, companyId, input.issueId, id, Boolean(input.interactionId)); }
    catch (error) { if (!input.interactionId && (error as {status?:number}).status === 404) continue; throw error; }
    await observe?.(value);
    eligible.push(value.q.status === 'cancelled' ? recoveryReceipt(input.issueId, id) : { issueId: input.issueId, interactionId: id, status: 'pending', updatedAt: value.updatedAt, reason: 'original_owner_unavailable' });
  }
  const cursorIndex = input.cursor ? eligible.findIndex(value => value.interactionId === input.cursor) : -1;
  if (input.cursor && cursorIndex < 0) throw badRequest('Recovery cursor is no longer authorized; refresh metadata');
  const start = cursorIndex + 1, items = eligible.slice(start, start + input.limit);
  return { items, nextCursor: start + items.length < eligible.length ? items.at(-1)!.interactionId : null };
}
export async function cancelQuestionRecovery(executor: Db, req: Request, companyId: string, input: Record<string, unknown>, acceptance: ActivityAcceptance, guards: QuestionWriteGuards) {
  const p = questionRecoveryCancelInputSchema.parse(input);
  const selected = await recoveryQuestion(executor, req, companyId, p.issueId, p.interactionId);
  const check = async (same: Db, issue: { id: string; companyId: string }) => {
    await guards.assertSource?.(same, issue);
    const current = await recoveryQuestion(same, req, companyId, p.issueId, p.interactionId);
    const [matches] = await same.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, current.q.id), sql`${issueThreadInteractions.updatedAt} = ${p.expectedUpdatedAt}::timestamptz`));
    if (!matches) throw conflict('Recovery question changed; inspect current metadata');
  };
  await issueThreadInteractionService(executor).cancelQuestions(selected.issue, selected.q.id, { reason: 'Original answer owner unavailable; replacement and genuine answer required.' }, { userId: req.actor.userId! }, acceptance, { assertSource: check, beforeWrite: guards.beforeWrite });
  acceptance.publications.push(await insertActivity(executor, { companyId, actorType: 'user', actorId: req.actor.userId!, action: 'issue.thread_interaction_cancelled', entityType: 'issue', entityId: p.issueId, details: { interactionId: p.interactionId, interactionKind: 'ask_user_questions', interactionStatus: 'cancelled', reason: 'original_owner_unavailable' } }, guards.beforeWrite));
  return recoveryReceipt(p.issueId, p.interactionId);
}
export function recoveryHumanOperations(): HumanOperation[] {
  const list: HumanOperation = {
    descriptor: { operationId: 'human_questions.recovery.list', version: 1, pageId: 'inbox', actionId: 'recovery.list', targetKind: 'company', behavior: 'read', authority: 'current_question_recovery_owner', confirmation: 'none', inputSchema: humanJsonSchema(questionRecoveryListInputSchema), outputSchema: humanJsonSchema(questionRecoveryListSchema), content: { fullText: true, pagination: 'cursor' } },
    input: questionRecoveryListInputSchema, output: questionRecoveryListSchema, authorize() {},
    async resolve() { throw badRequest('Metadata is a read operation'); },
    read: (ctx, p) => listQuestionRecovery(ctx.db, ctx.req, humanCompany(ctx), p),
  };
  const cancel: HumanOperation = {
    descriptor: { operationId: 'human_questions.recovery.cancel', version: 1, pageId: 'inbox', actionId: 'recovery.cancel', targetKind: 'company', behavior: 'prepare_confirm', authority: 'current_question_recovery_owner', confirmation: 'human_readback', inputSchema: humanJsonSchema(questionRecoveryCancelInputSchema), outputSchema: humanJsonSchema(questionRecoveryReceiptSchema), content: { fullText: true, pagination: 'none' } },
    input: questionRecoveryCancelInputSchema, output: questionRecoveryReceiptSchema, authorize() {},
    async resolve(ctx, p) {
      const value = await recoveryQuestion(ctx.db, ctx.req, humanCompany(ctx), p.issueId as string, p.interactionId as string);
      const [matches] = await ctx.db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, value.q.id), sql`${issueThreadInteractions.updatedAt} = ${p.expectedUpdatedAt}::timestamptz`));
      if (!matches) throw conflict('Recovery question changed; inspect current metadata');
      return { payload: p, preconditions: { updatedAt: value.updatedAt, owner: value.q.payload.answerOwnerUserId, payload: value.q.payload, issueUpdatedAt: value.issue.updatedAt.toISOString(), assigneeAgentId: value.issue.assigneeAgentId, oldMembership: value.oldMembership ? { id: value.oldMembership.id, status: value.oldMembership.status } : null, enrollment: { id: value.enrollment.id, templateId: value.enrollment.templateId, templateVersion: value.enrollment.templateVersion, updatedAt: value.enrollment.updatedAt.toISOString() }, currentOwner: value.ownerPin }, readback: { effects: ['Cancel the unanswered question.', 'Dependent work stays held.', 'A separate replacement and genuine answer are still required.'] } };
    },
    execute: (ctx, p) => cancelQuestionRecovery(ctx.db, ctx.req, humanCompany(ctx), p, ctx.acceptance!, { assertSource: ctx.assertQuestionSource, beforeWrite: ctx.beforeWrite }),
    recoveryReference: value => { const receipt = value as QuestionRecoveryReceipt; return { issueId: receipt.issueId, interactionId: receipt.interactionId }; },
    async afterCommit(_ctx, _p, receipt) { return receipt; }, // no wake: cancellation is not input.
    async currentOutput(ctx, p) {
      const value = await recoveryQuestion(ctx.db, ctx.req, humanCompany(ctx), p.issueId as string, p.interactionId as string, true);
      if (value.q.status !== 'cancelled') throw conflict('Cancellation is not confirmed; inspect current metadata');
      return recoveryReceipt(value.issue.id, value.q.id);
    },
    async authorizeRecovery(ctx, p, reference) {
      const value = await recoveryQuestion(ctx.db, ctx.req, humanCompany(ctx), p.issueId as string, p.interactionId as string, true);
      return value.q.id === reference.interactionId && value.issue.id === reference.issueId ? { issueId: value.issue.id, interactionId: value.q.id } : null;
    },
  };
  return [list, cancel];
}
