import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { bridgeService } from "../services/bridge.js";
import { requireProductProfile } from "../services/companies.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * AgentDash-MK: the local agent bridge.
 *
 * Two audiences, deliberately separated.
 *
 * The **endpoint-facing** routes (`/bridge/poll`, `/bridge/result`,
 * `/bridge/decline`) are the ONLY paths a `bridge_endpoint` actor may reach.
 * That allowlist lives in `middleware/auth.ts`, next to where the actor is
 * minted, because a control enforced far from the credential it governs is one
 * that gets forgotten. These routes take no companyId — the endpoint's identity
 * supplies it, so a credential cannot reach across companies by changing a path
 * segment.
 *
 * The **human- and agent-facing** routes are ordinary company-scoped API
 * surface with the usual profile gate and authorization.
 */
export function bridgeRoutes(db: Db) {
  const router = Router();
  const bridge = bridgeService(db);
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

  async function isAdministrator(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return access.canUser(companyId, req.actor.userId, "agents:create");
  }

  /** The endpoint identity, or a refusal. Never trusts a body-supplied id. */
  function requireEndpoint(req: Request) {
    if (req.actor.source !== "bridge_endpoint" || !req.actor.bridgeEndpointId) {
      throw forbidden("Bridge endpoint authentication required");
    }
    return { endpointId: req.actor.bridgeEndpointId, companyId: req.actor.companyId! };
  }

  // -------------------------------------------------------------------------
  // Endpoint-facing (bridge_endpoint actor only)
  // -------------------------------------------------------------------------

  /**
   * Pull the next task.
   *
   * Returns `{ task: null }` rather than 204 when idle, so a polling client has
   * one response shape to parse. This is a plain poll, not a held long-poll —
   * see the deferred-work note in the API doc.
   */
  router.post("/bridge/poll", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);

    const claimed = await bridge.claimNextTask(endpointId);
    if (!claimed) {
      res.json({ task: null });
      return;
    }
    res.json({
      task: {
        id: claimed.task.id,
        taskClass: claimed.task.taskClass,
        instruction: claimed.task.instruction,
        leaseExpiresAt: claimed.task.leaseExpiresAt,
      },
      resultToken: claimed.resultToken,
    });
  });

  router.post("/bridge/result", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId : null;
    const resultToken = typeof req.body?.resultToken === "string" ? req.body.resultToken : null;
    const result = typeof req.body?.result === "string" ? req.body.result : null;
    if (!taskId || !resultToken || result === null) {
      throw badRequest("taskId, resultToken, and result are required");
    }
    const updated = await bridge.submitResult(endpointId, taskId, resultToken, result);
    res.json({ taskId: updated.id, outcome: updated.outcome });
  });

  router.post("/bridge/decline", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId : null;
    const resultToken = typeof req.body?.resultToken === "string" ? req.body.resultToken : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!taskId || !resultToken) throw badRequest("taskId and resultToken are required");
    const updated = await bridge.declineTask(endpointId, taskId, resultToken, reason);
    res.json({ taskId: updated.id, outcome: updated.outcome });
  });

  // -------------------------------------------------------------------------
  // Human-facing: enrollment and endpoint management
  // -------------------------------------------------------------------------

  router.get("/companies/:companyId/me/bridge/endpoints", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const endpoints = await bridge.listEndpointsForUser(companyId, userId);
    res.json({
      // No token material, ever — only the hash exists and even that stays here.
      endpoints: endpoints.map((endpoint) => ({
        id: endpoint.id,
        label: endpoint.label,
        capabilities: endpoint.capabilities,
        enrolledAt: endpoint.enrolledAt,
        lastSeenAt: endpoint.lastSeenAt,
        pendingApproval: endpoint.enrolledAt === null,
      })),
    });
  });

  /**
   * Request enrollment for a machine. Inert until approved — this creates no
   * usable credential, which is the entire point of splitting the ceremony.
   */
  router.post("/companies/:companyId/me/bridge/endpoints", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    const capabilities = Array.isArray(req.body?.capabilities)
      ? req.body.capabilities.filter((value: unknown): value is string => typeof value === "string")
      : [];

    const { enrollmentId } = await bridge.requestEnrollment(companyId, {
      userId,
      label,
      capabilities,
    });
    res.status(201).json({ enrollmentId, pendingApproval: true });
  });

  /**
   * Approve an enrollment and mint the token.
   *
   * The token is in this response and nowhere else, ever. Self-approval is
   * allowed on purpose: the human enrolling their own laptop IS the human whose
   * approval matters, and requiring a second person would make the common case
   * unusable without adding a control — anyone who can reach this route for
   * their own endpoint could equally have asked a colleague to click it.
   */
  router.post("/companies/:companyId/bridge/endpoints/:endpointId/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    const endpointId = req.params.endpointId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const endpoints = await bridge.listEndpointsForUser(companyId, userId);
    const own = endpoints.some((endpoint) => endpoint.id === endpointId);
    if (!own && !(await isAdministrator(req, companyId))) {
      throw forbidden("Only the endpoint's owner or an administrator can approve it");
    }

    const approved = await bridge.approveEnrollment(companyId, endpointId, userId);
    res.status(201).json({ endpointId: approved.endpointId, token: approved.token });
  });

  router.post("/companies/:companyId/bridge/endpoints/:endpointId/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    const endpointId = req.params.endpointId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const endpoints = await bridge.listEndpointsForUser(companyId, userId);
    const own = endpoints.some((endpoint) => endpoint.id === endpointId);
    if (!own && !(await isAdministrator(req, companyId))) {
      throw forbidden("Only the endpoint's owner or an administrator can revoke it");
    }

    await bridge.revokeEndpoint(companyId, endpointId, userId);
    res.json({ endpointId, revoked: true });
  });

  // -------------------------------------------------------------------------
  // Agent-facing: file a task, read its outcome
  // -------------------------------------------------------------------------

  router.post("/companies/:companyId/bridge/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);

    // Agent-authenticated only. A board user filing a task would route work to
    // someone's machine without an agent's ceiling or audit trail behind it.
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }

    const endpointId = typeof req.body?.endpointId === "string" ? req.body.endpointId : null;
    const taskClass = req.body?.taskClass === "act" ? "act" : "read";
    const instruction = typeof req.body?.instruction === "string" ? req.body.instruction : "";
    if (!endpointId) throw badRequest("endpointId is required");

    const task = await bridge.createTask(companyId, {
      endpointId,
      requestedByAgentId: req.actor.agentId,
      taskClass,
      instruction,
    });

    // 202 for an act task: nothing has been dispatched, a human must decide.
    res.status(201).json({
      taskId: task.id,
      status: task.status,
      approvalId: task.approvalId,
      // Named so an agent does not read "created" as "done".
      awaitingApproval: task.status === "awaiting_approval",
    });
  });

  router.get("/companies/:companyId/bridge/tasks", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }
    if (req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    const tasks = await bridge.listTasksForAgent(companyId, req.actor.agentId);
    res.json({
      tasks: tasks.map((task) => ({
        id: task.id,
        taskClass: task.taskClass,
        status: task.status,
        outcome: task.outcome,
        declineReason: task.declineReason,
        // Already framed as untrusted when it was stored.
        result: task.result,
        completedAt: task.completedAt,
      })),
    });
  });

  return router;
}
