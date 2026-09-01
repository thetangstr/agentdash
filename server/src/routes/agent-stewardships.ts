import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  assignAgentStewardshipSchema,
  transferAgentStewardshipSchema,
  releaseAgentStewardshipSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function agentStewardshipRoutes(db: Db) {
  const router = Router();
  const stewardships = agentStewardshipService(db);
  const access = accessService(db);

  async function assertCanMutateStewardships(req: Request, companyId: string) {
    assertBoard(req);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    assertCompanyAccess(req, companyId);
    const allowed = await access.canUser(companyId, req.actor.userId, "agents:create");
    if (!allowed) {
      throw forbidden("Agent stewardship management requires agent creation permission");
    }
  }

  router.get("/companies/:companyId/me/agent", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("Board user access required");
    }

    const current = await stewardships.activeByUserWithAgent(companyId, req.actor.userId);
    res.json(current ?? { stewardship: null, agent: null });
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
      await assertCanMutateStewardships(req, companyId);
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
