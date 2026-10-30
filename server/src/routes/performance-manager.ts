import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  createAgentRecommendationSchema,
  decideAgentRecommendationSchema,
  updatePerformanceManagerSchema,
  type PerformanceManagerUpdateResult,
  type PerformanceManagerView,
} from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { agentAccountabilityService } from "../services/agent-accountability.js";
import { isEvaluatorPrincipal } from "../services/agent-performance-authz.js";
import { resolveEvaluationViewer } from "../services/evaluation/access-class.js";
import { agentCardSnapshotAllowed } from "../services/evaluation/agent-cards.js";
import {
  createAgentRecommendation,
  decideAgentRecommendation,
  isEffectivePerformanceManager,
  listAgentRecommendations,
  performanceManagerRecord,
  resolvePerformanceManager,
  setPerformanceManager,
} from "../services/performance-manager.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdministrator, getActorInfo, isCompanyAdministrator } from "./authz.js";
import { agentVisibilityParam, assertAgentIdVisible, seesEverything, visibleAgentIdsFor } from "./visibility.js";

/**
 * AgentDash: Agent Performance Management gate 4 (P4.1) — the performance
 * manager (overview LLD §4.3; doc/plans/2026-10-29-apm-gate4-5-build-spec.md).
 * Mounted under /api by app.ts. Company-scoped; every mutation writes activity.
 *
 *   GET   /companies/:companyId/performance-manager                                            designation + effective manager (any principal of the company)
 *   PATCH /companies/:companyId/performance-manager                 { agentId | null }          company admins only
 *   POST  /companies/:companyId/evaluation/agents/:agentId/recommendations                     the effective performance manager only
 *   GET   /companies/:companyId/evaluation/agents/:agentId/recommendations                     anyone who can read the agent's card; `viewer.canDecide` runs the decision guard
 *   POST  /companies/:companyId/evaluation/agents/:agentId/recommendations/:id/decision        the agent's accountable person or an admin
 *   GET   /companies/:companyId/evaluation/performance-manager/record[?agentId=]               people; the manager for its own record
 *
 * The manager's card reads (cards, cases, compute) are in
 * `routes/evaluation-agents.ts`; its drafts and proposals go through the gate
 * 2 profile routes. Recommendations are advisory: nothing here pauses,
 * narrows or changes an agent.
 */

const RECOMMEND_FORBIDDEN = "Only the company's performance manager can file recommendations.";
const READ_FORBIDDEN = "Recommendations are read by people and by the company's performance manager.";
const DECIDE_FORBIDDEN = "Only the agent's accountable person or a company admin can record a decision on a recommendation.";
const RECORD_FORBIDDEN = "The performance manager's record is read by people and by the manager itself.";

