import { Router } from "express";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companies, companyMemberships } from "@paperclipai/db";
import {
  assignAgentStewardshipSchema,
  transferAgentStewardshipSchema,
  releaseAgentStewardshipSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { agentService } from "../services/agents.js";
import { requireProductProfile } from "../services/companies.js";
import { logger } from "../middleware/logger.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import {
  agentVisibilityParam,
} from "./visibility.js";

/**
 * Memberships created before this instant predate automatic provisioning.
 *
 * "New joiners only" was a deliberate call. Existing members already have
 * whatever arrangement they have, and nobody should sign in one morning to an
 * agent they never asked for. A constant rather than a stored marker keeps this
 * greppable and needs no migration -- a cutover only has to be right once.
 */
const PERSONAL_AGENT_PROVISIONING_FROM = new Date("2026-09-01T00:00:00.000Z");

export function agentStewardshipRoutes(db: Db) {
  const router = Router();
  // Agent visibility (2026-09-30): an agent the actor cannot see is 404 here too.
  router.param("agentId", agentVisibilityParam(db));
  const stewardships = agentStewardshipService(db);
  const access = accessService(db);

  /**
   * AgentDash (one UX): stewardship is a per-workspace capability, gated on
   * the server like every other one. A company without it answers 404 here,
   * the same "Company not found" the other capability routes send, so the
   * UI's capability check is the server's answer and nothing on this router
   * can create an agent or a pairing for a company that does not have
   * stewardship. Reads, transfer and release stay open (see
   * assertCanMutateStewardships).
   */
  async function requireStewardshipCompany(companyId: string) {
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  /**
   * Authority to change stewardships. `creates` is true for the routes that
   * make a new pairing (assign): those are capability-gated. Transfer and
   * release act on a pairing that already exists and stay open everywhere, so
   * a pairing made before the gate (or on a workspace whose capability was
   * later switched off) can always be unwound -- otherwise an agent could be
   * stuck stewarded forever, since autonomy cannot change while paired.
   */
  async function assertCanMutateStewardships(req: Request, companyId: string, creates = false) {
    assertBoard(req);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      if (creates) await requireStewardshipCompany(companyId);
      return;
    }
    assertCompanyAccess(req, companyId);
    if (creates) await requireStewardshipCompany(companyId);
    const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
    if (!allowed) {
      throw forbidden("Agent stewardship management requires agent creation permission");
    }
  }

  /**
   * Give a new member their own agent the first time they come here.
   *
   * Joining a company used to hand you a membership and nothing else: no agent,
   * no stewardship, and a My Agent page that was permanently blank. Meanwhile
   * an agent created BY an agent is born `stewarded` with nobody stewarding it,
   * because the creator-pairing in `POST /agents` only fires for a human actor.
   * Both halves showed up in one story -- somebody asked for an agent, an agent
   * made it, the agent ended up unpaired, and the person ended up with nothing.
   *
   * Provisioning here rather than at invite time means no orphan agents for
   * invitations nobody accepts: the agent exists from the moment its person
   * first arrives, and not before.
   *
   * Best-effort by construction. This is a read endpoint on the page somebody
   * lands on, so a failure to provision must degrade to the old empty answer,
   * never to an error.
   */
  async function provisionPersonalAgent(companyId: string, userId: string) {
    const membership = await db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      )
      .then((rows) => rows[0]);

    if (!membership || membership.status !== "active") return null;
    if (membership.createdAt < PERSONAL_AGENT_PROVISIONING_FROM) return null;
    // First visit only. Someone who has held a pairing here before -- their
    // agent was terminated, released, or moved to someone else -- is not new,
    // and quietly creating a fresh Chief of Staff for them on page load would
    // undo an administrator's decision. My Agent shows "No agent assigned" and
    // an administrator assigns the next one.
    if (await stewardships.hasStewardshipHistory(companyId, userId)) return null;

    const user = await db
      .select({ name: authUsers.name })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0]);

    // First name. `create` deduplicates the name for us, so two Megans do not
    // collide. AgentDash (GH #505): never the local part of the address -- an
    // agent's name is read by every agent and member in the company, so it
    // would publish the mailbox name the directory now withholds.
    const person = (user?.name ?? "").trim().split(/\s+/)[0] || "Teammate";

    const agent = await agentService(db).create(companyId, {
      name: `${person}'s agent`,
      role: "chief_of_staff",
      title: "Chief of Staff",
      adapterType: "hermes_local",
      autonomy: "stewarded",
      // Off until its person connects a harness and decides to run it. A new
      // agent that starts waking on a timer before anybody has met it is a
      // surprise, and a billable one.
      runtimeConfig: { heartbeat: { enabled: false } },
    });

    await stewardships.assign(companyId, {
      agentId: agent.id,
      userId,
      assignedByUserId: userId,
    });

    return stewardships.activeByUserWithAgent(companyId, userId);
  }

  router.get("/companies/:companyId/me/agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Before anything else: this route provisions a personal agent on first
    // visit, and a company without stewardship must never get one.
    await requireStewardshipCompany(companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("Board user access required");
    }

    const current = await stewardships.activeByUserWithAgent(companyId, req.actor.userId);
    if (current) {
      res.json(current);
      return;
    }

    let provisioned: Awaited<ReturnType<typeof provisionPersonalAgent>> = null;
    try {
      provisioned = await provisionPersonalAgent(companyId, req.actor.userId);
    } catch (err) {
      // Losing a race here leaves an unpaired agent behind, which is untidy but
      // harmless; failing the page is not.
      logger.warn(
        { err, companyId, userId: req.actor.userId },
        "[stewardships] could not provision a personal agent on first visit",
      );
      provisioned = await stewardships.activeByUserWithAgent(companyId, req.actor.userId);
    }

    res.json(provisioned ?? { stewardship: null, agent: null });
  });

  router.get("/companies/:companyId/agents/:agentId/stewardship", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    const stewardship = await stewardships.activeByAgent(companyId, agentId);
    res.json({ stewardship });
  });

  router.get("/companies/:companyId/agents/:agentId/stewardship/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    res.json({ stewardships: await stewardships.historyForAgent(companyId, agentId) });
  });

  router.post(
    "/companies/:companyId/agent-stewardships",
    validate(assignAgentStewardshipSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertCanMutateStewardships(req, companyId, true);
      const stewardship = await stewardships.assign(companyId, {
        agentId: req.body.agentId,
        userId: req.body.userId,
        assignedByUserId: req.actor.userId ?? null,
      });
      res.status(201).json({ stewardship });
    },
  );

  router.post(
    "/companies/:companyId/agents/:agentId/stewardship/transfer",
    validate(transferAgentStewardshipSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await assertCanMutateStewardships(req, companyId);
      const stewardship = await stewardships.transfer(companyId, agentId, {
        userId: req.body.userId,
        transferredByUserId: req.actor.userId ?? null,
        transferReason: req.body.transferReason ?? null,
      });
      res.json({ stewardship });
    },
  );

  /**
   * End a pairing and put nobody in its place.
   *
   * `POST .../release` rather than `DELETE .../stewardship`, matching
   * `.../transfer` and `.../channel-bindings/:id/revoke`: the reason is required
   * and belongs in a body, and every other stewardship state change on this
   * router is a POST. The row is never deleted — history is the point of the
   * table — so DELETE would also describe the wrong thing.
   *
   * Same authority as assigning or transferring. Releasing an agent is not a
   * lesser act than moving it: it revokes the outgoing steward's channels and
   * enrolled machines just the same.
   */
  router.post(
    "/companies/:companyId/agents/:agentId/stewardship/release",
    validate(releaseAgentStewardshipSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      await assertCanMutateStewardships(req, companyId);
      const stewardship = await stewardships.releaseForAgent(companyId, agentId, {
        releasedByUserId: req.actor.userId ?? null,
        releaseReason: req.body.releaseReason,
      });
      res.json({ stewardship });
    },
  );

  return router;
}
