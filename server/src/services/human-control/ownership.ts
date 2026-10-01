// AgentDash: narrow canonical ownership authority (native agent configuration and stewardship).
import type { Request } from 'express';
import { agents, type Db } from '@paperclipai/db';
import { conflict, forbidden } from '../../errors.js';
import { assertBoard, assertCompanyAccess, getActorInfo } from '../../routes/authz.js';
import { accessService } from '../access.js';
import { agentAccountabilityService, normalizeAgentAutonomy, accountabilityLabel } from '../agent-accountability.js';
import { agentStewardshipService } from '../agent-stewardships.js';
import { agentGovernanceService } from '../agent-governance.js';
import { logActivity, insertActivity } from '../activity-log.js';
import { assertActivityAcceptance, type ActivityAcceptance } from '../activity-log.js';

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
