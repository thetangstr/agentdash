import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { pushAgentDirectivesSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentDirectivesService } from "../services/agent-directives.js";
import { requireProductProfile } from "../services/companies.js";
import { assertCompanyAccess } from "./authz.js";
import { requireActiveStewardHarness } from "./agentdash-mk-harness-auth.js";

/**
 * AgentDash-MK: the harness→agent directives channel.
 *
 * The two failure codes are deliberately different and both matter:
 *
 *   404 — the company is not on the `agentdash_mk` profile. A default-profile
 *   company must be indistinguishable from one that does not exist, so the
 *   feature's existence is not disclosed by probing.
 *
 *   403 — the caller is a real member of a real profile company but is not
 *   this agent's steward. That is an authorization failure about a resource
 *   the caller already knows exists, so hiding it would only make the error
 *   useless.
 */
export function agentDirectivesRoutes(db: Db) {
  const router = Router();
  const directives = agentDirectivesService(db);

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  /**
   * The ACTIVE steward, and only them. Not an administrator acting on their
   * behalf, unlike the governance routes.
   *
   * Ceilings are org policy, so an admin editing them is legitimate. Directives
   * are the steward's own voice to their own agent — the harness's whole claim
   * to write them is that it holds that person's context. An admin pushing
   * directives would be putting words in someone else's agent's mouth with the
   * steward's provenance on the row, and the version history would no longer
   * mean what it says.
   */
  async function requireSteward(req: Request, companyId: string, agentId: string) {
    return requireActiveStewardHarness(
      db,
      req,
      companyId,
      agentId,
      "Only the agent's active steward can push directives",
    );
  }

  router.get("/companies/:companyId/agents/:agentId/directives", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await requireProfileCompany(req, companyId);
    await requireSteward(req, companyId, agentId);
    res.json({
      active: await directives.active(companyId, agentId),
      history: await directives.history(companyId, agentId),
    });
  });

  router.post(
    "/companies/:companyId/agents/:agentId/directives",
    validate(pushAgentDirectivesSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await requireProfileCompany(req, companyId);
      const steward = await requireSteward(req, companyId, agentId);

      // Attributed to the steward principal from the stewardship row, not to
      // whatever the caller claims: the row IS the provenance.
      const directive = await directives.push(companyId, agentId, {
        directives: req.body.directives,
        pushedByUserId: steward.userId,
      });
      res.status(201).json({ directive });
    },
  );

  return router;
}
