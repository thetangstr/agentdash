import { Router } from "express";
import type { Db } from "@agentdash/db";
import { connectorService } from "../services/connectors.js";
import { assertCompanyAccess } from "./authz.js";
import { CONNECTOR_PROVIDER_LABELS, type ConnectorProvider } from "@agentdash/shared";
import { unprocessable } from "../errors.js";

export function connectorRoutes(db: Db) {
  const router = Router();
  const svc = connectorService(db);

  // AgentDash: List connectors for company
  router.get("/companies/:companyId/connectors", async (req, res) => {
    const companyId = req.params.companyId;
    assertCompanyAccess(req, companyId);
    const connectors = await svc.list(companyId);
    res.json(connectors);
  });

  // AgentDash: Initiate OAuth connection
  router.post("/companies/:companyId/connectors/:provider/connect", async (req, res) => {
    const { companyId, provider } = req.params;
    assertCompanyAccess(req, companyId);

    if (!(provider in CONNECTOR_PROVIDER_LABELS)) {
      throw unprocessable(`Unsupported provider: ${provider}`);
    }

    res.json({
      provider,
      message: `OAuth flow for ${CONNECTOR_PROVIDER_LABELS[provider as ConnectorProvider]} not yet configured. Requires app registration.`,
      status: "not_configured",
    });
  });

  // AgentDash: OAuth callback
  router.get("/companies/:companyId/connectors/:provider/callback", async (req, res) => {
    const { companyId, provider } = req.params;
    // TODO: SECURITY — when implementing real OAuth, validate the `state` parameter
    // against a server-side session to prevent CSRF attacks on the callback.
    assertCompanyAccess(req, companyId);
    const { code } = req.query;

    if (!code || typeof code !== "string") {
      res.status(400).json({ error: "Missing authorization code" });
      return;
    }

    res.json({
      provider,
      status: "callback_received",
      message: "Token exchange not yet implemented",
    });
  });

  // AgentDash: Disconnect
  router.delete("/companies/:companyId/connectors/:connectorId", async (req, res) => {
    const { companyId, connectorId } = req.params;
    assertCompanyAccess(req, companyId);
    const result = await svc.disconnect(companyId, connectorId);
    res.json(result);
  });

  return router;
}
