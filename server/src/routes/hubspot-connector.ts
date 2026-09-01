import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { requireProductProfile } from "../services/companies.js";
import {
  HUBSPOT_WRITE_OBJECT_TYPES,
  hubspotConnectorService,
  type HubspotWriteObjectType,
} from "../services/hubspot-connector.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * AgentDash-MK: per-user HubSpot keys.
 *
 * Every route binds to the authenticated caller. There is no `userId`
 * parameter anywhere, for the same reason the channel routes have none: a
 * personal credential that a colleague can attach on your behalf is not a
 * personal credential.
 */
export function hubspotConnectorRoutes(db: Db) {
  const router = Router();
  const hubspot = hubspotConnectorService(db);
  const access = accessService(db);

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  function requireBoardUser(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    return req.actor.userId;
  }

  function requireToken(req: Request): string {
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) throw badRequest("A HubSpot private app token is required");
    return token;
  }

  async function isAdministrator(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return access.canUser(companyId, req.actor.userId, "agents:create");
  }

  /** Connection health for the caller's own key. Never returns the token. */
  router.get("/companies/:companyId/me/connections/hubspot", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const connection = await hubspot.activeConnectionFor(companyId, userId);
    if (!connection) {
      res.json({ connection: null });
      return;
    }
    res.json({
      connection: {
        id: connection.id,
        hubId: connection.accountLabel,
        scopes: connection.scopes,
        status: connection.status,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      },
    });
  });

  router.post("/companies/:companyId/me/connections/hubspot", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const token = requireToken(req);

    const { connectionId, info, sharedPortalWith } = await hubspot.connect(
      companyId,
      userId,
      token,
    );
    res.status(201).json({
      connectionId,
      hubId: info.hubId,
      scopes: info.scopes,
      // Surfaced so "someone else revoked their key and mine stopped working"
      // is not the first time anyone learns two keys share a portal app.
      sharedPortalWith,
    });
  });

  router.post("/companies/:companyId/me/connections/hubspot/rotate", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const token = requireToken(req);

    const { connectionId, info } = await hubspot.rotate(companyId, userId, token);
    res.json({ connectionId, hubId: info.hubId, scopes: info.scopes });
  });

  router.post("/companies/:companyId/me/connections/hubspot/recheck", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    res.json(await hubspot.recheck(companyId, userId));
  });

  router.post("/companies/:companyId/me/connections/hubspot/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const connectionId = await hubspot.revoke(
      companyId,
      userId,
      userId,
      await isAdministrator(req, companyId),
    );
    res.json({ connectionId, revoked: true });
  });

  /**
   * Agent-facing CRM read.
   *
   * Agent-authenticated only. A board user reading the CRM through an agent's
   * ceiling would produce a result the ceiling never authorized, and the whole
   * point of the native path is that the ceiling is load-bearing here.
   */
  router.get("/companies/:companyId/hubspot/:objectType", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);

    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const objectType = req.params.objectType as string;
    if (objectType !== "contacts" && objectType !== "companies" && objectType !== "deals") {
      throw badRequest("objectType must be contacts, companies, or deals");
    }

    const result = await hubspot.readObjects({
      companyId,
      agentId: req.actor.agentId,
      objectType,
      query: typeof req.query.q === "string" ? req.query.q : undefined,
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
    });

    if (!result.ok) {
      // A ceiling refusal is a 403 with a stable reason the agent's prompt
      // knows how to read; it is a normal outcome, not a fault to retry.
      res.status(403).json({ error: result.message, details: { reason: result.reason } });
      return;
    }
    res.json({ results: result.results });
  });

  /**
   * Agent-facing CRM write REQUEST.
   *
   * Returns 202 with an approval id, never a write result. An agent that
   * receives this has not changed the CRM and must not tell a human it has.
   */
  router.post("/companies/:companyId/hubspot/:objectType/write", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);

    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const objectType = req.params.objectType as string;
    if (!HUBSPOT_WRITE_OBJECT_TYPES.includes(objectType as HubspotWriteObjectType)) {
      throw badRequest("objectType must be contacts, companies, or deals");
    }

    const operation = req.body?.operation === "update" ? "update" : "create";
    const properties = req.body?.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      throw badRequest("properties must be an object");
    }

    const result = await hubspot.requestWrite({
      companyId,
      agentId: req.actor.agentId,
      objectType: objectType as HubspotWriteObjectType,
      operation,
      objectId: typeof req.body?.objectId === "string" ? req.body.objectId : null,
      properties: properties as Record<string, unknown>,
    });

    if (!result.ok) {
      res.status(403).json({ error: result.message, details: { reason: result.reason } });
      return;
    }

    // 202: accepted for a human decision, explicitly not performed.
    res.status(202).json({
      approvalId: result.approvalId,
      expiresAt: result.expiresAt.toISOString(),
      status: "pending_steward_approval",
    });
  });

  return router;
}