export function performanceManagerRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  // Agent visibility (2026-09-30): an agent the actor cannot see is 404 here too.
  router.param("agentId", agentVisibilityParam(db));

  async function agentInCompany(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, accountableUserId: agents.accountableUserId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  /** The calling agent when it is the effective performance manager (never the evaluator principal); else null. */
  async function managerAgentOf(req: Request, companyId: string): Promise<string | null> {
    if (req.actor.type !== "agent" || !req.actor.agentId || isEvaluatorPrincipal(req)) return null;
    return (await isEffectivePerformanceManager(db, companyId, req.actor.agentId)) ? req.actor.agentId : null;
  }

  /**
   * The decision route's guard, also behind the list's `viewer.canDecide`: a
   * person (board actor) who is the agent's accountable person (stored or
   * resolved) or a company admin.
   */
  async function mayDecide(req: Request, companyId: string, agent: { id: string; accountableUserId: string | null }): Promise<boolean> {
    if (req.actor.type !== "board") return false;
    const companyAdmin = await isCompanyAdministrator(access, req, companyId);
    const resolved = await agentAccountabilityService(db).resolveForAgent(companyId, agent.id);
    return agentCardSnapshotAllowed(
      { person: true, userId: req.actor.userId ?? null, companyAdmin, dispositionAdmin: companyAdmin || seesEverything(req, companyId) },
      { agentUserId: agent.accountableUserId ?? null, resolvedUserId: resolved?.userId ?? null },
    );
  }

  async function view(req: Request, companyId: string): Promise<PerformanceManagerView> {
    const resolution = await resolvePerformanceManager(db, companyId);
    if (!resolution) throw notFound("Company not found");
    return {
      kind: "performance_manager",
      companyId,
      ...resolution,
      viewer: { canChange: await isCompanyAdministrator(access, req, companyId) },
    };
  }

  router.get("/companies/:companyId/performance-manager", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await view(req, companyId));
  });

  router.patch("/companies/:companyId/performance-manager", validate(updatePerformanceManagerSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    await assertCompanyAdministrator(access, req, companyId, "Only a company owner or admin can choose the performance manager");
    const agentId = (req.body.agentId as string | null) ?? null;
    if (agentId) await assertAgentIdVisible(db, req, agentId);
    const { previousDesignatedAgentId, changed } = await setPerformanceManager(db, { companyId, agentId, actor: getActorInfo(req) });
    const body: PerformanceManagerUpdateResult = { ...(await view(req, companyId)), changed, previousDesignatedAgentId };
    res.json(body);
  });

  router.post(
    "/companies/:companyId/evaluation/agents/:agentId/recommendations",
    validate(createAgentRecommendationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      await agentInCompany(companyId, agentId);
      const managerAgentId = await managerAgentOf(req, companyId);
      if (!managerAgentId) throw forbidden(RECOMMEND_FORBIDDEN);
      const viewer = await resolveEvaluationViewer(db, req, companyId);
      const recommendation = await createAgentRecommendation(db, {
        companyId,
        agentId,
        managerAgentId,
        runId: req.actor.type === "agent" ? (req.actor.runId ?? null) : null,
        viewer,
        body: req.body,
      });
      res.status(201).json(recommendation);
    },
  );

  router.get("/companies/:companyId/evaluation/agents/:agentId/recommendations", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    const agent = await agentInCompany(companyId, agentId);
    // The card readers: people who can see the agent, and the performance manager.
    if (req.actor.type !== "board" && !(await managerAgentOf(req, companyId))) throw forbidden(READ_FORBIDDEN);
    const viewer = await resolveEvaluationViewer(db, req, companyId);
    res.json(await listAgentRecommendations(db, viewer, agentId, { canDecide: await mayDecide(req, companyId, agent) }));
  });

  router.post(
    "/companies/:companyId/evaluation/agents/:agentId/recommendations/:recommendationId/decision",
    validate(decideAgentRecommendationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      const recommendationId = req.params.recommendationId as string;
      assertCompanyAccess(req, companyId);
      const agent = await agentInCompany(companyId, agentId);
      if (!(await mayDecide(req, companyId, agent))) throw forbidden(DECIDE_FORBIDDEN);
      const viewer = await resolveEvaluationViewer(db, req, companyId);
      const actor = getActorInfo(req);
      res.json(
        await decideAgentRecommendation(db, { companyId, agentId, recommendationId, userId: actor.actorId, viewer, body: req.body }),
      );
    },
  );

  router.get("/companies/:companyId/evaluation/performance-manager/record", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const raw = req.query.agentId;
    if (raw !== undefined && typeof raw !== "string") throw badRequest("agentId must be one agent id");
    let managerAgentId: string | null = null;
    if (req.actor.type === "board") {
      if (raw) {
        await assertAgentIdVisible(db, req, raw);
        await agentInCompany(companyId, raw);
        managerAgentId = raw;
      } else {
        managerAgentId = (await resolvePerformanceManager(db, companyId))?.effective?.agentId ?? null;
      }
    } else {
      // An agent reads only its own record, and only while it is the performance manager.
      const self = await managerAgentOf(req, companyId);
      if (!self || (raw && raw !== self)) throw forbidden(RECORD_FORBIDDEN);
      managerAgentId = self;
    }
    if (!managerAgentId) throw notFound("This company has no performance manager");
    const viewer = await resolveEvaluationViewer(db, req, companyId);
    const visibleAgentIds = await visibleAgentIdsFor(db, req, companyId);
    res.json(await performanceManagerRecord(db, { companyId, managerAgentId, viewer, visibleAgentIds }));
  });

  return router;
}
