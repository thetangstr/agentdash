import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createMandateSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { mandatesService } from "../services/mandates.js";
import { assertCompanyAccess } from "./authz.js";

const publishMandateSchema = z.object({
  counterpartyCompanyId: z.string().uuid(),
});

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

  // Publish a mandate's terms to a counterparty company.
  router.post("/companies/:companyId/mandates/:mandateId/publish", validate(publishMandateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const row = await svc.publishMandate(companyId, req.params.mandateId as string, req.body.counterpartyCompanyId);
      res.json(row);
    } catch (err) {
      console.error("[mandates] publish failed:", err);
      res.status(400).json({ error: err instanceof Error ? err.message : "publish_failed" });
    }
  });

  // Mandates other companies have published TO this company.
  router.get("/companies/:companyId/incoming-mandates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listIncomingMandates(companyId));
  });

  // Counterparty acceptance — "we can transact".
  router.post("/companies/:companyId/incoming-mandates/:mandateId/accept", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const row = await svc.acceptMandate(companyId, req.params.mandateId as string);
      res.json(row);
    } catch (err) {
      console.error("[mandates] accept failed:", err);
      res.status(400).json({ error: err instanceof Error ? err.message : "accept_failed" });
    }
  });

  return router;
}
