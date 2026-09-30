// AgentDash: narrow canonical ownership actions shared with the human transport.
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { agents, companyMemberships, type Db } from '@paperclipai/db';
import { z } from 'zod';
import { assignAgentStewardshipSchema, transferAgentStewardshipSchema, humanJsonSchema, type HumanOperationDescriptor } from '@paperclipai/shared';
import { conflict, forbidden, notFound } from '../../errors.js';
import { assertBoard, assertCompanyAccess, getActorInfo } from '../../routes/authz.js';
import { accessService } from '../access.js';
import { agentService } from '../agents.js';
import { agentAccountabilityService, normalizeAgentAutonomy, accountabilityLabel } from '../agent-accountability.js';
import { agentStewardshipService } from '../agent-stewardships.js';
import { agentGovernanceService } from '../agent-governance.js';
import { logActivity, insertActivity } from '../activity-log.js';
import type { HumanOperation } from '../human-control.js';
import { assertActivityAcceptance, type ActivityAcceptance } from '../workforce.js';
import { humanCompany } from './workforce.js';

export async function assertOwnershipManagement(db: Db, req: Request, companyId: string, deniedMessage = 'Agent stewardship management requires agent creation permission') {
  assertBoard(req);
  if (req.actor.source === 'local_implicit' || req.actor.isInstanceAdmin) return;
  assertCompanyAccess(req, companyId);
  if (!await accessService(db).canUser(companyId, req.actor.userId, 'agents:create')) throw forbidden(deniedMessage);
}
export async function agentConfigurationAuthority(db: Db, req: Request, target: { id: string; companyId: string }): Promise<'admin' | 'steward'> {
  assertCompanyAccess(req, target.companyId);
  const authority = await agentGovernanceService(db).resolveConfigurationAuthority(target.companyId, target.id, req.actor);
  if (authority) return authority;
  await assertOwnershipManagement(db, req, target.companyId, 'Missing permission: agents:create');
  return 'admin';
}
export async function resolveAccountabilityPatch(db: Db, req: Request, existing: typeof agents.$inferSelect, patch: Record<string, unknown>) {
  const currentAutonomy = normalizeAgentAutonomy(existing.autonomy);
  const nextAutonomy = Object.hasOwn(patch, 'autonomy') ? normalizeAgentAutonomy(patch.autonomy) : currentAutonomy;
  const requestedAccountable = typeof patch.accountableUserId === 'string' ? patch.accountableUserId.trim() : null;
  const accountability = agentAccountabilityService(db);
  if (nextAutonomy === 'autonomous') {
    const activeSteward = await agentStewardshipService(db).activeByAgent(existing.companyId, existing.id);
    if (activeSteward) {
      const steward = await accountability.resolveForAgent(existing.companyId, existing.id);
      throw conflict(`${existing.name} is stewarded by ${accountabilityLabel(steward) ?? activeSteward.userId}. End that stewardship first if this agent should run without a person; making it autonomous would revoke their connect code and channel binding.`);
    }
    const resolved = requestedAccountable ?? existing.accountableUserId ?? (req.actor.type === 'board' ? req.actor.userId ?? null : null);
    if (!resolved) throw conflict('An autonomous agent needs a human who is accountable for it. Pass accountableUserId.');
    await accountability.assertAccountableMember(existing.companyId, resolved);
    return { autonomy: nextAutonomy, accountableUserId: resolved };
  }
  if (requestedAccountable) throw conflict('A stewarded agent takes its accountable human from its steward, so accountableUserId cannot be set on one. Assign the stewardship instead, or make the agent autonomous.');
  return { autonomy: nextAutonomy, accountableUserId: null };
}
export async function recordAccountabilityChange(db: Db, req: Request, existing: typeof agents.$inferSelect, agent: typeof agents.$inferSelect, acceptance?: ActivityAcceptance) {
  const actor = getActorInfo(req);
  if (acceptance !== undefined) assertActivityAcceptance(acceptance);
  const input = { companyId: agent.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId, action: 'agent.accountability_changed', entityType: 'agent', entityId: agent.id, details: { fromAutonomy: normalizeAgentAutonomy(existing.autonomy), toAutonomy: normalizeAgentAutonomy(agent.autonomy), fromAccountableUserId: existing.accountableUserId ?? null, toAccountableUserId: agent.accountableUserId ?? null } };
  if (acceptance) acceptance.publications.push(await insertActivity(acceptance.executor, input));
  else await logActivity(db, input);
}
export function ownershipHumanOperations(): HumanOperation[] {
  const id = z.string().uuid(), userId = z.string().trim().min(1).max(256);
  const inputs = {
    'human_questions.owner.assign': z.object({ agentId: id, accountableUserId: userId }).strict(),
    'human_questions.stewardship.assign': assignAgentStewardshipSchema,
    'human_questions.stewardship.transfer': transferAgentStewardshipSchema.extend({ agentId: id }).strict(),
  };
  const output = z.object({ agentId: id, userId, stewardshipId: id.nullable() }).strict();
  return Object.entries(inputs).map(([operationId, input]): HumanOperation => ({
    descriptor: { operationId: operationId as HumanOperationDescriptor['operationId'], version: 1, pageId: 'workforce', actionId: operationId.slice('human_questions.'.length), targetKind: 'company', behavior: 'prepare_confirm', authority: 'agent_management', confirmation: 'human_readback', inputSchema: humanJsonSchema(input), outputSchema: humanJsonSchema(output), content: { fullText: true, pagination: 'none' } },
    input, output,
    companyAccess: operationId === 'human_questions.owner.assign' ? 'canonical' : 'instance_admin_stewardship',
    authorize: ctx => assertOwnershipManagement(ctx.db, ctx.req, humanCompany(ctx)),
    async resolve(ctx, p) {
      const companyId = humanCompany(ctx);
      if (ctx.lock && typeof p.userId === 'string') await ctx.db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, p.userId))).for('update');
      const query = ctx.db.select().from(agents).where(and(eq(agents.id, p.agentId as string), eq(agents.companyId, companyId)));
      const [agent] = await (ctx.lock ? query.for('update') : query);
      if (!agent) throw notFound('Agent not found');
      const svc = agentStewardshipService(ctx.db), active = await svc.activeByAgent(companyId, agent.id);
      if (operationId === 'human_questions.owner.assign') {
        if (await agentConfigurationAuthority(ctx.db, ctx.req, agent) !== 'admin') throw forbidden('Only agent administrators may change accountability');
        await resolveAccountabilityPatch(ctx.db, ctx.req, agent, { accountableUserId: p.accountableUserId });
      } else {
        await agentAccountabilityService(ctx.db).assertAccountableMember(companyId, p.userId as string);
        if (agent.status === 'terminated' || normalizeAgentAutonomy(agent.autonomy) === 'autonomous') throw conflict('Stewardship requires an active stewarded agent');
        const assigned = await svc.activeByUser(companyId, p.userId as string);
        if (assigned && assigned.agentId !== agent.id) throw conflict('This person already stewards another agent');
        if (operationId.endsWith('.assign') && active && active.userId !== p.userId) throw conflict('Agent already has a steward; use transfer');
        if (operationId.endsWith('.transfer') && (!active || active.userId === p.userId)) throw conflict('Active stewardship must change');
      }
      return { payload: p, readback: { agent: { id: agent.id, name: agent.name }, previousUserId: active?.userId ?? agent.accountableUserId, nextUserId: p.userId ?? p.accountableUserId, effects: [operationId.endsWith('.transfer') ? 'Transfer stewardship, recording history and revoking prior stewardship endpoints and channel authority through the canonical service.' : 'Assign the displayed accountable human. Existing pending questions keep their pinned owner until explicitly cancelled and replaced.'] }, preconditions: { agentUpdatedAt: agent.updatedAt.toISOString(), stewardshipId: active?.id ?? null } };
    },
    async currentOutput(ctx, p) {
      const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, p.agentId as string), eq(agents.companyId, humanCompany(ctx))));
      if (!agent) throw notFound('Agent not found');
      const active = await agentStewardshipService(ctx.db).activeByAgent(humanCompany(ctx), agent.id);
      return { agentId: agent.id, userId: operationId === 'human_questions.owner.assign' ? agent.accountableUserId : active?.userId, stewardshipId: operationId === 'human_questions.owner.assign' ? null : active?.id };
    },
    async execute(ctx, p) {
      const companyId = humanCompany(ctx), svc = agentStewardshipService(ctx.db);
      if (operationId !== 'human_questions.owner.assign') {
        const row = operationId.endsWith('.assign') ? await svc.assign(companyId, { agentId: p.agentId as string, userId: p.userId as string, assignedByUserId: ctx.req.actor.userId! }, ctx.acceptance, ctx.beforeWrite) : await svc.transfer(companyId, p.agentId as string, { userId: p.userId as string, transferReason: p.transferReason as string, transferredByUserId: ctx.req.actor.userId! }, ctx.acceptance, ctx.beforeWrite);
        return { agentId: row.agentId, userId: row.userId, stewardshipId: row.id };
      }
      const [existing] = await ctx.db.select().from(agents).where(and(eq(agents.id, p.agentId as string), eq(agents.companyId, companyId))).for('update');
      if (!existing) throw notFound('Agent not found');
      const patch = await resolveAccountabilityPatch(ctx.db, ctx.req, existing, { accountableUserId: p.accountableUserId });
      const updated = await agentService(ctx.db).update(existing.id, patch, { beforeWrite: ctx.beforeWrite, recordRevision: { createdByAgentId: null, createdByUserId: ctx.req.actor.userId!, source: 'patch' } });
      if (!updated) throw notFound('Agent not found');
      ctx.acceptance!.publications.push(await insertActivity(ctx.acceptance!.executor, { companyId, actorType: 'user', actorId: ctx.req.actor.userId!, action: 'agent.updated', entityType: 'agent', entityId: updated.id, details: { changedTopLevelKeys: Object.keys(patch).sort() } }));
      await recordAccountabilityChange(ctx.db, ctx.req, existing, updated, ctx.acceptance);
      return { agentId: updated.id, userId: updated.accountableUserId!, stewardshipId: null };
    },
  }));
}
