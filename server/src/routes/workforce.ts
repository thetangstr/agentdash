// AgentDash: workforce mutations that set direction require a human administrator.
import { Router, type Request } from 'express';
import { issues, type Db } from '@paperclipai/db';
import { and, eq } from 'drizzle-orm';
import { WORKFORCE_TEMPLATES, reviewWorkforceProposalSchema, updateWorkforceEnrollmentSchema, updateWorkforceBriefSchema, proposeWorkforceFactsSchema, enrollWorkforceSchema, acknowledgeWorkforceLearningSchema } from '@paperclipai/shared';
import { validate } from '../middleware/validate.js';
import { conflict, forbidden, notFound } from '../errors.js';
import { heartbeatService } from '../services/heartbeat.js';
import { workforceService, type ActivityAcceptance } from '../services/workforce.js';
import { foundationAuthority } from '../services/human-control/authority.js';
import { publishActivity, type ActivityPublication } from '../services/activity-log.js';
import { assertCompanyAccess, assertCanSetCompanyDirection } from './authz.js';
export function workforceRoutes(db: Db, options: { heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup"> } = {}) {
  const router = Router();
  const svc = workforceService(db);
  const heartbeat = options.heartbeat ?? heartbeatService(db);
  const base = '/companies/:companyId/workforce';
  function access(req: Request, agentId?: string) {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (agentId && req.actor.type === 'agent' && req.actor.agentId !== agentId) {
      throw forbidden('Workers may access only their own workforce enrollment');
    }
    return companyId;
  }
  function human(req: Request) {
    const companyId = access(req);
    assertCanSetCompanyDirection(req, companyId);
    return { companyId, actor: { userId: req.actor.userId ?? 'board' } };
  }
  function selfOrHuman(req: Request) {
    const agentId = req.params.agentId as string;
    const companyId = access(req, agentId);
    if (req.actor.type === 'agent') {
      return { companyId, agentId, actor: { agentId } };
    }
    return { ...human(req), agentId };
  }
  async function protectedHuman<T>(req: Request, authority: ReturnType<typeof foundationAuthority>, operationId: string, input: Record<string, unknown>,
    work: (service: ReturnType<typeof workforceService>, acceptance: ActivityAcceptance, beforeWrite: () => void) => Promise<T>, mutation = false) {
    const publications: ActivityPublication[] = [];
    let callbackCompleted = false;
    let result: T;
    try {
      result = await db.transaction(async tx => {
        const executor = tx as unknown as Db;
        const guard = await authority.stage(executor, { companyId: req.params.companyId as string, operationId, input, native: true });
        if (mutation) human(req); else access(req);
        await guard.seal();
        const value = await work(workforceService(executor), { executor, publications }, guard.checkTime);
        if (!mutation) await guard.seal();
        guard.checkTime(); callbackCompleted = true;
        return value;
      });
    } catch (error) {
      if (mutation && callbackCompleted) throw conflict('Workforce persistence is uncertain; inspect current state before retrying', { persistenceOutcome: 'unknown' });
      throw error;
    }
    for (const publication of publications) publishActivity(publication);
    return result;
  }
  async function enrollmentOutput(req: Request, authority: ReturnType<typeof foundationAuthority>, agentId: string) {
    return protectedHuman(req, authority, 'workforce.enrollment.read', { agentId }, service => service.getEnrollment(req.params.companyId as string, agentId));
  }
  router.get(`${base}/templates`, async (req, res) => {
    access(req);
    res.json(WORKFORCE_TEMPLATES);
  });
  router.get(`${base}/brief`, async (req, res) => {
    res.json(await svc.getBrief(access(req)));
  });
  router.put(`${base}/brief`, validate(updateWorkforceBriefSchema), async (req, res) => {
    const { companyId, actor } = human(req);
    res.json(await svc.updateBrief(companyId, req.body, actor));
  });
  router.get(`${base}/proposals`, async (req, res) => {
    const { companyId, actor } = human(req);
    res.json(await svc.listProposals(companyId, actor));
  });
  router.post(`${base}/proposals/:proposalId/review`, validate(reviewWorkforceProposalSchema), async (req, res) => {
    const { companyId, actor } = human(req);
    res.json(await svc.reviewProposal(companyId, req.params.proposalId as string, req.body, actor));
  });
  router.patch(`${base}/agents/:agentId/enrollment`, validate(updateWorkforceEnrollmentSchema), async (req, res) => {
    const { companyId, actor } = human(req);
    const agentId = req.params.agentId as string, authority = foundationAuthority(req);
    await protectedHuman(req, authority, 'workforce.enrollment.update', { ...req.body, agentId }, (service, acceptance, beforeWrite) => service.updateEnrollment(companyId, agentId, req.body, actor, acceptance, beforeWrite), true);
    res.json(await enrollmentOutput(req, authority, agentId));
  });
  router.post(`${base}/proposals`, validate(proposeWorkforceFactsSchema), async (req, res) => {
    const companyId = access(req);
    if (req.actor.type !== 'agent' || !req.actor.agentId) {
      throw forbidden('An agent must propose its own source-backed facts');
    }
    res.status(201).json(await svc.proposeFacts(companyId, req.actor.agentId, req.body));
  });
  router.get(`${base}/agents/:agentId/enrollment`, async (req, res) => {
    const agentId = req.params.agentId as string;
    const companyId = access(req, agentId);
    res.json(req.actor.type === 'agent' ? await svc.getEnrollment(companyId, agentId) : await enrollmentOutput(req, foundationAuthority(req), agentId));
  });
  router.get(`${base}/agents/:agentId/readiness`, async (req, res) => {
    const agentId = req.params.agentId as string;
    const companyId = access(req, agentId);
    res.json(req.actor.type === 'agent' ? await svc.getReadiness(companyId, agentId) : await protectedHuman(req, foundationAuthority(req), 'workforce.readiness.read', { agentId }, service => service.getReadiness(companyId, agentId)));
  });
  router.post(`${base}/agents/:agentId/enrollment`, validate(enrollWorkforceSchema), async (req, res) => {
    const { companyId, actor } = human(req);
    const agentId = req.params.agentId as string;
    const authority = foundationAuthority(req);
    const accepted = await protectedHuman(req, authority, 'workforce.enrollment.create', { ...req.body, agentId }, (service, acceptance, beforeWrite) => service.enroll(companyId, agentId, req.body, actor, acceptance, beforeWrite), true);
    // Enrollment committed before local file registration; failure stays visible and retryable.
    await svc.ensureSkillsInstalled(companyId, agentId, actor, authority.skillStages(db, accepted));
    res.json(await protectedHuman(req, authority, 'workforce.skills.retry', { agentId }, service => service.getInstalledEnrollment(companyId, agentId)));
  });
  router.post(`${base}/agents/:agentId/first-job`, async (req, res) => {
    const { companyId, actor } = human(req);
    const agentId = req.params.agentId as string;
    const authority = foundationAuthority(req);
    const result = await protectedHuman(req, authority, 'workforce.first_job.start', { agentId }, (service, acceptance, beforeWrite) => service.startFirstJobWithCreation(companyId, agentId, actor, acceptance, beforeWrite), true);
    // Repeat requests recover a committed job whose initial dispatch was
    // interrupted. Heartbeat durably deduplicates under the issue lock.
    await heartbeat.wakeup(agentId, { source: 'assignment', reason: 'workforce_first_job', idempotencyKey: `workforce-first-job:${result.issue.id}`, requestedByActorType: 'user', requestedByActorId: actor.userId, contextSnapshot: { issueId: result.issue.id, forceFreshSession: result.created } });
    res.json(await protectedHuman(req, authority, 'workforce.first_job.start', { agentId }, async (_service, acceptance) => {
      return (await acceptance.executor.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, result.issue.id))))[0];
    }));
  });
  router.post(`${base}/agents/:agentId/learned`, validate(acknowledgeWorkforceLearningSchema), async (req, res) => {
    const { companyId, agentId, actor } = selfOrHuman(req);
    if (req.actor.type === 'agent') { res.json(await svc.acknowledgeLearning(companyId, agentId, req.body.revision, actor)); return; }
    const authority = foundationAuthority(req);
    await protectedHuman(req, authority, 'workforce.learning.acknowledge', { agentId, revision: req.body.revision }, (service, acceptance, beforeWrite) => service.acknowledgeLearning(companyId, agentId, req.body.revision, actor, acceptance, beforeWrite), true);
    res.json(await enrollmentOutput(req, authority, agentId));
  });
  router.post(`${base}/agents/:agentId/install-skills`, async (req, res) => {
    const { companyId, actor } = human(req);
    const agentId = req.params.agentId as string, authority = foundationAuthority(req);
    const accepted = await protectedHuman(req, authority, 'workforce.skills.retry', { agentId }, service => service.getEnrollment(companyId, agentId), true);
    if (!accepted) throw notFound('Workforce enrollment not found');
    await svc.ensureSkillsInstalled(companyId, agentId, actor, authority.skillStages(db, accepted));
    res.json(await protectedHuman(req, authority, 'workforce.skills.retry', { agentId }, service => service.getInstalledEnrollment(companyId, agentId)));
  });
  return router;
}
