import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { badRequest, forbidden, notFound } from "../errors.js";
import { accessService } from "../services/access.js";
import { approvalCardDeliveryService } from "../services/approval-card-delivery.js";
import { stewardInboxService } from "../services/steward-inbox.js";
import { stewardInboxDecisionService } from "../services/steward-inbox-decisions.js";
import { stewardInboxActionsService } from "../services/steward-inbox-actions.js";
import { heartbeatService } from "../services/heartbeat.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { BRIDGE_TASK_CLASSES, bridgeService } from "../services/bridge.js";
import {
  MAX_UPLOAD_MESSAGE_CHARS,
  MAX_UPLOAD_RECIPIENTS,
  bridgeUploadService,
} from "../services/bridge-upload.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { requireProductProfile } from "../services/companies.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

// Ids reach uuid columns. Checked here so a malformed one is the caller's 400,
// not a Postgres cast error (22P02) surfacing as a 500 with the SQL and body
// in the server log.
const uuidSchema = z.string().uuid();

function requireUuid(value: unknown, field: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw badRequest(`${field} must be a uuid`);
  return parsed.data;
}

const createBridgeTaskSchema = z.object({
  endpointId: z
    .string({ required_error: "endpointId is required" })
    .uuid("endpointId must be a uuid"),
  taskClass: z.enum(BRIDGE_TASK_CLASSES).default("read"),
  // Emptiness is the service's refusal ("An instruction is required").
  instruction: z.string().default(""),
});

// Person upload (document access slice 8). Strict: an unknown key, a link
// scope other than "organization", or a role other than read/write is a 400,
// so `anonymous` and `users` links cannot even be asked for.
const uploadPersonSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    userId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const uploadProposeSchema = z
  .object({
    file: z
      .object({
        name: z.string().min(1).max(255),
        byteSize: z.number().int().positive(),
        contentType: z.string().min(1).max(200),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, "sha256 must be 64 hex characters"),
      })
      .strict(),
    destination: z
      .union([
        z.object({ folderId: z.string().min(1).max(512) }).strict(),
        z.object({ path: z.string().min(1).max(1024) }).strict(),
      ])
      .optional(),
    recipients: z
      .array(uploadPersonSchema.extend({ role: z.enum(["read", "write"]).optional() }).strict())
      .max(MAX_UPLOAD_RECIPIENTS)
      .optional(),
    link: z.object({ scope: z.literal("organization"), type: z.enum(["view", "edit"]) }).strict().optional(),
    issueId: z.string().trim().min(1).max(64).optional(),
    task: z
      .object({
        title: z.string().trim().min(1).max(200),
        instructions: z.string().max(20_000).optional(),
        assignee: uploadPersonSchema,
      })
      .strict()
      .optional(),
    message: z.string().max(MAX_UPLOAD_MESSAGE_CHARS).optional(),
  })
  .strict();

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
/**
 * @param options Threaded to the shared post-decision effects, so an approval
 * resolved from a steward inbox wakes its requesting agent under the same
 * configuration as the same decision taken on the board. Without this the two
 * surfaces would differ for plugin-hosted agents.
 */
