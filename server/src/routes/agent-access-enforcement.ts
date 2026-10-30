import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  AGENT_ACCESS_ENFORCEMENT_MODES,
  updateAgentAccessEnforcementSchema,
  type AgentAccessEnforcementMode,
  type AgentAccessEnforcementUpdateResult,
  type AgentAccessEnforcementView,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { getAgentAccessEnforcementMode } from "../services/agent-access-check.js";
import { insertActivity, publishActivity, type ActivityPublication } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdministrator, getActorInfo } from "./authz.js";

/**
 * AgentDash: Agent Performance Management gate 2 (P2.3), gate 3 (P3.4) — how
 * V2 access rules run for a company's agents (access LLD §4, §7).
 *
 *   GET   /api/companies/:companyId/agent-access-enforcement
 *     Any principal with access to the company (members and its agents).
 *   PATCH /api/companies/:companyId/agent-access-enforcement  { mode: "off" | "shadow" | "enforce" }
 *     Company owners/admins only (board actors). A change is recorded as
 *     `company.agent_access_enforcement_changed` { from, to }.
 *
 * `shadow` logs would-be refusals and refuses nothing; `enforce` refuses at
 * every access LLD §4 row (gate 3). MK V1 checks run unchanged in every mode.
 */
function view(companyId: string, mode: AgentAccessEnforcementMode): AgentAccessEnforcementView {
  return { companyId, mode, selectableModes: [...AGENT_ACCESS_ENFORCEMENT_MODES] };
}

export function agentAccessEnforcementRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  async function requireCompany(companyId: string) {
    const row = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
  }

  router.get("/companies/:companyId/agent-access-enforcement", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await requireCompany(companyId);
    res.json(view(companyId, await getAgentAccessEnforcementMode(db, companyId)));
  });

  router.patch(
    "/companies/:companyId/agent-access-enforcement",
    validate(updateAgentAccessEnforcementSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      await assertCompanyAdministrator(
        access,
        req,
        companyId,
        "Only a company owner or admin can change how agent access rules are checked",
      );
      await requireCompany(companyId);
      const requested = req.body.mode as AgentAccessEnforcementMode;

      const actor = getActorInfo(req);
      // The mode and its activity row are one unit; the live event goes out
      // only after commit.
      const { previous, publication } = await db.transaction(async (tx) => {
        const current = await tx
          .select({ mode: companies.agentAccessEnforcement })
          .from(companies)
          .where(eq(companies.id, companyId))
          .for("update")
          .then((rows) => rows[0]?.mode ?? "off");
        if (current === requested) return { previous: current, publication: null as ActivityPublication | null };
        await tx
          .update(companies)
          .set({ agentAccessEnforcement: requested, updatedAt: new Date() })
          .where(eq(companies.id, companyId));
        const inserted = await insertActivity(tx, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "company.agent_access_enforcement_changed",
          entityType: "company",
          entityId: companyId,
          details: { from: current, to: requested },
        });
        return { previous: current, publication: inserted };
      });
      if (publication) publishActivity(publication);
      const result: AgentAccessEnforcementUpdateResult = {
        ...view(companyId, requested),
        changed: previous !== requested,
        previousMode: previous,
      };
      res.json(result);
    },
  );

  return router;
}
