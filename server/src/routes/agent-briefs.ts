import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { createAgentBriefSchema, submitAgentBriefSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { createAgentBrief, submitAgentBrief } from "../services/agent-briefs.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, assertCompanyAccess, assistantGrantAttribution } from "./authz.js";
import { assertIssueIdVisible } from "./visibility.js";

/**
 * AgentDash: Agent Performance Management gate 5 (P5.1) — start from a brief.
 *
 *   POST /companies/:companyId/agent-briefs                    { title, markdown } → planning issue (backlog, unassigned)
 *   POST /companies/:companyId/agent-briefs/:issueId/submit    assign it to the performance manager (the normal wake)
 *
 * Board users only: a brief is the owner's. Creating one assigns nothing and
 * wakes no one; submitting is an assignment, so it needs `tasks:assign`, as
 * assigning any issue does. Editing the brief is the issue-document revision
 * API (`PUT /api/issues/:issueId/documents/agent-work-brief`); the planner's
 * `scenario-manifest` document is validated there (services/scenario-manifest.ts).
 */
export function agentBriefRoutes(db: Db, options: { pluginWorkerManager?: PluginWorkerManager } = {}) {
  const router = Router();
  const access = accessService(db);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });

  function boardActor(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const { via } = assistantGrantAttribution(req);
    return { userId: req.actor.userId ?? "board", ...(via ? { via } : {}) };
  }

  router.post("/companies/:companyId/agent-briefs", validate(createAgentBriefSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const actor = boardActor(req, companyId);
    res.status(201).json(await createAgentBrief(db, { companyId, title: req.body.title, markdown: req.body.markdown }, actor));
  });

  router.post("/companies/:companyId/agent-briefs/:issueId/submit", validate(submitAgentBriefSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    const actor = boardActor(req, companyId);
    await assertIssueIdVisible(db, req, issueId);
    // The same permission an ordinary assignment needs (issue routes' assertCanAssignTasks).
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      if (!(await access.canUser(companyId, req.actor.userId, "tasks:assign"))) {
        throw forbidden("Missing permission: tasks:assign");
      }
    }
    res.json(await submitAgentBrief(db, heartbeat, { companyId, issueId }, actor));
  });

  return router;
}