export function bridgeRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    autoDispatchQueuedRuns?: boolean;
  } = {},
) {
  const router = Router();
  const bridge = bridgeService(db);
  const access = accessService(db);
  const cardDelivery = approvalCardDeliveryService(db);
  const inbox = stewardInboxService(db);
  const inboxDecisions = stewardInboxDecisionService(db, options);
  const heartbeat = heartbeatService(db, { pluginWorkerManager: options.pluginWorkerManager });
  const inboxActions = stewardInboxActionsService(db, { heartbeat });

  const uploads = bridgeUploadService(db, { heartbeat });
  const flags = featureFlagsService(db);

  /**
   * Person upload sits behind the company's document-access flag: off means
   * every upload route answers 404, as if it did not exist.
   */
  async function requireDocumentAccess(companyId: string) {
    if (!(await flags.isEnabled(companyId, FEATURE_FLAG_KEYS.DOCUMENT_ACCESS))) throw notFound("Not found");
  }

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

  /**
   * Read everything this machine has not acknowledged.
   *
   * Separate from `/bridge/poll` on purpose. A poll CLAIMS one task and hands
   * back a single-use token to answer it; a sync claims nothing, mutates
   * nothing, and can be repeated safely. Folding the inbox into the poll would
   * have made an idempotent read share a route with a leased write.
   *
   * Pass `includeDigest: true` for the ordered standing summary -- urgent
   * approvals, then blockers, then completions. That is a projection of how
   * things stand rather than a replay of the events above, so it answers "what
   * is waiting" while the event list answers "what changed".
   */
  router.post("/bridge/inbox/sync", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);

    const rawLimit = req.body?.limit;
    const limit = typeof rawLimit === "number" ? rawLimit : undefined;
    // Asked for on startup and on reconnect, not on every poll. The digest is
    // several queries and its answer barely moves while a steward is idle, so
    // making it the default would spend most of its cost on nobody looking.
    const includeDigest = req.body?.includeDigest === true;
    const result = await inbox.syncForEndpoint(endpointId, { limit, includeDigest });
    res.json(result);
  });

  /**
   * Move this machine's position forward.
   *
   * The client says what it applied; the server does not infer it from the
   * fact that a sync happened. That is what makes delivery at-least-once
   * rather than at-most-once: a machine that dies mid-apply gets the same
   * events again instead of losing them.
   */
  router.post("/bridge/inbox/ack", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const seq = req.body?.seq;
    if (typeof seq !== "number") throw badRequest("seq is required and must be a number");
    const result = await inbox.acknowledge(endpointId, seq);
    res.json(result);
  });

  /**
   * Resolve an approval from the inbox.
   *
   * The endpoint credential is not the authority here; the handle is, and only
   * for the one approval and revision it was minted against. Authority is then
   * re-resolved against the endpoint's owner, so a steward whose permission
   * changed since the sync is refused even holding a valid handle.
   *
   * Answers 200 with `ok: false` for the refusals a steward can actually hit —
   * a spent handle, a superseded revision, a decision someone else already
   * made. Those are outcomes to show them, not server faults.
   */
  router.post("/bridge/inbox/decide", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    await bridge.touchEndpoint(endpointId);
    const token = typeof req.body?.token === "string" ? req.body.token : null;
    if (!token) throw badRequest("token is required");
    res.json(await inboxDecisions.decide(endpointId, token));
  });

  /**
   * The company's agents, name and role only.
   *
   * Enough to turn "Casper" into an id, and nothing more. An endpoint
   * credential has no business seeing adapter configuration, budgets or policy,
   * so this projection is deliberately narrow rather than the agents listing.
   */
  router.post("/bridge/inbox/agents", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    res.json(await inboxActions.listAgents(endpointId));
  });

  /**
   * Read back what was understood, and mint a single-use handle for it.
   *
   * Nothing happens here. An unresolved or ambiguous name mints no handle and
   * comes back as a question, because a wrong name silently assigned to the
   * wrong agent is worse than asking.
   */
  router.post("/bridge/inbox/propose", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const kind = req.body?.kind;
    if (kind !== "assign_work" && kind !== "set_cadence") {
      throw badRequest('kind must be "assign_work" or "set_cadence"');
    }
    res.json(await inboxActions.propose(endpointId, req.body));
  });

  /**
   * Spend the handle and do the thing.
   *
   * The credential does not authorise this; the handle does, and only for the
   * resolved action it was minted over. Permission is re-checked here rather
   * than at propose time, so authority that changed in between is honoured.
   */
  router.post("/bridge/inbox/confirm", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const token = typeof req.body?.token === "string" ? req.body.token : null;
    if (!token) throw badRequest("token is required");
    res.json(await inboxActions.confirm(endpointId, token));
  });

  // -------------------------------------------------------------------------
  // Person upload (document access slice 8), endpoint-facing
  //
  // The person's own file, to their own OneDrive, as them. The endpoint
  // credential is still not a write credential: `propose` mints a handle over
  // a resolved plan and changes nothing, `confirm` spends it, and fragments
  // go only to the session that confirm opened. Every route needs the company
  // flag (404) and `bridge:upload` (403). Agent keys are refused (403).
  // -------------------------------------------------------------------------

  /** Folders in the person's own OneDrive, to pick a destination from (D10: never a default). */
  router.post("/bridge/upload/destinations", async (req, res) => {
    const { endpointId, companyId } = requireEndpoint(req);
    await requireDocumentAccess(companyId);
    res.json(await uploads.destinations(endpointId, { query: req.body?.query, limit: req.body?.limit }));
  });

  /** Read back the whole plan and mint a handle. Uploads and shares nothing. */
  router.post("/bridge/upload/propose", async (req, res) => {
    const { endpointId, companyId } = requireEndpoint(req);
    await requireDocumentAccess(companyId);
    await uploads.requireUploadEndpoint(endpointId);
    const parsed = uploadProposeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    await bridge.touchEndpoint(endpointId);
    res.json(await uploads.propose(endpointId, parsed.data));
  });

  /** Spend the handle after the person's yes; opens the upload session. */
  router.post("/bridge/upload/confirm", async (req, res) => {
    const { endpointId, companyId } = requireEndpoint(req);
    await requireDocumentAccess(companyId);
    const handle = typeof req.body?.handle === "string" ? req.body.handle : null;
    if (!handle) throw badRequest("handle is required");
    await bridge.touchEndpoint(endpointId);
    res.json(await uploads.confirm(endpointId, handle));
  });

  /**
   * One fragment, raw bytes. `X-AgentDash-Upload-Id` names the upload and
   * `Content-Range: bytes a-b/total` places the bytes; both are forwarded
   * unchanged to the session, which only the server can reach.
   */
  router.post("/bridge/upload/fragment", async (req, res) => {
    const { endpointId, companyId } = requireEndpoint(req);
    await requireDocumentAccess(companyId);
    const result = await uploads.fragment(endpointId, {
      uploadId: req.header("x-agentdash-upload-id") ?? undefined,
      contentRange: req.header("content-range") ?? undefined,
      contentLength: req.header("content-length") ?? undefined,
      body: req,
    });
    res.status(result.status).json(result.body);
  });

  router.post("/bridge/upload/status", async (req, res) => {
    const { endpointId, companyId } = requireEndpoint(req);
    await requireDocumentAccess(companyId);
    const uploadId = typeof req.body?.uploadId === "string" ? req.body.uploadId : "";
    if (!uploadId) throw badRequest("uploadId is required");
    res.json(await uploads.status(endpointId, uploadId));
  });

  router.post("/bridge/upload/cancel", async (req, res) => {
    const { endpointId, companyId } = requireEndpoint(req);
    await requireDocumentAccess(companyId);
    const uploadId = typeof req.body?.uploadId === "string" ? req.body.uploadId : "";
    if (!uploadId) throw badRequest("uploadId is required");
    res.json(await uploads.cancel(endpointId, uploadId));
  });

  router.post("/bridge/result", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId : null;
    const resultToken = typeof req.body?.resultToken === "string" ? req.body.resultToken : null;
    const result = typeof req.body?.result === "string" ? req.body.result : null;
    if (!taskId || !resultToken || result === null) {
      throw badRequest("taskId, resultToken, and result are required");
    }
    requireUuid(taskId, "taskId");
    const updated = await bridge.submitResult(endpointId, taskId, resultToken, result);
    res.json({ taskId: updated.id, outcome: updated.outcome });
  });

  router.post("/bridge/decline", async (req, res) => {
    const { endpointId } = requireEndpoint(req);
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId : null;
    const resultToken = typeof req.body?.resultToken === "string" ? req.body.resultToken : null;
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    if (!taskId || !resultToken) throw badRequest("taskId and resultToken are required");
    requireUuid(taskId, "taskId");
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
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const endpointId = requireUuid(req.params.endpointId, "endpointId");

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
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const endpointId = requireUuid(req.params.endpointId, "endpointId");

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

    // Parsed after authorization, so a caller who may not file tasks learns
    // nothing from a validation error. An unrecognised taskClass is refused
    // rather than read as "read": a mistyped "act" must not skip its approval.
    const { endpointId, taskClass, instruction } = createBridgeTaskSchema.parse(req.body ?? {});

    const task = await bridge.createTask(companyId, {
      endpointId,
      requestedByAgentId: req.actor.agentId,
      taskClass,
      instruction,
    });

    // An `act` task IS a stalled escalation: the agent cannot proceed until a
    // human decides. Until this call existed, the approval landed in the web
    // inbox and nothing told the steward it was there — so the stall lasted
    // until they happened to look. Delivery lives in the route rather than in
    // `createTask` for the same reason it does in the approvals routes: the
    // service layer stays acyclic, and the connectors it reaches import the
    // approvals service.
    //
    // Awaited so the request does not outlive its own side effects. The
    // delivery service swallows every failure internally, so an unreachable
    // provider cannot fail this response.
    if (task.approvalId) {
      await cardDelivery.deliverForApproval(task.approvalId);
      // The same stall, recorded durably. Card delivery reaches paired chat
      // channels only; without this an `act` task's approval never enters the
      // steward inbox, so a machine syncing from its cursor would never learn
      // it was waiting -- which is the one thing the inbox exists to prevent.
      await inbox.recordApprovalEvent(task.approvalId, "approval.opened");
    }

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
