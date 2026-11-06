// AgentDash: Fred's owner workflow. No model calls on GET or setup.
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { fredSetupSchema, fredBriefSchema, fredStartSchema, isUuidLike } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { fredService, type FredActor } from "../services/fred.js";
import type { heartbeatService } from "../services/heartbeat.js";

export function fredRoutes(db: Db, options: { heartbeat?: Pick<ReturnType<typeof heartbeatService>, "wakeup"> } = {}) {
  const router = Router();
  const service = fredService(db, options);
  const base = "/companies/:companyId/fred";
  function owner(req: Request): { companyId: string; actor: FredActor } {
    assertCompanyAccess(req, req.params.companyId as string);
    if (req.actor.type !== "board") throw forbidden("Fred's setup and adoption brief require a company administrator.");
    // A borrowed assistant identity is not a native human setup decision.
    // Supporting delegated setup later requires the normal typed action/confirmation contract.
    if (req.actor.source === "assistant_grant") throw forbidden("Open AgentDash directly as a company administrator to configure Fred.");
    const companyId = req.params.companyId as string;
    if (!isUuidLike(companyId)) throw badRequest("Invalid company ID");
    const trustedLocal = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
    const userId = req.actor.userId ?? (trustedLocal ? "local-board" : null);
    if (!userId) throw unauthorized("Sign in to use Fred");
    return { companyId, actor: { userId, trustedLocal, syntheticLocalOwner: req.actor.source === "local_implicit" } };
  }
  router.get(`${base}`, async (req, res) => {
    const { companyId, actor } = owner(req);
    res.json(await service.workspace(companyId, actor));
  });
  router.post(`${base}/setup`, validate(fredSetupSchema), async (req, res) => {
    const { companyId, actor } = owner(req);
    res.json(await service.setup(companyId, req.body, actor));
  });
  router.put(`${base}/brief`, validate(fredBriefSchema), async (req, res) => {
    const { companyId, actor } = owner(req);
    res.json(await service.saveBrief(companyId, req.body, actor));
  });
  router.post(`${base}/start`, validate(fredStartSchema), async (req, res) => {
    const { companyId, actor } = owner(req);
    res.json(await service.start(companyId, req.body, actor));
  });
  return router;
}
