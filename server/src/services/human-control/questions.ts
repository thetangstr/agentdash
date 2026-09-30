// AgentDash: named owner questions retain their canonical issue/interaction IDs.
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { companyMemberships, issues, issueThreadInteractions } from '@paperclipai/db';
import { askUserQuestionsPayloadSchema, askUserQuestionsQuestionSchema, askUserQuestionsQuestionOptionSchema, askUserQuestionsAnswerSchema, askUserQuestionsResultSchema, humanJsonSchema, type AskUserQuestionsInteraction, type HumanOperationDescriptor } from '@paperclipai/shared';
import { conflict, forbidden, notFound } from '../../errors.js';
import { assertProjectIdVisible } from '../../routes/visibility.js';
import { issueThreadInteractionService } from '../issue-thread-interactions.js';
import { waitingOnYouService } from '../waiting-on-you.js';
import { insertActivity } from '../activity-log.js';
import { workforceService } from '../workforce.js';
import { dispatchResolvedInteractionContinuation } from './question-continuation.js';
import type { heartbeatService } from '../heartbeat.js';
import type { HumanOperation, HumanOperationContext } from '../human-control.js';
import { humanCompany } from './workforce.js';
import { questionReplacement } from './authority.js';
const id = z.string().uuid(), text = z.string();
const reference = z.object({ issueId: id, interactionId: id }).strict();
const answer = askUserQuestionsAnswerSchema.strict();
const question = askUserQuestionsQuestionSchema.innerType().extend({ options: z.array(askUserQuestionsQuestionOptionSchema.strict()).max(10) }).strict();
const payloadSchema = askUserQuestionsPayloadSchema.innerType().extend({ questions: z.array(question).min(1).max(10) }).strict();
const resultSchema = askUserQuestionsResultSchema.extend({ answers: z.array(answer).max(20) }).strict();
const detail = z.object({ interactionId: id, issueId: id, status: text, title: text.nullable(), payload: payloadSchema, result: resultSchema.nullable(), sourceRunId: id.nullable(), sourceCommentId: id.nullable(), continuationPolicy: text }).strict();
const pendingRow = z.object({ interactionId: id, issueId: id, identifier: text.nullable(), issueTitle: text, title: text, questionSummary: text, waitingSince: text, answerOwnerUserId: text, answerOwnerName: text }).strict();
const listInput = z.object({ offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(50) }).strict();
const listOutput = z.object({ questions: z.array(pendingRow), total: z.number().int().min(0), nextOffset: z.number().int().nullable() }).strict();
function project(q: AskUserQuestionsInteraction) {
  return { interactionId: q.id, issueId: q.issueId, status: q.status, title: q.title ?? null, payload: q.payload, result: q.result ?? null, sourceRunId: q.sourceRunId ?? null, sourceCommentId: q.sourceCommentId ?? null, continuationPolicy: q.continuationPolicy };
}
async function visible(ctx: HumanOperationContext, p: Record<string, unknown>, exactOwner = true) {
  const companyId = humanCompany(ctx);
  const query = ctx.db.select().from(issues).where(and(
    eq(issues.companyId, companyId),
    eq(issues.id, p.issueId as string),
  ));
  const [issue] = await (ctx.lock ? query.for('update') : query);
  if (!issue || issue.hiddenAt) throw notFound('Issue not found');

  const [member] = await ctx.db.select().from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId),
    eq(companyMemberships.principalType, 'user'),
    eq(companyMemberships.principalId, ctx.req.actor.userId!),
    eq(companyMemberships.status, 'active'),
  ));
  if (!member) throw forbidden('Active named company membership required');
  await assertProjectIdVisible(ctx.db, ctx.req, companyId, issue.projectId);

  if (ctx.lock) {
    await ctx.db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, p.interactionId as string),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.companyId, companyId),
    )).for('update');
  }
  const q = await issueThreadInteractionService(ctx.db).getById(p.interactionId as string);
  if (!q || q.companyId !== companyId || q.issueId !== issue.id || q.kind !== 'ask_user_questions') {
    throw notFound('Question not found');
  }
  if (exactOwner && q.payload.answerOwnerUserId !== ctx.req.actor.userId) {
    throw forbidden('Only the named human answer owner may access this question');
  }
  return { issue, q };
}
export function questionHumanOperations(heartbeat: Pick<ReturnType<typeof heartbeatService>, 'wakeup'>): HumanOperation[] {
  function operation(operationId: HumanOperationDescriptor['operationId'], input: z.AnyZodObject, output: z.ZodTypeAny, handler: Pick<HumanOperation, 'read' | 'execute' | 'afterCommit'>): HumanOperation {
    return {
      descriptor: { operationId, version: 1, pageId: 'inbox', actionId: operationId.slice('human_questions.'.length), targetKind: 'company', behavior: handler.read ? 'read' : 'prepare_confirm', authority: 'exact_question_owner', confirmation: handler.read ? 'none' : 'human_readback', inputSchema: humanJsonSchema(input), outputSchema: humanJsonSchema(output), content: { fullText: true, pagination: operationId.endsWith('list') ? 'offset' : 'none' } },
      input, output, ...handler, recoveryReference: value => ({ interactionId: (value as {id:string}).id, issueId: (value as {issueId:string}).issueId }), authorize() {},
      async currentOutput(ctx, p) { return project((await visible(ctx, p)).q); },
      async authorizeRecovery(ctx, p, reference) {
        const { issue, q } = await visible(ctx, p);
        if (reference.issueId !== issue.id || reference.interactionId !== q.id) return null;
        return { issueId: issue.id, interactionId: q.id };
      },
      async resolve(ctx, p) {
        const { issue, q } = await visible(ctx, p, operationId !== 'human_questions.replace');
        const svc = issueThreadInteractionService(ctx.db), actor = { userId: ctx.req.actor.userId! };
        const resolved: Record<string, unknown> = { ...p };
        let replacementReadback: unknown = null;
        if (operationId === 'human_questions.respond') {
          const { issueId: _i, interactionId: _q, ...body } = p;
          await svc.previewAnswer(issue, q.id, body as Parameters<typeof svc.previewAnswer>[2], actor, { assertSource: ctx.assertQuestionSource });
          resolved.shareWithCompany = p.shareWithCompany ?? false;
        } else if (operationId === 'human_questions.cancel') {
          if (q.status !== 'pending') throw conflict('Question is no longer pending');
        } else if (operationId === 'human_questions.replace') {
          if (q.status !== 'cancelled') throw conflict('Only cancelled questions may be replaced');
          const next = await svc.previewCreate(issue, questionReplacement(q), actor);
          replacementReadback = next;
          if (next.kind !== 'ask_user_questions' || next.payload.answerOwnerUserId !== actor.userId) throw forbidden('Only the current named answer owner may replace this question');
        }
        return { payload: resolved, readback: { question: project(q), replacement: replacementReadback, sharing: resolved.shareWithCompany === true ? 'Publish eligible known company facts to the company brief.' : 'Keep this answer private to the original issue.', effects: operationId.endsWith('.cancel') ? ['Cancel the question without supplying an answer; required input continues holding dependent work.'] : ['Resolve the original interaction and use its canonical continuation policy; normal run gates still apply.'] }, preconditions: { interactionUpdatedAt: new Date(q.updatedAt).toISOString(), payload: q.payload, issueUpdatedAt: issue.updatedAt.toISOString(), briefRevision: (await workforceService(ctx.db).getBrief(issue.companyId)).revision } };
      },
    };
  }
  async function mutate(ctx: HumanOperationContext, p: Record<string, unknown>, actionId: string, kind: 'respond' | 'cancel' | 'replace') {
    const { issue, q } = await visible(ctx, p, kind !== 'replace');
    const svc = issueThreadInteractionService(ctx.db), actor = { userId: ctx.req.actor.userId! };
    const { issueId: _i, interactionId: _q, ...body } = p;
    const updated = kind === 'respond' ? await svc.answerQuestions(issue, q.id, body as Parameters<typeof svc.answerQuestions>[2], actor, ctx.acceptance, { assertSource: ctx.assertQuestionSource, beforeWrite: ctx.beforeWrite })
      : kind === 'cancel' ? await svc.cancelQuestions(issue, q.id, body, actor, ctx.acceptance, { assertSource: ctx.assertQuestionSource, beforeWrite: ctx.beforeWrite })
      : await svc.create(issue, { ...questionReplacement(q), idempotencyKey: `human-action:${actionId}` }, actor, ctx.acceptance, { assertSource: ctx.assertQuestionSource, beforeWrite: ctx.beforeWrite });
    ctx.acceptance!.publications.push(await insertActivity(ctx.acceptance!.executor, { companyId: issue.companyId, actorType: 'user', actorId: actor.userId, action: `issue.thread_interaction_${kind === 'respond' ? 'answered' : kind === 'cancel' ? 'cancelled' : 'created'}`, entityType: 'issue', entityId: issue.id, details: { interactionId: updated.id, interactionKind: updated.kind, interactionStatus: updated.status } }, ctx.beforeWrite));
    return updated;
  }
  async function afterCommit(ctx: HumanOperationContext, p: Record<string, unknown>, value: unknown) {
    const q = value as AskUserQuestionsInteraction;
    const [issue] = await ctx.db.select().from(issues).where(and(eq(issues.id, p.issueId as string), eq(issues.companyId, humanCompany(ctx))));
    if (issue && q.status !== 'pending') await dispatchResolvedInteractionContinuation({ heartbeat, issue, interaction: q, actor: { actorType: 'user', actorId: ctx.req.actor.userId! }, source: `issue.interaction.${q.status === 'answered' ? 'respond' : 'cancel'}` });
    return project(q);
  }
  return [
    operation('human_questions.pending.list', listInput, listOutput, { read: async (ctx, p) => {
      const result = await waitingOnYouService(ctx.db).pendingQuestions(humanCompany(ctx), ctx.req.actor, { offset: p.offset as number, limit: p.limit as number }, ctx.req);
      return { questions: result.items, total: result.total, nextOffset: (p.offset as number) + result.items.length < result.total ? (p.offset as number) + result.items.length : null };
    } }),
    operation('human_questions.read', reference, detail, { read: async (ctx, p) => project((await visible(ctx, p)).q) }),
    operation('human_questions.respond', reference.extend({ shareWithCompany: z.boolean().default(false), answers: z.array(answer).max(20), summaryMarkdown: text.max(20000).nullable().optional() }).strict(), detail, { execute: (ctx,p,id) => mutate(ctx,p,id,'respond'), afterCommit }),
    operation('human_questions.cancel', reference.extend({ reason: text.trim().max(4000).optional() }).strict(), detail, { execute: (ctx,p,id) => mutate(ctx,p,id,'cancel'), afterCommit }),
    operation('human_questions.replace', reference, detail, { execute: async (ctx,p,id) => project(await mutate(ctx,p,id,'replace') as AskUserQuestionsInteraction) }),
  ];
}
