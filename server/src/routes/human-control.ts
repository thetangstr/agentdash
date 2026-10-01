import { ownershipHumanOperations } from "../services/human-control/ownership.js";
import { questionHumanOperations } from "../services/human-control/questions.js";
// AgentDash: trusted local human bridge; canonical REST authority is unchanged.
import { Router } from 'express';
import type { Db } from '@paperclipai/db';
import { humanConfirmRequestSchema, humanDiscoverRequestSchema, humanOperationRequestSchema } from '@paperclipai/shared';
import { humanControlService } from '../services/human-control.js';
import { workforceHumanOperations } from '../services/human-control/workforce.js';
import { heartbeatService } from '../services/heartbeat.js';
export function humanControlRoutes(db: Db, options: { heartbeat?: Pick<ReturnType<typeof heartbeatService>, 'wakeup'> } = {}) {
  const router = Router();
  const heartbeat = options.heartbeat ?? heartbeatService(db);
  const svc = humanControlService(db, [...workforceHumanOperations(heartbeat), ...questionHumanOperations(heartbeat), ...ownershipHumanOperations()]);
  router.get('/identity', async (req, res) => res.json(await svc.identity(req)));
  router.post('/discover', async (req, res) => {
    const input = humanDiscoverRequestSchema.parse(req.body);
    res.json(await svc.discover(req, input.target, input.pageId, input));
  });
  router.post('/read', async (req, res) => res.json(await svc.read(req, humanOperationRequestSchema.parse(req.body))));
  router.post('/prepare', async (req, res) => res.json(await svc.prepare(req, humanOperationRequestSchema.parse(req.body))));
  router.post('/confirm', async (req, res) => res.json(await svc.confirm(req, humanConfirmRequestSchema.parse(req.body))));
  return router;
}
