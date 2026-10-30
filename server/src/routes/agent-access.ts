import { Router } from "express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { badRequest, forbidden, notFound } from "../errors.js";
import {
  AGENT_ACCESS_DEFAULT_WINDOW_DAYS,
  buildAgentAccessInventory,
  loadAgentAccessInventoryInput,
} from "../services/agent-access-inventory.js";
import {
  assertAgentPerformanceReader,
  isEvaluatorPrincipal,
  viewerProjectScope,
} from "../services/agent-performance-authz.js";
import { isEffectivePerformanceManager } from "../services/performance-manager.js";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import { agentVisibilityParam } from "./visibility.js";

/**
 * AgentDash: Agent Performance Management gate 1 — the read-only access inventory.
 *
 *   GET /api/companies/:companyId/agents/:agentId/access
 *     Board only: the agent visible to the viewer, and the viewer is a company
 *     admin/owner, an instance admin, the agent's accountable person or its
 *     active steward. Agents get 403.
 *   GET /api/agents/me/access
 *     Agent only: the caller's own inventory, plus `performanceManager` (APM
 *     gate 4). Board callers and the read-only evaluator principal get 403.
 *
 * Nothing here writes: no activity row, no refusal row, no materialized
 * default. The 403s are thrown directly rather than through the refusal
 * reporter for that reason; the company boundary keeps its shared guard.
 */
export function agentAccessRoutes(db: Db) {
  const router = Router();
  // Agent visibility (2026-09-30): an agent the actor cannot see is 404 here too.
  router.param("agentId", agentVisibilityParam(db));

  /** `windowDays`: integer 1–365, default 30. */
  function parseWindowDays(req: Request): number {
    const raw = req.query.windowDays;
    if (raw === undefined) return AGENT_ACCESS_DEFAULT_WINDOW_DAYS;
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > 365) {
      throw badRequest("windowDays must be an integer from 1 to 365");
    }
    return value;
  }

  /**
   * The inventory as this viewer may see it: restricted projects the viewer
   * can't read never appear by title or id (services/agent-performance-authz.ts).
   */
  async function inventory(req: Request, companyId: string, agentId: string, windowDays: number) {
    const input = await loadAgentAccessInventoryInput(db, { companyId, agentId, windowDays, viewer: viewerProjectScope(req, companyId) });
    if (!input) throw notFound("Agent not found");
    return buildAgentAccessInventory(input);
  }

  router.get("/companies/:companyId/agents/:agentId/access", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Agents read their own access at GET /api/agents/me/access");
    }
    const windowDays = parseWindowDays(req);
    // An agent id from another company is nonexistent here, before any
    // authority question is asked about it.
    const inCompany = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!inCompany) throw notFound("Agent not found");
    // AgentDash (APM gate 1): the one reader rule shared with the projection.
    await assertAgentPerformanceReader(db, req, companyId, agentId);
    res.json(await inventory(req, companyId, agentId, windowDays));
  });

  router.get("/agents/me/access", async (req, res) => {
    assertAuthenticated(req);
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId) {
      throw forbidden("Agent authentication required");
    }
    if (isEvaluatorPrincipal(req)) {
      throw forbidden("The evaluator principal has no access inventory");
    }
    const windowDays = parseWindowDays(req);
    const companyId = req.actor.companyId;
    const agentId = req.actor.agentId;
    // AgentDash (APM gate 4): whether the caller is the company's performance manager.
    res.json({ ...(await inventory(req, companyId, agentId, windowDays)), performanceManager: await isEffectivePerformanceManager(db, companyId, agentId) });
  });

  return router;
}
