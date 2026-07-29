import { Router } from "express";
import type { Request } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { requireProductProfile } from "../services/companies.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/** Statuses a human can still act on. */
const OPEN_APPROVAL_STATUSES = ["pending", "revision_requested"];

export function agentdashMkInboxRoutes(db: Db) {
  const router = Router();
  const stewardships = agentStewardshipService(db);
  const access = accessService(db);

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  function requireBoardUser(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    return req.actor.userId;
  }

  /**
   * Normalized inbox item. Carries everything a decision surface needs —
   * including the `revision` the decider must echo back — so the client never
   * has to guess or re-fetch to act.
   */
  async function buildItems(companyId: string, agentIds: string[], requiresOverride: boolean) {
    if (agentIds.length === 0) return [];
    const rows = await db
      .select({ approval: approvals, agent: agents })
      .from(approvals)
      .innerJoin(agents, eq(agents.id, approvals.requestedByAgentId))
      .where(
        and(
          eq(approvals.companyId, companyId),
          inArray(approvals.requestedByAgentId, agentIds),
          inArray(approvals.status, OPEN_APPROVAL_STATUSES),
        ),
      )
      .orderBy(desc(approvals.createdAt));

    return rows.map(({ approval, agent }) => ({
      approvalId: approval.id,
      type: approval.type,
      status: approval.status,
      revision: approval.revision,
      payload: approval.payload,
      createdAt: approval.createdAt,
      decidedAt: approval.decidedAt,
      decisionChannel: approval.decisionChannel,
      decisionActorRole: approval.decisionActorRole,
      requestingAgent: { id: agent.id, name: agent.name, role: agent.role },
      // Owner/admin items are exceptional by construction: they are only
      // decidable through the reasoned override action, never as an ordinary
      // approval control.
      requiresOverride,
    }));
  }

  /**
   * The authenticated user's own inbox. The identity comes from the session and
   * nothing else — there is deliberately no userId parameter to honor.
   */
  router.get("/companies/:companyId/me/inbox", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const current = await stewardships.activeByUserWithAgent(companyId, userId);
    if (!current) {
      res.json({ stewardedAgent: null, items: [] });
      return;
    }

    res.json({
      stewardedAgent: {
        id: current.agent.id,
        name: current.agent.name,
        role: current.agent.role,
        status: current.agent.status,
      },
      stewardship: current.stewardship,
      items: await buildItems(companyId, [current.agent.id], false),
    });
  });

  /**
   * Separate owner/admin view. Kept off `/me/inbox` so override controls can
   * never be rendered in the same place as ordinary steward decisions.
   */
  router.get("/companies/:companyId/inbox/override", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    requireBoardUser(req);

    const isAdmin =
      req.actor.source === "local_implicit" ||
      req.actor.isInstanceAdmin ||
      (await access.canUser(companyId, req.actor.userId, "agents:create"));
    if (!isAdmin) {
      throw forbidden("The override view requires company owner or administrator access");
    }

    const companyAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    res.json({
      items: await buildItems(
        companyId,
        companyAgents.map((agent) => agent.id),
        true,
      ),
    });
  });

  return router;
}
