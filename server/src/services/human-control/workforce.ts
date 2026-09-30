// AgentDash: canonical workforce actions with full usable source content.
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { agents, goals, issues } from '@paperclipai/db';
import { WORKFORCE_TEMPLATES, humanJsonSchema, supportsWorkforcePrompt, updateWorkforceBriefSchema, enrollWorkforceSchema, updateWorkforceEnrollmentSchema, reviewWorkforceProposalSchema, type HumanOperationDescriptor } from '@paperclipai/shared';
import { assertProjectIdVisible } from '../../routes/visibility.js';
import { assertCanSetCompanyDirection } from '../../routes/authz.js';
import { conflict, notFound, unprocessable } from '../../errors.js';
import { workforceService } from '../workforce.js';
import type { heartbeatService } from '../heartbeat.js';
import type { HumanOperation, HumanOperationContext } from '../human-control.js';
const empty = z.object({}).strict();
const id = z.string().uuid(), text = z.string(), revision = z.number().int().nonnegative();
const agentInput = z.object({ agentId: id }).strict();
const brief = updateWorkforceBriefSchema.omit({ expectedRevision: true }).extend({ revision, confirmedByUserId: text.nullable(), updatedAt: text.nullable() }).strict();
const template = z.object({ id: text, version: z.literal(1), name: text, description: text, responsibilities: z.array(text), requiredFactKeys: z.array(text), procedures: z.array(text), skills: z.array(z.object({ key: text, name: text, description: text, content: text }).strict()), qualityChecks: z.array(text), suggestedMetrics: z.array(text), starterJob: z.object({ title: text, description: text }).strict() }).strict();
const enrollment = z.object({ id, companyId: id, agentId: id, templateId: text, templateVersion: revision, objective: text.nullable(), metrics: z.array(text), goalId: id.nullable(), learnedBriefRevision: revision.nullable(), firstJobIssueId: id.nullable(), installedSkillKeys: z.array(text), skillInstallError: text.nullable(), createdAt: text, updatedAt: text }).strict();
const readiness = z.object({ phase: z.enum(['learning', 'needs_input', 'working', 'awaiting_review', 'ready', 'refresh_needed']), missingFactKeys: z.array(text), pendingQuestionIds: z.array(id), firstJobIssueId: id.nullable(), acceptedVerdictId: id.nullable(), briefRevision: revision, learnedBriefRevision: revision.nullable(), reason: text }).strict();
const proposal = brief.pick({ facts: true, sources: true }).extend({ id, companyId: id, agentId: id, status: z.enum(['proposed', 'approved', 'rejected']), briefRevision: revision, sourceReferences: z.array(text), createdAt: text, reviewedByUserId: text.nullable(), reviewedAt: text.nullable() }).strict();
const job = z.object({ issueId: id, identifier: text.nullable(), title: text, status: text, agentId: id.nullable() }).strict();
export function humanCompany(ctx: HumanOperationContext) {
  if (ctx.target.kind !== 'company') throw new Error('Company operation target required');
  return ctx.target.companyId;
}
export function workforceHumanOperations(heartbeat: Pick<ReturnType<typeof heartbeatService>, 'wakeup'>): HumanOperation[] {
  function operation(operationId: HumanOperationDescriptor['operationId'], input: z.AnyZodObject, output: z.ZodTypeAny, direction: boolean, handler: Pick<HumanOperation, 'read' | 'execute' | 'afterCommit' | 'recoveryReference'>): HumanOperation {
    return {
      descriptor: { operationId, version: 1, pageId: 'workforce', actionId: operationId.slice('workforce.'.length), targetKind: 'company', behavior: handler.read ? 'read' : 'prepare_confirm', authority: direction ? 'company_direction' : 'company_access', confirmation: handler.read ? 'none' : 'human_readback', inputSchema: humanJsonSchema(input), outputSchema: humanJsonSchema(output), content: { fullText: true, pagination: 'none' } },
      input, output, ...handler,
      authorize(ctx) { if (direction) assertCanSetCompanyDirection(ctx.req, humanCompany(ctx)); },
      async currentOutput(ctx, payload) {
        const svc = workforceService(ctx.db), companyId = humanCompany(ctx);
        if (operationId === 'workforce.brief.publish') return svc.getBrief(companyId);
        if (operationId === 'workforce.proposals.review') return (await svc.listProposals(companyId, { userId: ctx.req.actor.userId! })).find(value => value.id === payload.proposalId);
        if (operationId === 'workforce.first_job.start') {
          const current = await svc.getEnrollment(companyId, payload.agentId as string);
          const [issue] = current?.firstJobIssueId ? await ctx.db.select().from(issues).where(and(eq(issues.id, current.firstJobIssueId), eq(issues.companyId, companyId))) : [];
          if (!issue) throw notFound('First job not found');
          return { issueId: issue.id, identifier: issue.identifier, title: issue.title, status: issue.status, agentId: issue.assigneeAgentId };
        }
        return ['workforce.enrollment.create', 'workforce.skills.retry'].includes(operationId)
          ? svc.getInstalledEnrollment(companyId, payload.agentId as string) : svc.getEnrollment(companyId, payload.agentId as string);
      },
      async authorizeRecovery(ctx, payload, reference) {
        if (typeof payload.agentId !== 'string') return null;
        const companyId = humanCompany(ctx);
        const current = await workforceService(ctx.db).getEnrollment(companyId, payload.agentId);
        if (!current) return null;
        if (operationId === 'workforce.first_job.start') {
          if (!current.firstJobIssueId || reference.issueId !== current.firstJobIssueId) return null;
          const [issue] = await ctx.db.select().from(issues).where(and(
            eq(issues.companyId, companyId),
            eq(issues.id, current.firstJobIssueId),
          ));
          if (!issue || issue.hiddenAt) return null;
          await assertProjectIdVisible(ctx.db, ctx.req, companyId, issue.projectId);
          return { issueId: issue.id };
        }
        if (['workforce.enrollment.create', 'workforce.skills.retry'].includes(operationId)
          && reference.enrollmentId === current.id) {
          return { enrollmentId: current.id };
        }
        return null;
      },
      async resolve(ctx, payload) {
        const companyId = humanCompany(ctx), svc = workforceService(ctx.db);
        const current = await svc.getBrief(companyId);
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== current.revision) throw conflict('Company brief revision changed');
        if (payload.revision !== undefined && payload.revision !== current.revision) throw conflict('Acknowledge the current company brief revision');
        const state: Record<string, unknown> = { briefRevision: current.revision };
        const readback: Record<string, unknown> = { effects: operationId === 'workforce.first_job.start'
          ? ['Create or recover the ordinary first-job issue and durably wake its assigned worker; normal budgets, capacity, approvals and run quotas still apply.']
          : ['workforce.enrollment.create', 'workforce.skills.retry'].includes(operationId)
            ? ['Install immutable template skills into the company library and assign them to this worker after enrollment commits; installation failures remain visible and retryable.']
            : ['Apply the displayed fields using the current canonical company permissions.'] };

        if (typeof payload.agentId === 'string') {
          const query = ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, payload.agentId)));
          const [agent] = await (ctx.lock ? query.for('update') : query);
          if (!agent) throw notFound('Agent not found');
          const currentEnrollment = await svc.getEnrollment(companyId, agent.id);
          if (!currentEnrollment && operationId !== 'workforce.enrollment.create') throw notFound('Workforce enrollment not found');
          if (operationId === 'workforce.enrollment.create' && currentEnrollment && payload.templateId !== currentEnrollment.templateId) throw conflict('Workforce template assignment is immutable');
          if (['workforce.enrollment.create', 'workforce.first_job.start'].includes(operationId) && !supportsWorkforcePrompt(agent.adapterType)) throw unprocessable('Unsupported workforce adapter');
          readback.agent = { id: agent.id, name: agent.name };
          readback.template = WORKFORCE_TEMPLATES.find(t => t.id === (currentEnrollment?.templateId ?? payload.templateId)) ?? null;
          state.agentUpdatedAt = agent.updatedAt.toISOString();
          state.enrollmentUpdatedAt = currentEnrollment?.updatedAt.toISOString() ?? null;
          state.templateId = currentEnrollment?.templateId ?? payload.templateId;
          state.templateVersion = currentEnrollment?.templateVersion ?? 1;
        }
        if (typeof payload.goalId === 'string' && !(await ctx.db.select({ id: goals.id }).from(goals).where(and(eq(goals.id, payload.goalId), eq(goals.companyId, companyId))))[0]) throw notFound('Company goal not found');
        if (typeof payload.proposalId === 'string') {
          const found = (await svc.listProposals(companyId, { userId: ctx.req.actor.userId })).find(p => p.id === payload.proposalId);
          if (!found) throw notFound('Company proposal not found');
          if (found.status !== 'proposed') throw conflict('Proposal has already been reviewed');
          if (payload.decision === 'approve' && found.briefRevision !== current.revision) throw conflict('Company sources changed; request a new proposal');
          state.proposal = found;
          readback.proposal = found;
          readback.proposalStatus = 'Worker-proposed facts; approval publishes them as company facts, rejection does not.';
        }
        return { payload, preconditions: state, readback };
      },
    };
  }
  const actor = (ctx: HumanOperationContext) => ({ userId: ctx.req.actor.userId! });
  return [
    operation('workforce.templates.list', empty, z.array(template), false, { read: async () => WORKFORCE_TEMPLATES }),
    operation('workforce.brief.read', empty, brief, false, { read: ctx => workforceService(ctx.db).getBrief(humanCompany(ctx)) }),
    operation('workforce.brief.publish', updateWorkforceBriefSchema, brief, true, { execute: (ctx, p) => workforceService(ctx.db).updateBrief(humanCompany(ctx), updateWorkforceBriefSchema.parse(p), actor(ctx), ctx.acceptance, ctx.beforeWrite) }),
    operation('workforce.proposals.list', empty, z.array(proposal), true, { read: ctx => workforceService(ctx.db).listProposals(humanCompany(ctx), actor(ctx)) }),
    operation('workforce.proposals.review', reviewWorkforceProposalSchema.extend({ proposalId: id }).strict(), proposal, true, { execute: (ctx, p) => workforceService(ctx.db).reviewProposal(humanCompany(ctx), p.proposalId as string, { decision: p.decision as 'approve' | 'reject', expectedRevision: p.expectedRevision as number }, actor(ctx), ctx.acceptance, ctx.beforeWrite) }),
    operation('workforce.enrollment.read', agentInput, enrollment.nullable(), false, { read: (ctx, p) => workforceService(ctx.db).getEnrollment(humanCompany(ctx), p.agentId as string) }),
    operation('workforce.readiness.read', agentInput, readiness.nullable(), false, { read: (ctx, p) => workforceService(ctx.db).getReadiness(humanCompany(ctx), p.agentId as string) }),
    operation('workforce.enrollment.create', enrollWorkforceSchema.extend({ agentId: id }).strict(), enrollment, true, {
      recoveryReference: value => ({ enrollmentId: (value as {id:string}).id }),
      execute: (ctx, p) => { const { agentId, ...body } = p; return workforceService(ctx.db).enroll(humanCompany(ctx), agentId as string, enrollWorkforceSchema.parse(body), actor(ctx), ctx.acceptance, ctx.beforeWrite); },
      afterCommit: (ctx, p, value) => workforceService(ctx.db).ensureSkillsInstalled(humanCompany(ctx), p.agentId as string, actor(ctx), ctx.authority!.skillStages(ctx.db, value as NonNullable<Awaited<ReturnType<ReturnType<typeof workforceService>['getEnrollment']>>>)),
    }),
    operation('workforce.enrollment.update', updateWorkforceEnrollmentSchema.extend({ agentId: id }).strict(), enrollment, true, { execute: (ctx, p) => { const { agentId, ...body } = p; return workforceService(ctx.db).updateEnrollment(humanCompany(ctx), agentId as string, updateWorkforceEnrollmentSchema.parse(body), actor(ctx), ctx.acceptance, ctx.beforeWrite); } }),
    operation('workforce.learning.acknowledge', agentInput.extend({ revision }).strict(), enrollment, true, { execute: (ctx, p) => workforceService(ctx.db).acknowledgeLearning(humanCompany(ctx), p.agentId as string, p.revision as number, actor(ctx), ctx.acceptance, ctx.beforeWrite) }),
    operation('workforce.skills.retry', agentInput, enrollment, true, {
      recoveryReference: value => ({ enrollmentId: (value as { id: string }).id }),
      async execute(ctx, p) {
        const current = await workforceService(ctx.db).getEnrollment(humanCompany(ctx), p.agentId as string);
        if (!current) throw notFound('Workforce enrollment not found');
        return current;
      },
      afterCommit: (ctx, p, value) => workforceService(ctx.db).ensureSkillsInstalled(humanCompany(ctx), p.agentId as string, actor(ctx), ctx.authority!.skillStages(ctx.db, value as NonNullable<Awaited<ReturnType<ReturnType<typeof workforceService>['getEnrollment']>>>)),
    }),
    operation('workforce.first_job.start', agentInput, job, true, {
      recoveryReference: value => ({ issueId: (value as {issue:{id:string}}).issue.id }),
      execute: (ctx, p) => workforceService(ctx.db).startFirstJobWithCreation(humanCompany(ctx), p.agentId as string, actor(ctx), ctx.acceptance, ctx.beforeWrite),
      afterCommit: async (ctx, p, value) => {
        const result = value as Awaited<ReturnType<ReturnType<typeof workforceService>['startFirstJobWithCreation']>>;
        await heartbeat.wakeup(p.agentId as string, { source: 'assignment', reason: 'workforce_first_job', idempotencyKey: `workforce-first-job:${result.issue.id}`, requestedByActorType: 'user', requestedByActorId: ctx.req.actor.userId!, contextSnapshot: { issueId: result.issue.id, forceFreshSession: result.created } });
        return { issueId: result.issue.id, identifier: result.issue.identifier, title: result.issue.title, status: result.issue.status, agentId: result.issue.assigneeAgentId };
      },
    }),
  ];
}
