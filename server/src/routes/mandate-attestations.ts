import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { mandatedActionService } from "../services/mandated-action.js";
import { assertCompanyAccess } from "./authz.js";

const runDemoAttestationSchema = z.object({
  mandateId: z.string().uuid(),
  action: z.string().min(1),
});

export function mandateAttestationRoutes(db: Db) {
  const router = Router();
  const svc = mandatedActionService(db);

  router.get("/companies/:companyId/mandate-attestations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const mandateId = typeof req.query.mandateId === "string" ? req.query.mandateId : undefined;
    res.json(await svc.listAttestations(companyId, mandateId));
  });

  router.post("/companies/:companyId/mandate-attestations", validate(runDemoAttestationSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const row = await svc.runDemoAttestation({ companyId, mandateId: req.body.mandateId, action: req.body.action });
      res.status(201).json(row);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "attestation_failed" });
    }
  });

  return router;
}
