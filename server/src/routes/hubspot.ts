import { Router } from "express";
import type { Db } from "@agentdash/db";
import { hubspotService } from "../services/hubspot.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function hubspotRoutes(db: Db) {
  const router = Router();
  const svc = hubspotService(db);

  // Save HubSpot configuration
  router.post("/companies/:companyId/integrations/hubspot/config", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await svc.setConfig(companyId, req.body);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  // Get HubSpot configuration (redacted token)
  router.get("/companies/:companyId/integrations/hubspot/config", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const config = await svc.getConfig(companyId);
      if (!config) {
        res.status(200).json({ configured: false });
        return;
      }
      res.status(200).json({
        configured: true,
        portalId: config.portalId,
        syncEnabled: config.syncEnabled,
        accessToken: config.accessToken ? `****${config.accessToken.slice(-4)}` : null,
      });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  // Trigger full HubSpot sync
  router.post("/companies/:companyId/integrations/hubspot/sync", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.syncAll(companyId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  // HubSpot webhook receiver
  router.post("/webhooks/hubspot", async (req, res) => {
    try {
      // HubSpot sends an array of events
      const events = Array.isArray(req.body) ? req.body : [req.body];
      // For now, we need the companyId from a header or query param
      const companyId = req.query.companyId as string;
      if (companyId) {
        await svc.handleWebhook(companyId, events);
      }
      res.status(200).json({ received: true });
    } catch (err: unknown) {
      res.status(200).json({ received: true, error: err instanceof Error ? err.message : "unknown" });
    }
  });

  return router;
}
