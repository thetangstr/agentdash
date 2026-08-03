import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  answerAgentFactSchema,
  askAgentFactSchema,
  declineAgentFactSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentFactRequestService } from "../services/agent-fact-requests.js";
import { requireProductProfile } from "../services/companies.js";

/**
 * AgentDash-MK: agent↔agent fact requests.
 *
 * Agent-authenticated throughout, and the identity always comes from the actor
 * rather than the body. A `requestedByAgentId` in a request body would let any
 * agent file asks in another's name; an `answeringAgentId` would let the
 * requester answer its own question and manufacture provenance for a figure
 * nobody produced. Neither field exists in the validators.
 *
 * Profile-gated: outside `agentdash_mk` every route here answers 404, not 403 —
 * a company that does not have this feature should not be able to tell that
 * someone else does.
 */
export function agentFactRequestRoutes(db: Db) {
  const router = Router();
  const facts = agentFactRequestService(db);

  async function requireProfileCompany(companyId: string) {
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  /**
   * The acting agent, or a refusal.
   *
   * A board user cannot ask or answer here. A human with a question asks it as
   * a human; routing it through this surface would attach agent provenance to
   * an answer a person gave, which is precisely the confusion the provenance
   * columns exist to prevent.
   */
  function requireAgent(req: Request, companyId: string) {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    return req.actor.agentId;
  }

  /**
   * Ask another agent for a named fact.
   *
   * Returns 201 for a new ask and 200 for a deduplicated one, so the caller can
   * tell the difference without a flag it might ignore — though `deduplicated`
   * is in the body too. One ask per fact per run is the promise; a collector
   * that retries must not become a person being asked twice.
   */
  router.post(
    "/companies/:companyId/fact-requests",
    validate(askAgentFactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(companyId);
      const agentId = requireAgent(req, companyId);

      const { request, deduplicated } = await facts.ask(companyId, {
        requestedByAgentId: agentId,
        targetAgentId: req.body.targetAgentId,
        factKey: req.body.factKey,
        runId: req.body.runId,
        pipelineId: req.body.pipelineId,
        question: req.body.question,
      });
      res.status(deduplicated ? 200 : 201).json({ ...request, deduplicated });
    },
  );

  /** Facts asked OF this agent (`role=target`) or BY it (`role=requester`). */
  router.get("/companies/:companyId/fact-requests", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(companyId);
    const agentId = requireAgent(req, companyId);
    const role = req.query.role === "requester" ? "requester" : "target";
    res.json({ factRequests: await facts.listForAgent(companyId, agentId, role) });
  });

  router.post(
    "/companies/:companyId/fact-requests/:id/answer",
    validate(answerAgentFactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(companyId);
      const agentId = requireAgent(req, companyId);
      res.json(
        await facts.answer(companyId, req.params.id as string, {
          answeringAgentId: agentId,
          answer: req.body.answer,
          sourceKind: req.body.sourceKind,
        }),
      );
    },
  );

  /**
   * Decline rather than guess.
   *
   * A declined fact is flagged, not hidden: "nobody could give us this number"
   * is a real finding about the week and the approver has to see it.
   */
  router.post(
    "/companies/:companyId/fact-requests/:id/decline",
    validate(declineAgentFactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(companyId);
      const agentId = requireAgent(req, companyId);
      res.json(
        await facts.decline(companyId, req.params.id as string, {
          answeringAgentId: agentId,
          reason: req.body.reason,
        }),
      );
    },
  );

  /** Hand the question up: to the steward's own harness, or to Teams. */
  router.post("/companies/:companyId/fact-requests/:id/escalate", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(companyId);
    const agentId = requireAgent(req, companyId);
    res.json(
      await facts.escalate(companyId, req.params.id as string, { answeringAgentId: agentId }),
    );
  });

  return router;
}
