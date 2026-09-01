import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { reconcileConnectorSendExecutionSchema } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { agentStewardshipService } from "../services/agent-stewardships.js";
import { connectorSendExecutionService } from "../services/connector-send-execution.js";
import { requireProductProfile } from "../services/companies.js";
import { assertCompanyAccess, assertBoard } from "./authz.js";

/**
 * AgentDash-MK T4: the `outcome_unknown` operator surface (audit item 14).
 *
 * An ambiguous connector write is recorded, correctly never retried, and until
 * this router nothing could read it. Two routes: list the unresolved rows, and
 * record a human's verdict on one. The verdict is an AUDIT record — a workflow
 * event plus an activity-log attribution — and it explicitly does not resend.
 * Resending stays with the approvals flow, which remains the only decision
 * boundary.
 *
 * Authority is owner/admin OR the steward of the agent that requested the send,
 * resolved server-side. The routes are company-scoped and profile-gated: they
 * 404 off `agentdash_mk`, exactly like every other MK surface.
 */
export function connectorSendExecutionRoutes(db: Db) {
  const router = Router();
  const svc = connectorSendExecutionService(db);
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

  async function isOwnerOrAdmin(req: Request, companyId: string) {
    return (
      req.actor.source === "local_implicit" ||
      req.actor.isInstanceAdmin === true ||
      (await access.canUser(companyId, req.actor.userId, "agents:create"))
    );
  }

  /**
   * GET /companies/:companyId/connector-send-executions?status=outcome_unknown
   *
   * Owner/admin see every unresolved row; a steward sees only their own agent's.
   * A member who is neither is refused rather than shown an empty list, so the
   * surface never implies "nothing to reconcile" to someone who simply cannot
   * see it.
   */
  router.get("/companies/:companyId/connector-send-executions", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const status = typeof req.query.status === "string" ? req.query.status : "outcome_unknown";
    if (status !== "outcome_unknown") {
      throw badRequest("status must be 'outcome_unknown'");
    }

    let agentIds: string[] | null;
    if (await isOwnerOrAdmin(req, companyId)) {
      agentIds = null;
    } else {
      const steward = await stewardships.activeByUserWithAgent(companyId, userId);
      if (!steward) {
        throw forbidden(
          "Reconciliation requires owner, administrator, or the requesting steward",
        );
      }
      agentIds = [steward.agent.id];
    }

    res.json({ items: await svc.listUnresolved(companyId, agentIds) });
  });

  /**
   * POST /companies/:companyId/connector-send-executions/:id/reconcile
   *
   * Records the verdict as an audit record. Idempotent and revision-bound; does
   * NOT resend.
   */
  router.post(
    "/companies/:companyId/connector-send-executions/:id/reconcile",
    validate(reconcileConnectorSendExecutionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const executionId = req.params.id as string;
      await requireProfileCompany(req, companyId);
      const userId = requireBoardUser(req);

      const execution = await svc.getUnresolvedById(companyId, executionId);
      if (!execution) throw notFound("Connector send execution not found");

      // Owner/admin may reconcile any row; a steward only their own agent's.
      if (!(await isOwnerOrAdmin(req, companyId))) {
        const steward = execution.requestedByAgentId
          ? await stewardships.activeByAgent(companyId, execution.requestedByAgentId)
          : null;
        if (!steward || steward.userId !== userId) {
          throw forbidden(
            "Reconciliation requires owner, administrator, or the requesting steward",
          );
        }
      }

      const result = await svc.reconcile({
        companyId,
        executionId,
        actingUserId: userId,
        verdict: req.body.verdict,
        revision: req.body.revision,
      });

      if (result.status === "not_found") throw notFound("Connector send execution not found");
      if (result.status === "conflict") {
        throw conflict(`Reconcile refused: ${result.reason}`);
      }
      res.json({ id: executionId, verdict: result.verdict, idempotent: result.idempotent });
    },
  );

  return router;
}
