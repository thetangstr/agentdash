import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { writeAgentMemorySchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { agentMemoryService } from "../services/agent-memory.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { assertCompanyAccess, isCompanyAdministrator } from "./authz.js";

/**
 * AgentDash: an agent's durable memory.
 *
 * Reading is company-wide on purpose. Memory is org knowledge, not a secret
 * store — an agent's mandate already tells it to keep credentials and personal
 * data out — and a colleague who can see what an agent believes can correct it
 * before it acts on something stale. Anything that must not be readable does not
 * belong in memory at all.
 *
 * Writing is narrower, and deliberately wider than `agent-directives`:
 *
 *   - the agent itself, and only its own memory. This is the normal path; memory
 *     is the agent's own belief state and it is the author of record.
 *   - its ACTIVE steward, the human accountable for it.
 *   - a company administrator. Directives exclude admins because directives are
 *     one person's voice and an admin pushing them would forge provenance. That
 *     argument does not carry here: memory is the AGENT's voice, a human editing
 *     it is always a correction rather than an impersonation, `authorKind`
 *     records which it was — and an unstewarded agent would otherwise have a
 *     wrong belief no human on the instance could fix.
 */
export function agentMemoryRoutes(db: Db) {
  const router = Router();
  const memory = agentMemoryService(db);
  const stewardships = agentStewardshipService(db);
  const access = accessService(db);

  async function requireWriter(
    req: Request,
    companyId: string,
    agentId: string,
  ): Promise<{ authorKind: "agent" | "steward" | "admin"; authorAgentId: string | null; authorUserId: string | null }> {
    assertCompanyAccess(req, companyId);

    if (req.actor.type === "agent") {
      // An agent writing another agent's memory would be writing a belief into
      // a colleague's head under that colleague's name. Peers influence each
      // other through issues and comments, which are attributable and readable.
      if (req.actor.agentId !== agentId) {
        throw forbidden("An agent can only write its own memory");
      }
      return { authorKind: "agent", authorAgentId: agentId, authorUserId: null };
    }

    const userId = req.actor.userId ?? null;
    if (userId) {
      const steward = await stewardships.activeByAgent(companyId, agentId);
      if (steward && steward.userId === userId) {
        return { authorKind: "steward", authorAgentId: null, authorUserId: userId };
      }
    }
    if (await isCompanyAdministrator(access, req, companyId)) {
      return { authorKind: "admin", authorAgentId: null, authorUserId: userId };
    }
    throw forbidden("Only the agent itself, its steward, or a company admin can write its memory");
  }

  router.get("/companies/:companyId/agents/:agentId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    res.json({ memory: await memory.active(companyId, agentId) });
  });

  router.get("/companies/:companyId/agents/:agentId/memory/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    res.json({
      active: await memory.active(companyId, agentId),
      history: await memory.history(companyId, agentId),
    });
  });

  router.put(
    "/companies/:companyId/agents/:agentId/memory",
    validate(writeAgentMemorySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      const author = await requireWriter(req, companyId, agentId);
      const body = req.body as { content: string; expectedVersion?: number | null };

      const record = await memory.writeAndLog(
        companyId,
        agentId,
        {
          content: body.content,
          authorKind: author.authorKind,
          authorAgentId: author.authorAgentId,
          authorUserId: author.authorUserId,
          expectedVersion: body.expectedVersion ?? null,
        },
        {
          actorType: req.actor.type === "agent" ? "agent" : "user",
          actorId: (req.actor.type === "agent" ? req.actor.agentId : req.actor.userId) ?? agentId,
          agentId: req.actor.type === "agent" ? req.actor.agentId : null,
        },
      );
      res.json({ memory: record });
    },
  );

  return router;
}
