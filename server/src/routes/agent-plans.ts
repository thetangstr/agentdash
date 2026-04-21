import { Router } from "express";
import type { Db } from "@agentdash/db";
import {
  approveAgentPlanSchema,
  createAgentPlanSchema,
  listAgentPlansQuerySchema,
  rejectAgentPlanSchema,
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

  return router;
}
