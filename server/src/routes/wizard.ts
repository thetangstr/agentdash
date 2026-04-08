import { Router } from "express";
import type { Db } from "@agentdash/db";
import { projects } from "@agentdash/db";
import { eq } from "drizzle-orm";
import { createAgentWizardSchema } from "@agentdash/shared";
import { wizardService } from "../services/wizard.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { unprocessable } from "../errors.js";

export function wizardRoutes(db: Db) {
  const router = Router();
  const svc = wizardService(db);

  // AgentDash: Create agent via wizard
  router.post(
    "/companies/:companyId/agents/wizard",
    validate(createAgentWizardSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);

      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.companyId, companyId))
        .limit(1);

      if (!project) {
        throw unprocessable("No project found. Create a project first.");
      }

      const result = await svc.createAgent(
        companyId,
        project.id,
        req.body,
        actor.actorId,
      );

      res.status(201).json(result);
    },
  );

  return router;
}
