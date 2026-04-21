import { Router } from "express";
import type { Db } from "@agentdash/db";
import { createGoalSchema, updateGoalSchema } from "@agentdash/shared";
import { trackGoalCreated } from "@agentdash/shared/telemetry";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  cosReadinessService,
  goalInterviewSessionsService,
  goalService,
  logActivity,
} from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden } from "../errors.js";
import { getTelemetryClient } from "../telemetry.js";

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);

  router.get("/companies/:companyId/goals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  // AgentDash (AGE-50 Phase 1): preconditions check for goal creation.
  // NewGoalDialog calls this on open; disables Create + surfaces a CTA
  // when the company lacks a ready Chief of Staff + adapter path.
  router.get("/companies/:companyId/cos-readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const readiness = await cosReadinessService(db).check(companyId);
    res.json(readiness);
  });

  // AgentDash (AGE-50 Phase 2): interview session lifecycle. The Goal Hub
  // calls GET /latest to decide between "Start" and "Resume" CTAs, and
  // POSTs to /interview-sessions to start-or-resume the session row
  // before opening the chat. The submit_goal_interview tool marks the
  // session completed once a plan is generated.
  router.get(
    "/companies/:companyId/goals/:goalId/interview-sessions/latest",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const goalId = req.params.goalId as string;
      assertCompanyAccess(req, companyId);
      const session = await goalInterviewSessionsService(db).latestForGoal(
        companyId,
        goalId,
      );
      res.json(session);
    },
  );

  router.post(
    "/companies/:companyId/goals/:goalId/interview-sessions",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const goalId = req.params.goalId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      // AgentDash: startedByUserId is a uuid column but the actor's
      // actorId can be a non-uuid sentinel (e.g. `local-board` for the
      // bootstrap implicit actor). Only persist it when it matches the
      // uuid shape — otherwise leave null.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const startedByUserId =
        actor.actorType === "user" && UUID_RE.test(actor.actorId)
          ? actor.actorId
          : null;
      const session = await goalInterviewSessionsService(db).startOrResume(
        companyId,
        goalId,
        startedByUserId,
      );
      res.status(201).json(session);
    },
  );

  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await svc.getById(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);
    res.json(goal);
  });

  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // AgentDash (AGE-49): company-level goals require owner role. Any
    // authenticated member can create team-level goals. Agent callers
    // (adapter keys) are allowed through — plan-driven sub-goal creation
    // inside agentPlansService.approve() also bypasses this since it calls
    // goalService.create directly rather than hitting the HTTP layer.
    if (req.body?.level === "company" && req.actor.type === "board") {
      const userId = req.actor.userId;
      const isInstanceAdmin =
        req.actor.source === "local_implicit" || req.actor.isInstanceAdmin;
      if (!isInstanceAdmin) {
        const access = accessService(db);
        const membership = userId
          ? await access.getMembership(companyId, "user", userId)
          : null;
        if (membership?.membershipRole !== "owner") {
          throw forbidden("Only company owners can create company-level goals");
        }
      }
    }

    const goal = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackGoalCreated(telemetryClient, { goalLevel: goal.level });
    }
    res.status(201).json(goal);
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const goal = await svc.update(id, req.body);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: req.body,
    });

    res.json(goal);
  });

  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const goal = await svc.remove(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });

    res.json(goal);
  });

  return router;
}
