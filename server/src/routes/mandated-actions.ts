import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { performMandatedActionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { mandatedActionService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function mandatedActionRoutes(db: Db) {
  const router = Router();
  const svc = mandatedActionService(db);

  router.post("/companies/:companyId/mandated-actions", validate(performMandatedActionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const granteeAgentId = actor.agentId ?? (req.body.granteeAgentId as string | undefined);
    if (!granteeAgentId) {
      res.status(400).json({ error: "granteeAgentId is required when the caller is not an agent" });
      return;
    }
    const result = await svc.performMandatedAction({
      granteeAgentId,
      mandateId: req.body.mandateId,
      counterpartyDid: req.body.counterpartyDid,
      action: req.body.action,
      payload: req.body.payload,
    });
    res.json(result);
  });

  return router;
}
