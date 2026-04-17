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
        hasClientSecret: !!config.clientSecret,
        syncDirection: config.syncDirection ?? "bidirectional",
        fieldMapping: config.fieldMapping ?? {},
      });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  // Disconnect HubSpot (clears stored config)
  router.delete("/companies/:companyId/integrations/hubspot/config", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await svc.clearConfig(companyId);
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  // Test HubSpot connection
  router.post("/companies/:companyId/integrations/hubspot/test", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.testConnection(companyId);
      res.status(200).json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({ error: err instanceof Error ? err.message : "Internal server error" });
    }
  });

  // Get sync status
  router.get("/companies/:companyId/integrations/hubspot/sync/status", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const status = await svc.getSyncStatus(companyId);
      res.status(200).json(status);
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
  // AgentDash: supports portalId lookup from event payload, falls back to ?companyId query param
  router.post("/webhooks/hubspot", async (req, res) => {
    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];

      // Resolve company: prefer portalId from event payload, fall back to query param
      let companyId = req.query.companyId as string | undefined;
      if (!companyId && events.length > 0) {
        const portalId = String(events[0].portalId ?? "");
        if (portalId) {
          companyId = (await svc.findCompanyByPortalId(portalId)) ?? undefined;
        }
      }

      if (!companyId) {
        res.status(200).json({ received: true, warning: "Could not resolve company" });
        return;
      }

      // Verify signature if client secret is configured
      const config = await svc.getConfig(companyId);
      if (config?.clientSecret) {
        const signature = req.headers["x-hubspot-signature-v3"] as string | undefined;
        const timestamp = req.headers["x-hubspot-request-timestamp"] as string | undefined;
        if (!signature || !timestamp) {
          res.status(401).json({ error: "Missing webhook signature or timestamp" });
          return;
        }
        const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody?.toString() ?? "";
        const requestUri = req.protocol + "://" + req.get("host") + req.originalUrl;
        if (!svc.verifyWebhookSignature(config.clientSecret, rawBody, signature, "POST", requestUri, timestamp)) {
          res.status(401).json({ error: "Invalid webhook signature" });
          return;
        }
      }

      await svc.handleWebhook(companyId, events);
      res.status(200).json({ received: true });
    } catch (err: unknown) {
      res.status(200).json({ received: true, error: err instanceof Error ? err.message : "unknown" });
    }
  });

  return router;
}
