import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { mandatedActionService } from "../services/mandated-action.js";
import { HttpError } from "../errors.js";
import { assertCanSetCompanyDirection, assertCompanyAccess } from "./authz.js";

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
    // AgentDash (security): runDemoAttestation acts AS the mandate's grantee (and
    // enforcement can pause it), so it needs company-admin authority, not mere
    // board membership. assertBoard alone let any member trigger it.
    assertCanSetCompanyDirection(req, companyId);
    try {
      const row = await svc.runDemoAttestation({ companyId, mandateId: req.body.mandateId, action: req.body.action });
      res.status(201).json(row);
    } catch (err) {
      // AgentDash (security): tenant-binding failures (404) surface as-is.
      if (err instanceof HttpError) throw err;
      console.error("[mandate-attestations] runDemoAttestation failed:", err);
      res.status(400).json({ error: "attestation_failed" });
    }
  });

  return router;
}
