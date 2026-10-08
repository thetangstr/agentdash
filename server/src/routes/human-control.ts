import { ownershipHumanOperations } from "../services/human-control/ownership.js";
import { questionHumanOperations } from "../services/human-control/questions.js";
import { taskRecoveryHumanOperations } from "../services/human-control/task-recovery.js";
// AgentDash: trusted local human bridge; canonical REST authority is unchanged.
import { z } from 'zod';
import { Router, type Request } from 'express';
import type { Db } from '@paperclipai/db';
import { eq } from 'drizzle-orm';
import { issues } from '@paperclipai/db';
import { humanConfirmRequestSchema, humanDiscoverRequestSchema, humanOperationRequestSchema,
  taskRecoveryAuthorizeRunPreviewSchema, taskRecoveryAuthorizeRunSchema } from '@paperclipai/shared';
import { notFound } from '../errors.js';
import { isCanonicalUuid } from './visibility.js';
import { humanControlService } from '../services/human-control.js';
import { workforceHumanOperations } from '../services/human-control/workforce.js';
import { heartbeatService } from '../services/heartbeat.js';
export function humanControlRoutes(db: Db, options: { heartbeat?: Pick<ReturnType<typeof heartbeatService>, 'wakeup' | 'enqueueTaskRecoveryPermitRun' | 'dispatchQueuedRunsForAgent'> } = {}) {
  const router = Router();
  const heartbeat = options.heartbeat ?? heartbeatService(db);
  const svc = humanControlService(db, [...workforceHumanOperations(heartbeat), ...questionHumanOperations(heartbeat), ...ownershipHumanOperations(), ...taskRecoveryHumanOperations(heartbeat)]);
  router.get('/identity', async (req, res) => res.json(await svc.identity(req)));
  router.post('/discover', async (req, res) => {
    const input = humanDiscoverRequestSchema.parse(req.body);
    res.json(await svc.discover(req, input.target, input.pageId, input));
  });
  router.post('/read', async (req, res) => res.json(await svc.read(req, humanOperationRequestSchema.parse(req.body))));
  router.post('/prepare', async (req, res) => res.json(await svc.prepare(req, humanOperationRequestSchema.parse(req.body))));
  router.post('/confirm', async (req, res) => res.json(await svc.confirm(req, humanConfirmRequestSchema.parse(req.body))));

  // AgentDash (GH #891): "Authorize one run" for a signed-in board user in
  // the web app. Same task_recovery.remediate operation (authority, locks,
  // permit, bound run) as the board-key prepare/confirm path above; the
  // service refuses board keys, assistant grants, agents and the implicit
  // local operator. Preview is the readback; authorize must echo its
  // preconditions unchanged.
  async function recoveryTarget(req: Request, issueId: string) {
    if (!isCanonicalUuid(issueId)) throw notFound('Issue not found');
    const [issue] = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
    if (!issue) throw notFound('Issue not found');
    // Do not confirm another company's issue exists.
    if (req.actor.type !== 'board' || (!req.actor.isInstanceAdmin && !(req.actor.companyIds ?? []).includes(issue.companyId))) {
      throw notFound('Issue not found');
    }
    return { kind: 'company' as const, companyId: issue.companyId };
  }
  // AgentDash: browser recovery uses the same finite operations as human MCP.
  // Session apply consumes fresh readback preconditions. On unknown outcomes,
  // read the durable cancellation/replacement before any further user action.
  router.get('/issues/:issueId/question-recovery', async (req, res) => {
    const issueId = req.params.issueId as string, target = await recoveryTarget(req, issueId);
    res.json(await svc.sessionRead(req, { target, operationId: 'human_questions.recovery.list', version: 1, input: { issueId } }));
  });
  const questionRecoveryInput = z.object({ interactionId: z.string().uuid(), action: z.enum(['cancel', 'replace']) }).strict();
  router.post('/issues/:issueId/question-recovery/preview', async (req, res) => {
    const issueId = req.params.issueId as string, target = await recoveryTarget(req, issueId);
    const { action, interactionId } = questionRecoveryInput.parse(req.body);
    res.json(await svc.sessionPreview(req, { target, operationId: action === 'cancel' ? 'human_questions.recovery.cancel' : 'human_questions.replace', version: 1, input: { issueId, interactionId } }));
  });
  router.post('/issues/:issueId/question-recovery/confirm', async (req, res) => {
    const issueId = req.params.issueId as string, target = await recoveryTarget(req, issueId);
    const { action, interactionId, preconditions } = questionRecoveryInput.extend({ preconditions: z.record(z.unknown()) }).strict().parse(req.body);
    res.json(await svc.sessionApply(req, { target, operationId: action === 'cancel' ? 'human_questions.recovery.cancel' : 'human_questions.replace', version: 1, input: { issueId, interactionId }, preconditions }));
  });
  router.post('/issues/:issueId/recovery-run/preview', async (req, res) => {
    const issueId = req.params.issueId as string;
    const body = taskRecoveryAuthorizeRunPreviewSchema.parse(req.body ?? {});
    const target = await recoveryTarget(req, issueId);
    res.json(await svc.sessionPreview(req, { target, operationId: 'task_recovery.remediate', version: 1, input: { issueId, ...body } }));
  });
  router.post('/issues/:issueId/recovery-run/authorize', async (req, res) => {
    const issueId = req.params.issueId as string;
    const { preconditions, ...body } = taskRecoveryAuthorizeRunSchema.parse(req.body ?? {});
    const target = await recoveryTarget(req, issueId);
    res.json(await svc.sessionApply(req, { target, operationId: 'task_recovery.remediate', version: 1, input: { issueId, ...body }, preconditions }));
  });
  return router;
}
