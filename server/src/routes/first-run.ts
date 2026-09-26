// AgentDash (GH #786, UX-5): the hosted first run.
//
//   GET  /api/companies/:companyId/first-run              any company member: which step is next
//   POST /api/companies/:companyId/first-run/first-issue  instance admin, company owner or admin
//
// The first issue is created in the connected repo's project, assigned to an
// engineer (hired when none exists, within the Free agent cap), and the
// assignee is woken so a run starts right away.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { firstRunService, FirstRunCapError, type FirstRunDeps } from "../services/first-run.js";
import { heartbeatService } from "../services/heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { assertCompanyAccess, assertCompanyAdministrator, isCompanyAdministrator } from "./authz.js";

export interface FirstRunRouteDeps extends FirstRunDeps {
  heartbeat?: IssueAssignmentWakeupDeps;
  logActivity?: typeof logActivity;
}

export function firstRunRoutes(db: Db, deps: FirstRunRouteDeps = {}) {
  const router = Router();
  const svc = firstRunService(db, deps);
  const access = accessService(db);
  const log = deps.logActivity ?? logActivity;
  let heartbeat = deps.heartbeat ?? null;
  const getHeartbeat = () => (heartbeat ??= heartbeatService(db));

  router.get("/companies/:companyId/first-run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = await svc.status(companyId);
    res.json({
      ...status,
      canManage: req.actor.type === "board" && (await isCompanyAdministrator(access, req, companyId)),
    });
  });

  router.post("/companies/:companyId/first-run/first-issue", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertCompanyAdministrator(access, req, companyId, "Only a workspace owner or admin can start the first issue.");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorUserId = req.actor.userId ?? null;
    let result: Awaited<ReturnType<typeof svc.createFirstIssue>>;
    try {
      result = await svc.createFirstIssue(companyId, { title: body.title, description: body.description }, actorUserId);
    } catch (error) {
      if (error instanceof FirstRunCapError) {
        res.status(402).json(error.payload);
        return;
      }
      throw error;
    }
    const { issue, created, hiredAgentId } = result;
    if (created) {
      if (hiredAgentId) {
        await log(db, {
          companyId,
          actorType: "user",
          actorId: actorUserId ?? "unknown",
          action: "agent.created",
          entityType: "agent",
          entityId: hiredAgentId,
          agentId: hiredAgentId,
          details: { source: "first_run", role: "engineer" },
        });
      }
      await log(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId ?? "unknown",
        action: "issue.created",
        entityType: "issue",
        entityId: issue.id,
        details: { title: issue.title, identifier: issue.identifier, source: "first_run" },
      });
      void queueIssueAssignmentWakeup({
        heartbeat: getHeartbeat(),
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "first_run",
        requestedByActorType: "user",
        requestedByActorId: actorUserId,
      });
    }
    res.status(created ? 201 : 200).json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        projectId: issue.projectId,
        assigneeAgentId: issue.assigneeAgentId,
      },
      created,
      hiredAgentId,
    });
  });

  return router;
}
