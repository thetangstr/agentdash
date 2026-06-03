// AgentDash: MCP Client (AGE-107)
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  registerMcpServerSchema,
  callMcpToolSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { mcpClientService } from "../services/mcp-client.js";

export function mcpClientRoutes(db: Db) {
  const router = Router();
  const svc = mcpClientService(db);

  // -------------------------------------------------------------------------
  // Register an MCP server
  // -------------------------------------------------------------------------

  /**
   * POST /companies/:companyId/connectors/mcp/register
   *
   * Register a new MCP server. Validates connectivity by discovering tools.
   * The server URL, auth, and discovered tools are stored as a connection
   * with provider "mcp".
   */
  router.post(
    "/companies/:companyId/connectors/mcp/register",
    validate(registerMcpServerSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const result = await svc.register(companyId, actor.actorType, actor.actorId, {
        serverUrl: req.body.serverUrl,
        authType: req.body.authType,
        authValue: req.body.authValue,
        displayName: req.body.displayName,
        autonomy: req.body.autonomy,
        visibility: req.body.visibility,
      });

      res.status(201).json(result);
    },
  );

  // -------------------------------------------------------------------------
  // List discovered tools for an MCP connection
  // -------------------------------------------------------------------------

  /**
   * GET /companies/:companyId/connectors/mcp/:connectionId/tools
   *
   * Returns the cached list of tools discovered from the MCP server.
   */
  router.get(
    "/companies/:companyId/connectors/mcp/:connectionId/tools",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const tools = await svc.listTools(req.params.connectionId as string);
      res.json({ tools });
    },
  );

  // -------------------------------------------------------------------------
  // Refresh tools (re-discover from server)
  // -------------------------------------------------------------------------

  /**
   * POST /companies/:companyId/connectors/mcp/:connectionId/refresh
   *
   * Re-discovers tools from the MCP server and updates the cached list.
   * If the server is unreachable, returns cached tools with a warning.
   */
  router.post(
    "/companies/:companyId/connectors/mcp/:connectionId/refresh",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const tools = await svc.refreshTools(req.params.connectionId as string);
      res.json({ tools });
    },
  );

  // -------------------------------------------------------------------------
  // Call an MCP tool
  // -------------------------------------------------------------------------

  /**
   * POST /companies/:companyId/connectors/mcp/:connectionId/call
   *
   * Invoke a tool on the MCP server. Gated by autonomy settings and
   * audited with the acting-as identity.
   */
  router.post(
    "/companies/:companyId/connectors/mcp/:connectionId/call",
    validate(callMcpToolSchema),
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const companyId = req.params.companyId as string;

      const result = await svc.callTool(
        companyId,
        req.params.connectionId as string,
        req.body.agentId,
        req.body.toolName,
        req.body.arguments,
      );

      if (!result.success) {
        res.status(result.isError ? 502 : 403).json(result);
        return;
      }

      res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Health check — single connection
  // -------------------------------------------------------------------------

  /**
   * GET /companies/:companyId/connectors/mcp/:connectionId/health
   *
   * Ping the MCP server and return health status + latency.
   */
  router.get(
    "/companies/:companyId/connectors/mcp/:connectionId/health",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const result = await svc.healthCheck(req.params.connectionId as string);
      res.json(result);
    },
  );

  // -------------------------------------------------------------------------
  // Health check — all MCP connections in a company
  // -------------------------------------------------------------------------

  /**
   * GET /companies/:companyId/connectors/mcp/health
   *
   * Ping all registered MCP servers in the company and return health.
   */
  router.get(
    "/companies/:companyId/connectors/mcp/health",
    async (req, res) => {
      assertCompanyAccess(req, req.params.companyId as string);
      const results = await svc.healthCheckAll(req.params.companyId as string);
      res.json({ servers: results });
    },
  );

  // -------------------------------------------------------------------------
  // Remove an MCP server
  // -------------------------------------------------------------------------

  /**
   * DELETE /companies/:companyId/connectors/mcp/:connectionId
   *
   * Revoke and remove the MCP server connection.
   */
  router.delete(
    "/companies/:companyId/connectors/mcp/:connectionId",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      await svc.remove(
        req.params.connectionId as string,
        actor.actorType,
        actor.actorId,
      );

      res.json({ ok: true });
    },
  );

  return router;
}
