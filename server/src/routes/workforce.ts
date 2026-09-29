// AgentDash: workforce mutations that set direction require a human administrator.
import { Router, type Request } from 'express';
import type { Db } from '@paperclipai/db';
import { WORKFORCE_TEMPLATES, updateWorkforceBriefSchema, proposeWorkforceFactsSchema, enrollWorkforceSchema, acknowledgeWorkforceLearningSchema } from '@paperclipai/shared';
import { validate } from '../middleware/validate.js';
import { forbidden } from '../errors.js';
import { workforceService } from '../services/workforce.js';
import { assertCompanyAccess, assertCanSetCompanyDirection } from './authz.js';
export function workforceRoutes(db: Db) {
  const router = Router();
  const svc = workforceService(db);
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
  router.post(`${base}/proposals`, validate(proposeWorkforceFactsSchema), async (req, res) => {
    const companyId = access(req);
    if (req.actor.type !== 'agent' || !req.actor.agentId) {
      throw forbidden('An agent must propose its own source-backed facts');
    }
    res.status(201).json(await svc.proposeFacts(companyId, req.actor.agentId, req.body));
  });
  router.get(`${base}/agents/:agentId/enrollment`, async (req, res) => {
    const agentId = req.params.agentId as string;
    res.json(await svc.getEnrollment(access(req, agentId), agentId));
  });
  router.get(`${base}/agents/:agentId/readiness`, async (req, res) => {
    const agentId = req.params.agentId as string;
    res.json(await svc.getReadiness(access(req, agentId), agentId));
  });
  router.post(`${base}/agents/:agentId/enrollment`, validate(enrollWorkforceSchema), async (req, res) => {
    const { companyId, actor } = human(req);
    const agentId = req.params.agentId as string;
    await svc.enroll(companyId, agentId, req.body, actor);
    // Enrollment committed before local file registration; failure stays visible and retryable.
    res.json(await svc.ensureSkillsInstalled(companyId, agentId, actor));
  });
  router.post(`${base}/agents/:agentId/first-job`, async (req, res) => {
    const { companyId, actor } = human(req);
    res.json(await svc.startFirstJob(companyId, req.params.agentId as string, actor));
  });
  router.post(`${base}/agents/:agentId/learned`, validate(acknowledgeWorkforceLearningSchema), async (req, res) => {
    const { companyId, agentId, actor } = selfOrHuman(req);
    res.json(await svc.acknowledgeLearning(companyId, agentId, req.body.revision, actor));
  });
  router.post(`${base}/agents/:agentId/install-skills`, async (req, res) => {
    const { companyId, actor } = human(req);
    res.json(await svc.ensureSkillsInstalled(companyId, req.params.agentId as string, actor));
  });
  return router;
}
