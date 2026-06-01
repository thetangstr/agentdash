// AgentDash: Connectors (AGE-106)
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createConnectionSchema,
  updateConnectionSchema,
  connectorWorkspaceDefaultsSchema,
  agentConnectorOverridesSchema,
  connectorApprovalDecisionSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { connectorService } from "../services/connectors.js";
import { logActivity } from "../services/activity-log.js";

export function connectorRoutes(db: Db) {
  const router = Router();
  const svc = connectorService(db);

  // -------------------------------------------------------------------------
  // Connection CRUD
  // -------------------------------------------------------------------------

  /** List connections for a company. */
  router.get("/companies/:companyId/connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { provider, status, ownerId } = req.query;
    const result = await svc.list(companyId, {
      provider: typeof provider === "string" ? provider : undefined,
      status: typeof status === "string" ? status : undefined,
      ownerId: typeof ownerId === "string" ? ownerId : undefined,
    });
    res.json(result);
  });

  /** Get a single connection by ID. */
  router.get("/connections/:id", async (req, res) => {
    assertBoard(req);
    const conn = await svc.getById(req.params.id as string);
    if (!conn) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    assertCompanyAccess(req, conn.companyId);
    // Never return encrypted token material to the client
    const { encryptedToken, oauthState, ...safe } = conn;
    res.json(safe);
  });

  /** Create a new connection (after OAuth flow completes). */
  router.post(
    "/companies/:companyId/connections",
    validate(createConnectionSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const created = await svc.create(companyId, {
        ownerType: actor.actorType,
        ownerId: actor.actorId,
        provider: req.body.provider,
        scopes: req.body.scopes,
        sendIdentity: req.body.sendIdentity,
        autonomy: req.body.autonomy,
        visibility: req.body.visibility,
        accountLabel: req.body.accountLabel,
        // Token must be provided server-side (from OAuth callback), not from client
        token: {
          accessToken: "__placeholder__",
        },
      });

      // Strip sensitive fields
      const { encryptedToken, oauthState, ...safe } = created;
      res.status(201).json(safe);
    },
  );

  /** Update a connection's settings. */
  router.patch(
    "/connections/:id",
    validate(updateConnectionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const updated = await svc.update(id, {
        sendIdentity: req.body.sendIdentity,
        autonomy: req.body.autonomy,
        visibility: req.body.visibility,
      });

      if (!updated) {
        res.status(404).json({ error: "Connection not found" });
        return;
      }

      const { encryptedToken, oauthState, ...safe } = updated;
      res.json(safe);
    },
  );

  /** Revoke a connection. */
  router.post("/connections/:id/revoke", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const revoked = await svc.revoke(id, actor.actorType, actor.actorId);
    if (!revoked) {
      res.status(404).json({ error: "Connection not found" });
      return;
    }

    const { encryptedToken, oauthState, ...safe } = revoked;
    res.json(safe);
  });

  // -------------------------------------------------------------------------
  // Workspace defaults
  // -------------------------------------------------------------------------

  /** Get workspace connector defaults. */
  router.get("/companies/:companyId/connector-defaults", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const defaults = await svc.getWorkspaceDefaults(companyId);
    res.json(defaults);
  });

  /** Set workspace connector defaults. */
  router.put(
    "/companies/:companyId/connector-defaults",
    validate(connectorWorkspaceDefaultsSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const updated = await svc.setWorkspaceDefaults(companyId, {
        sendIdentity: req.body.sendIdentity,
        autonomy: req.body.autonomy,
      });
      res.json(updated);
    },
  );

  // -------------------------------------------------------------------------
  // Agent overrides
  // -------------------------------------------------------------------------

  /** Get agent connector overrides. */
  router.get(
    "/companies/:companyId/agents/:agentId/connector-overrides",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const overrides = await svc.getAgentOverrides(
        companyId,
        req.params.agentId as string,
      );
      res.json(overrides ?? { sendIdentity: null, autonomy: null });
    },
  );

  /** Set agent connector overrides. */
  router.put(
    "/companies/:companyId/agents/:agentId/connector-overrides",
    validate(agentConnectorOverridesSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const updated = await svc.setAgentOverrides(
        companyId,
        req.params.agentId as string,
        {
          sendIdentity: req.body.sendIdentity,
          autonomy: req.body.autonomy,
        },
      );
      res.json(updated);
    },
  );

  // -------------------------------------------------------------------------
  // Acting-as resolver (agent-facing)
  // -------------------------------------------------------------------------

  /** Resolve acting-as identity for an agent + action + provider. */
  router.get(
    "/companies/:companyId/connections/resolve",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const { agentId, actionClass, provider } = req.query;

      if (
        typeof agentId !== "string" ||
        typeof actionClass !== "string" ||
        typeof provider !== "string"
      ) {
        res.status(400).json({
          error: "Required query params: agentId, actionClass, provider",
        });
        return;
      }

      const result = await svc.resolveActingAs(
        req.params.companyId as string,
        agentId,
        actionClass as "read" | "draft" | "send",
        provider,
      );
      res.json(result);
    },
  );

  return router;
}
