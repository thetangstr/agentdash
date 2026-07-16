import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { createMandateSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { mandatesService } from "../services/mandates.js";
import { assertCompanyAccess } from "./authz.js";

export function mandateRoutes(db: Db) {
  const router = Router();
  const svc = mandatesService(db);

  router.get("/companies/:companyId/mandates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const granteeAgentId = typeof req.query.granteeAgentId === "string" ? req.query.granteeAgentId : undefined;
    res.json(await svc.listMandates(companyId, granteeAgentId));
  });

  router.post("/companies/:companyId/mandates", validate(createMandateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const b = req.body as import("@paperclipai/shared").CreateMandateRequest;
    const mandate = await svc.createMandate({
      companyId,
      grantorAgentId: b.grantorAgentId,
      granteeAgentId: b.granteeAgentId,
      scope: b.scope,
      permissionKey: b.permissionKey,
      spendCapCents: b.spendCapCents,
      expiresAt: new Date(b.expiresAt),
    });
    res.status(201).json(mandate);
  });

  return router;
}
