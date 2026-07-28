import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { performMandatedActionSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { mandatedActionService } from "../services/index.js";
import { accessService } from "../services/access.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function mandatedActionRoutes(db: Db) {
  const router = Router();
  const svc = mandatedActionService(db);
  const access = accessService(db);

  router.post("/companies/:companyId/mandated-actions", validate(performMandatedActionSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const granteeAgentId = actor.agentId ?? (req.body.granteeAgentId as string | undefined);
    if (!granteeAgentId) {
      res.status(400).json({ error: "granteeAgentId is required when the caller is not an agent" });
      return;
    }
    // Enforcement can pause the named agent, so a board caller naming someone
    // else's agent needs administrator authority rather than mere membership.
    if (!actor.agentId) {
      const isAdmin =
        req.actor.source === "local_implicit" ||
        req.actor.isInstanceAdmin ||
        (await access.canUser(companyId, req.actor.userId, "agents:create"));
      if (!isAdmin) {
        throw forbidden("Enforcing a mandated action for another agent requires administrator access");
      }
    }
    const result = await svc.enforceMandatedAction({
      companyId,
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
