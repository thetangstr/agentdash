import { Router } from "express";
import type { Db } from "@agentdash/db";
import {
  approveAgentPlanSchema,
  createAgentPlanSchema,
  goalInterviewPayloadSchema,
  listAgentPlansQuerySchema,
  rejectAgentPlanSchema,
  updateAgentPlanProposalSchema,
} from "@agentdash/shared";
import { validate } from "../middleware/validate.js";
import { agentPlansService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentPlanRoutes(db: Db) {
  const router = Router();
  const svc = agentPlansService(db);

  router.get("/companies/:companyId/agent-plans", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = listAgentPlansQuerySchema.safeParse(req.query);
    const filters = parsed.success ? parsed.data : {};
    const result = await svc.list(companyId, filters);
    res.json(result);
  });

  router.get("/companies/:companyId/agent-plans/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    const plan = await svc.getById(companyId, id);
    res.json(plan);
  });

  router.post(
    "/companies/:companyId/agent-plans",
    validate(createAgentPlanSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const plan = await svc.create(companyId, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        agentId: actor.agentId ?? undefined,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "agent_plan.created",
        entityType: "agent_plan",
        entityId: plan.id,
        details: { goalId: plan.goalId, archetype: plan.archetype },
      });
      res.status(201).json(plan);
    },
  );

  // AgentDash (AGE-48 Phase 2): editor-drawer PATCH. Accepts a partial
  // update to an already-proposed plan (agents, KPIs, budget, rationale,
  // sub-goal suggestions). Approving/rejecting freezes the payload, so a
  // PATCH against a non-proposed plan 422s from the service layer.
  router.patch(
    "/companies/:companyId/agent-plans/:id",
    validate(updateAgentPlanProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const plan = await svc.updateProposal(companyId, id, req.body);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "plan.edited",
        entityType: "agent_plan",
        entityId: plan.id,
        details: { fields: Object.keys(req.body ?? {}), goalId: plan.goalId },
      });
      res.json(plan);
    },
  );

  router.post(
    "/companies/:companyId/agent-plans/:id/approve",
    validate(approveAgentPlanSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      if (actor.actorType !== "user") {
        res.status(403).json({ error: "Only users can approve agent plans" });
        return;
      }
      const result = await svc.approve(companyId, id, actor.actorId, req.body.decisionNote);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "agent_plan.approved",
        entityType: "agent_plan",
        entityId: result.plan.id,
        details: { createdAgentIds: result.createdAgentIds },
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/agent-plans/:id/reject",
    validate(rejectAgentPlanSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      if (actor.actorType !== "user") {
        res.status(403).json({ error: "Only users can reject agent plans" });
        return;
      }
      const plan = await svc.reject(companyId, id, actor.actorId, req.body.decisionNote);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "agent_plan.rejected",
        entityType: "agent_plan",
        entityId: plan.id,
        details: { decisionNote: req.body.decisionNote },
      });
      res.json(plan);
    },
  );

  // AGE-41: Chief of Staff dynamic plan generation.
  // Accepts an interview payload for a goal and returns a bespoke
  // AgentTeamPlanPayload scored against the 8-dimension rubric. The response
  // is cached per (goalId, interview-hash) so repeat taps of "Generate plan"
  // are cheap.
  router.post(
    "/companies/:companyId/goals/:goalId/generate-plan",
    validate(goalInterviewPayloadSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const goalId = req.params.goalId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await svc.generatePlan(companyId, goalId, req.body);
      if ("error" in result) {
        res.status(422).json({
          error: result.error,
          rubric: result.rubric ?? null,
        });
        return;
      }
      if (!result.cached) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "agent_plan.generated",
          entityType: "goal",
          entityId: goalId,
          details: {
            archetype: result.archetype,
            rubricAverage: result.rubric.average,
            rubricMinimum: result.rubric.minimum,
            passesAPlus: result.rubric.passesAPlus,
            interviewHash: result.interviewHash,
          },
        });
      }
      res.json(result);
    },
  );

  return router;
}
