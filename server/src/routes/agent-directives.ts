import { Router } from "express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { pushAgentDirectivesSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentDirectivesService } from "../services/agent-directives.js";
import { requireProductProfile } from "../services/companies.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { HttpError, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo, isCompanyAdministrator } from "./authz.js";
import {
  agentVisibilityParam,
} from "./visibility.js";
import { requireActiveStewardHarness } from "./agentdash-mk-harness-auth.js";
import { describeRuntimeDirectiveDelivery } from "../adapters/runtime-directives-support.js";

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
  // Agent visibility (2026-09-30): an agent the actor cannot see is 404 here too.
  router.param("agentId", agentVisibilityParam(db));
  const directives = agentDirectivesService(db);

  const access = accessService(db);

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({
        id: companies.id,
        productProfile: companies.productProfile,
        adminDirectiveReadEnabled: companies.adminDirectiveReadEnabled,
      })
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

  /**
   * AgentDash admin powers (part 4.2): READING directives. The steward reads
   * as before. Otherwise an owner or admin may read, never write, when the
   * company switched "admins may read agent directives" on, through their
   * own session (not an assistant grant). This works with no active steward.
   * Every admin read is logged, every time.
   */
  async function requireStewardOrAuditingAdmin(
    req: Request,
    company: { id: string; adminDirectiveReadEnabled: boolean },
    agentId: string,
  ) {
    try {
      await requireSteward(req, company.id, agentId);
      return;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 403) throw err;
      const allowed =
        company.adminDirectiveReadEnabled &&
        req.actor.source !== "assistant_grant" &&
        (await isCompanyAdministrator(access, req, company.id));
      if (!allowed) throw err;
    }
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, company.id)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    const steward = await agentStewardshipService(db).activeByAgent(company.id, agentId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: company.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId,
      runId: actor.runId,
      action: "agent.directives_read_by_admin",
      entityType: "agent",
      entityId: agentId,
      details: { agentId, stewardUserId: steward?.userId ?? null },
    });
  }

  router.get("/companies/:companyId/agents/:agentId/directives", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    const company = await requireProfileCompany(req, companyId);
    await requireStewardOrAuditingAdmin(req, company, agentId);
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

      // AgentDash (AGE-2): say whether the agent's runtime will actually see
      // this. "Pushed" used to mean "stored"; for an adapter that never renders
      // the directives that read as applied when it was not.
      const agentRow = await db
        .select({ adapterType: agents.adapterType })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      const delivery = describeRuntimeDirectiveDelivery(agentRow?.adapterType ?? "unknown");
      res.status(201).json({
        directive,
        delivery,
        ...(delivery.delivered ? {} : { warnings: [delivery.detail] }),
      });
    },
  );

  return router;
}
