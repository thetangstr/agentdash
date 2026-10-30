import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import type { AgentPerformanceProjection } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import {
  AGENT_PERFORMANCE_FORBIDDEN_MESSAGE,
  assertAgentPerformanceReader,
  viewerProjectScope,
} from "../services/agent-performance-authz.js";
import {
  PROJECTION_WINDOW_DAYS_DEFAULT,
  PROJECTION_WINDOW_DAYS_MAX,
  buildAgentPerformanceProjection,
  loadAgentPerformanceProjectionInput,
} from "../services/agent-performance-projection.js";
import { assertCompanyAccess } from "./authz.js";
import { agentVisibilityParam, canReadCompanySpend } from "./visibility.js";

/**
 * AgentDash: Agent Performance Management gate 1 — read-only routes.
 *
 *   GET /companies/:companyId/evaluation/agents/:agentId/projection    performance projection (board, restricted)
 *
 * The profile reads (`GET .../agents/:agentId/profile`, `GET /agents/me/profile`)
 * moved to `routes/agent-profiles.ts` in gate 2, where they return the
 * `AgentProfileView` with the derived revision 0 embedded.
 *
 * Nothing here writes: no activity rows, no evaluator snapshots, findings or
 * review items. The route-level refusals below are thrown, not logged, for the
 * same reason; only the shared company-access guard records its own refusals
 * (AGE-91), as it does on every route. Who may read the projection, and which
 * restricted-project work it may show them, come from
 * `services/agent-performance-authz.ts`, shared with the access inventory.
 */

/** `windowDays`: an integer from 1 to 365, default 30. */
export function parseProjectionWindowDays(raw: unknown): number {
  if (raw === undefined) return PROJECTION_WINDOW_DAYS_DEFAULT;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > PROJECTION_WINDOW_DAYS_MAX) {
    throw badRequest(`windowDays must be an integer from 1 to ${PROJECTION_WINDOW_DAYS_MAX}`);
  }
  return value;
}

/**
 * Agent spend follows the existing spend rule (`canReadCompanySpend`, GH #918):
 * a steward or accountable member without `agents:create` does not see it on
 * the agent itself, so the projection must not show it either. Null, never 0,
 * like `redactMonthlySpendForReader`, and named in `withheld`.
 */
export function redactProjectionSpend(projection: AgentPerformanceProjection): AgentPerformanceProjection {
  return {
    ...projection,
    cost: { ...projection.cost, spendCents: null },
    withheld: [
      ...projection.withheld,
      { section: "agent spend", reason: "Spend is shown to company admins and members who can manage agents" },
    ],
  };
}

export function agentPerformanceRoutes(db: Db) {
  const router = Router();
  // Agent visibility (2026-09-30): an agent the actor cannot see is 404 here too.
  router.param("agentId", agentVisibilityParam(db));

  router.get("/companies/:companyId/evaluation/agents/:agentId/projection", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") throw forbidden(AGENT_PERFORMANCE_FORBIDDEN_MESSAGE);
    const windowDays = parseProjectionWindowDays(req.query.windowDays);
    // Another company's agent is nonexistent here (404) before any authority question (403).
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    await assertAgentPerformanceReader(db, req, companyId, agentId);
    const input = await loadAgentPerformanceProjectionInput(db, {
      companyId,
      agentId,
      asOf: new Date(),
      windowDays,
      viewer: viewerProjectScope(req, companyId),
    });
    if (!input) throw notFound("Agent not found");
    const projection = buildAgentPerformanceProjection(input);
    res.json((await canReadCompanySpend(db, req, companyId)) ? projection : redactProjectionSpend(projection));
  });

  return router;
}
