import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { updateAgentGovernancePolicySchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { agentGovernanceService } from "../services/agent-governance.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { requireProductProfile } from "../services/companies.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function agentGovernanceRoutes(db: Db) {
  const router = Router();
  const governance = agentGovernanceService(db);
  const stewardships = agentStewardshipService(db);
  const access = accessService(db);

  /**
   * Profile gate. Non-`agentdash_mk` companies must be indistinguishable from a
   * company that does not exist, so this 404s rather than 403s.
   */
  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  async function isAdministrator(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return access.canUser(companyId, req.actor.userId, "agents:create");
  }

  /** Owner/admin only — ceilings are never steward-editable. */
  async function requireCeilingAuthority(req: Request, companyId: string) {
    assertBoard(req);
    if (await isAdministrator(req, companyId)) return;
    throw forbidden("Only a company owner or administrator can change agent policy ceilings");
  }

  /** The agent's current steward, or an administrator acting on their behalf. */
  async function requireRequestAuthority(req: Request, companyId: string, agentId: string) {
    assertBoard(req);
    if (await isAdministrator(req, companyId)) return "admin" as const;
    const active = await stewardships.activeByAgent(companyId, agentId);
    if (active && req.actor.userId && active.userId === req.actor.userId) return "steward" as const;
    throw forbidden("Only the assigned steward or an authorized administrator can configure this agent");
  }

  router.get("/companies/:companyId/agents/:agentId/governance", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await requireProfileCompany(req, companyId);
    await requireRequestAuthority(req, companyId, agentId);
    res.json({ policy: await governance.getForAgent(companyId, agentId) });
  });

  router.put(
    "/companies/:companyId/agents/:agentId/governance/ceiling",
    validate(updateAgentGovernancePolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await requireProfileCompany(req, companyId);
      await requireCeilingAuthority(req, companyId);

      const policy = await governance.updateOwnerCeiling(companyId, agentId, {
        policy: req.body.policy,
        revision: req.body.revision,
        actorUserId: req.actor.userId ?? null,
        channel: req.body.channel ?? "web",
      });
      res.json({ policy });
    },
  );

  router.put(
    "/companies/:companyId/agents/:agentId/governance/request",
    validate(updateAgentGovernancePolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await requireProfileCompany(req, companyId);
      await requireRequestAuthority(req, companyId, agentId);

      const policy = await governance.updateStewardRequest(companyId, agentId, {
        policy: req.body.policy,
        revision: req.body.revision,
        actorUserId: req.actor.userId ?? null,
        channel: req.body.channel ?? "web",
      });
      res.json({ policy });
    },
  );

  return router;
}
