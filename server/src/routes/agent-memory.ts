import { Router } from "express";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { writeAgentMemorySchema } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { agentMemoryService } from "../services/agent-memory.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { assertCompanyAccess, isCompanyAdministrator } from "./authz.js";
import {
  agentVisibilityParam,
} from "./visibility.js";

/**
 * AgentDash: an agent's durable memory.
 *
 * Reading is narrow. Memory is where an agent keeps the lessons it took from
 * its person's corrections — how that person wants work done — so it reads
 * like a private working notebook rather than org knowledge. Readers:
 *
 *   - the agent itself, and only its own memory;
 *   - its ACTIVE steward, the person those lessons came from;
 *   - a company administrator (owner/admin), an instance admin, or the local
 *     implicit board, who answer for every agent on the instance.
 *
 * Everyone else, including another agent, gets 404: the memory is nonexistent
 * to them, the same answer agent visibility gives for a hidden agent. Copies of
 * memory text outside this route (the run's context snapshot and its
 * `adapter.invoke` event), and of the corrections memory is built from, are
 * withheld at write and at read; see `services/run-private-content.ts`.
 *
 * Writing is narrower than reading for agents, and deliberately wider than
 * `agent-directives`:
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
  // Agent visibility (2026-09-30): an agent the actor cannot see is 404 here too.
  router.param("agentId", agentVisibilityParam(db));
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

  /**
   * The read gate: the agent itself, its active steward, or an administrator.
   * Anyone else gets the 404 a missing memory would get, never a 403 that
   * confirms there is something to withhold.
   */
  async function requireReader(req: Request, companyId: string, agentId: string): Promise<void> {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (req.actor.agentId === agentId) return;
      throw notFound("Agent memory not found");
    }
    const userId = req.actor.userId ?? null;
    if (userId) {
      const steward = await stewardships.activeByAgent(companyId, agentId);
      if (steward && steward.userId === userId) return;
    }
    if (await isCompanyAdministrator(access, req, companyId)) return;
    throw notFound("Agent memory not found");
  }

  router.get("/companies/:companyId/agents/:agentId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await requireReader(req, companyId, agentId);
    res.json({ memory: await memory.active(companyId, agentId) });
  });

  router.get("/companies/:companyId/agents/:agentId/memory/history", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await requireReader(req, companyId, agentId);
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
