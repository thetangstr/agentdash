import {
  assertHostExecutionConfigAllowed,
  runtimeConfigHostExecutionInputs,
} from "../services/adapter-host-execution-policy.js";
import { hostExecutionContextForCompany } from "../services/host-execution-context.js";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  checkConnectorSendPayload,
  CONNECTOR_SEND_PROVIDERS,
  createApprovalSchema,
  overrideApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { agentFactRequestService } from "../services/agent-fact-requests.js";
import { deliverableReviewService } from "../services/deliverable-review.js";
import { workflowRecommendationService } from "../services/workflow-recommendations.js";
import { approvalAuthorityService } from "../services/approval-authority.js";
import { approvalCardDeliveryService } from "../services/approval-card-delivery.js";
import { approvalDecisionEffectsService } from "../services/approval-decision-effects.js";
import { stewardInboxService } from "../services/steward-inbox.js";
import { bridgeService } from "../services/bridge.js";
import { connectorSendExecutionService } from "../services/connector-send-execution.js";
import { accessService } from "../services/access.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  agentService,
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { insertActivity, publishActivity } from "../services/activity-log.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  approvalVisibilityCondition,
  assertAgentIdVisible,
  assertApprovalProjectVisible,
  assertIssueIdVisible,
  canReadCompanySpend,
  filterVisibleByProject,
  visibleAgentIdsFor,
} from "./visibility.js";
import { badRequest, forbidden, unprocessable } from "../errors.js";
import { assertNoAssistantProvenanceClaimInPayload } from "../services/assistant-provenance-claims.js";
import { redactApprovalForReader } from "../redaction.js";
import { approvalUrl } from "../lib/public-base-url.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { buildRequireTierDeps } from "../middleware/build-tier-deps.js";
import {
  exceededFreeTierCapacityAction,
  freeTierCapExceededPayload,
  isBillingDisabled,
  withCompanyTierCapacityLock,
} from "../services/tier-policy.js";

/**
 * Shape an approval row for a client response: redact the payload, and attach the
 * absolute URL a human would open to decide it.
 *
 * The URL is attached here rather than by the caller because the server is the
 * only party that knows the address this instance advertises. Clients used to
 * build it from whatever endpoint they had happened to dial, which minted
 * correct-looking loopback links for every reader who was not on the server's
 * own machine (#539).
 *
 * Absent, not null, when the instance advertises no public URL — the same idiom
 * the health route uses for `publicBaseUrl`.
 */
function approvalResponse<T extends { id: string; type: string; payload: Record<string, unknown> }>(approval: T, canReadSpend: boolean) {
  const url = approvalUrl(approval.id);
  return {
    ...redactApprovalForReader(approval, canReadSpend),
    ...(url ? { url } : {}),
  };
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; autoDispatchQueuedRuns?: boolean } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const cardDelivery = approvalCardDeliveryService(db);
  // AgentDash-MK: the durable steward inbox. Recorded on the same branches
  // that already log the lifecycle, so an inbox item exists for exactly the
  // transitions a human is told about elsewhere.
  const stewardInbox = stewardInboxService(db);
  const bridge = bridgeService(db);
  // AgentDash-MK Slice E: content the inbound filter held is released or
  // discarded here, on the same branches that settle a gated bridge task. The
  // filter escalates INTO this service; it does not decide anything itself.
  const facts = agentFactRequestService(db);
  const deliverableReview = deliverableReviewService(db);
  // AgentDash-MK Slice H: the review agent's recommendations are decided here,
  // through the same service as everything else. Settling one records that a
  // human agreed or did not; nothing acts on the result.
  const recommendations = workflowRecommendationService(db);
  const connectorSend = connectorSendExecutionService(db);
  // AgentDash-MK: the single decision boundary. Web, Telegram, and Teams all
  // resolve authority here; provider routes never update approval rows directly.
  const authority = approvalAuthorityService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    autoDispatchQueuedRuns: options.autoDispatchQueuedRuns,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  // Every post-decision side effect, shared so a second decision surface can
  // exist without reproducing the list. See the note in that service.
  const decisionEffects = approvalDecisionEffectsService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    autoDispatchQueuedRuns: options.autoDispatchQueuedRuns,
  });
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  function hireApprovalCreatesAgent(approval: {
    type: string;
    status?: string | null;
    payload: unknown;
  }): boolean {
    if (approval.type !== "hire_agent") return false;
    if (approval.status !== "pending" && approval.status !== "revision_requested") return false;
    const payload =
      typeof approval.payload === "object" && approval.payload !== null
        ? (approval.payload as Record<string, unknown>)
        : {};
    return typeof payload.agentId !== "string";
  }

  /**
   * Approving a `hire_agent` request CREATES an agent, with a `role` and
   * `adapterConfig` taken from a payload that `createApprovalSchema` does not
   * validate. Creating an agent directly requires `agents:create`, so deciding
   * an approval that creates one must require it too — otherwise the approval
   * path is a way around the permission, in every product profile.
   *
   * Deliberately applies to `default` companies as well: this is a
   * pre-existing platform gap, not an AgentDash-MK one.
   */
  async function assertCanDecideAgentLifecycleApproval(
    req: Request,
    approval: { type: string; status?: string | null; payload: unknown; companyId: string },
  ) {
    // Deliberately keyed on the approval TYPE, not on whether the payload
    // creates a new agent. Every hire_agent decision drives an agent lifecycle
    // transition: with no `payload.agentId` an approve creates an agent, and
    // WITH one an approve activates that agent and a reject terminates it and
    // revokes its API keys. Gating only the create case guards the exact
    // complement of the terminate path.
    if (approval.type !== "hire_agent") return;
    if (approval.status !== "pending" && approval.status !== "revision_requested") return;
    if (req.actor.type !== "board") {
      throw forbidden("Only board callers can decide an agent hire");
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    if (await access.canUser(approval.companyId, req.actor.userId, "agents:create")) return;
    throw forbidden("Deciding an agent hire requires the agents:create permission");
  }

  /**
   * Host-executed workspace commands must never enter the system through an
   * unvalidated hire payload; creating them directly is administrator-only.
   */
  /** AgentDash (security, #719): the adapter configs a hire payload would persist. */
  function hirePayloadHostExecutionInputs(payload: unknown, storedPayload?: unknown) {
    const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    const stored =
      typeof storedPayload === "object" && storedPayload !== null
        ? (storedPayload as Record<string, unknown>)
        : {};
    const adapterType = typeof record.adapterType === "string" ? record.adapterType : null;
    return [
      { adapterType, adapterConfig: record.adapterConfig, stored: stored.adapterConfig },
      ...runtimeConfigHostExecutionInputs(adapterType, record.runtimeConfig, stored.runtimeConfig),
    ];
  }

  function assertHirePayloadHasNoHostCommands(payload: unknown) {
    const adapterConfig =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).adapterConfig
        : null;
    const workspaceStrategy =
      typeof adapterConfig === "object" && adapterConfig !== null
        ? (adapterConfig as Record<string, unknown>).workspaceStrategy
        : null;
    if (typeof workspaceStrategy !== "object" || workspaceStrategy === null) return;
    const offending = Object.keys(workspaceStrategy as Record<string, unknown>).filter((key) =>
      key.toLowerCase().endsWith("command"),
    );
    if (offending.length > 0) {
      throw forbidden(
        `Agent hire payloads cannot carry host-executed workspace commands (${offending.sort().join(", ")})`,
      );
    }
  }

  /**
   * `autoProvisionDefaultKey` was a server-internal hint the approve path once
   * used to mint a default API key at activation. It was removed: runtime auth
   * is the run-scoped local agent JWT the heartbeat injects, and no hire
   * should hold an always-on `pcp_` key just for existing. Callers may not set
   * internal provisioning flags — reject the field outright rather than let a
   * stale payload smuggle one in.
   */
  function assertHirePayloadOmitsInternalFlags(payload: unknown) {
    if (typeof payload !== "object" || payload === null) return;
    if ("autoProvisionDefaultKey" in (payload as Record<string, unknown>)) {
      throw badRequest(
        "Hire approval payloads must not set autoProvisionDefaultKey; the field was removed and is no longer honored",
      );
    }
  }

  /**
   * AgentDash-MK: a `connector_send` must name a connector that can execute it.
   *
   * The payload schema is an open record, so without this an agent could file
   * `{ to, body, channel: "teams" }`: a steward approves it, no executor exists
   * for it, and nobody is told nothing was sent. Refused here, where the agent
   * that wrote it is still the one reading the answer.
   */
  function assertConnectorSendPayloadExecutable(payload: unknown) {
    const check = checkConnectorSendPayload(payload);
    if (check.ok) return;
    throw unprocessable(check.message, {
      code: `connector_send_${check.problem}`,
      supportedProviders: [...CONNECTOR_SEND_PROVIDERS],
    });
  }

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    // Agent visibility (GH #916): a request raised by an agent the actor
    // cannot see is not theirs to decide — 404, exactly as GET /approvals/:id.
    if (approval.requestedByAgentId) {
      await assertAgentIdVisible(db, req, approval.requestedByAgentId, "Approval");
    }
    // AgentDash (GH #902): a budget override for a hidden project does not exist.
    await assertApprovalProjectVisible(db, req, approval);
    return approval;
  }

  // AgentDash (#1054): connector provenance is selected by authenticated
  // connector code, never by a JSON claim at the public REST boundary.
  function assertRestDecisionChannel(channel: unknown) {
    if (channel !== undefined && channel !== "web" && channel !== "assistant") {
      throw forbidden("REST approval decisions cannot claim a connector channel");
    }
    // The authority service separately requires an authenticated assistant
    // grant for "assistant". Do not weaken that check or internal connectors.
  }

  /** Decision provenance recorded alongside the status change. */
  function decisionMeta(
    context: Awaited<ReturnType<typeof authority.requireDecisionAuthority>>,
    overrideReason?: string | null,
  ) {
    return {
      revision: context.revision,
      channel: context.channel,
      idempotencyKey: context.idempotencyKey,
      actorRole: context.role,
      ...(overrideReason !== undefined ? { overrideReason } : {}),
    };
  }

  async function approveWithTierCapacity(
    id: string,
    existingApproval: Awaited<ReturnType<typeof svc.getById>>,
    decidedByUserId: string,
    decisionNote: string | null | undefined,
    res: import("express").Response,
    meta: Parameters<typeof svc.approve>[3] = {},
  ) {
    if (!existingApproval) return null;
    if (!hireApprovalCreatesAgent(existingApproval) || isBillingDisabled()) {
      return svc.approve(id, decidedByUserId, decisionNote, meta);
    }

    return withCompanyTierCapacityLock(db, existingApproval.companyId, async (dbOrTx) => {
      const txSvc = approvalService(dbOrTx);
      const lockedApproval = await txSvc.getById(id);
      if (!lockedApproval) {
        res.status(404).json({ error: "Approval not found" });
        return null;
      }
      if (!hireApprovalCreatesAgent(lockedApproval)) {
        return txSvc.approve(id, decidedByUserId, decisionNote, meta);
      }

      const blockedAction = await exceededFreeTierCapacityAction(
        buildRequireTierDeps(dbOrTx),
        lockedApproval.companyId,
        { agents: 1 },
      );
      if (blockedAction) {
        res.status(402).json(freeTierCapExceededPayload(blockedAction));
        return null;
      }

      return txSvc.approve(id, decidedByUserId, decisionNote, meta);
    });
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    // AgentDash (GH #902): budget overrides for a restricted project carry its
    // name, id and spend — they follow the project rule.
    const result = await svc.list(companyId, status, {
      visibleWhere: approvalVisibilityCondition(req, companyId),
    });
    // Agent visibility (2026-09-30): a request raised by an agent the actor
    // cannot see is not theirs to know about.
    const visibleIds = await visibleAgentIdsFor(db, req, companyId);
    const visible =
      visibleIds === null
        ? result
        : result.filter((approval) => !approval.requestedByAgentId || visibleIds.has(approval.requestedByAgentId));
    const canReadSpend = await canReadCompanySpend(db, req, companyId);
    res.json(visible.map((approval) => approvalResponse(approval, canReadSpend)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (approval.requestedByAgentId) {
      await assertAgentIdVisible(db, req, approval.requestedByAgentId, "Approval");
    }
    // AgentDash (GH #902): 404 for a budget override on a hidden project.
    await assertApprovalProjectVisible(db, req, approval);
    res.json(approvalResponse(approval, await canReadCompanySpend(db, req, approval.companyId)));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    // A5 (GH #830): an approval cannot be linked to an issue the requester
    // cannot see — 404, as POST /issues/:id/approvals answers.
    for (const issueId of uniqueIssueIds) {
      await assertIssueIdVisible(db, req, issueId);
    }
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    if (approvalInput.type === "connector_send") {
      assertConnectorSendPayloadExecutable(approvalInput.payload);
    }
    if (approvalInput.type === "hire_agent") {
      assertHirePayloadHasNoHostCommands(approvalInput.payload);
      assertHirePayloadOmitsInternalFlags(approvalInput.payload);
      // AgentDash (security, #719): approving creates the agent with this
      // adapterConfig, so the requester needs the same authority a direct
      // create needs to set the binary, argv, env or cwd.
      assertHostExecutionConfigAllowed(
        req.actor,
        hirePayloadHostExecutionInputs(approvalInput.payload),
        hostExecutionContextForCompany(companyId),
      );
    }
    // GH #828 (provenance spoof): `payload.metadata.source ===
    // "assistant_hire_request"` is stamped server-side by the gated-action
    // hire path and read back by the digest to render the request as
    // assistant-made. A caller writing the tag into a free-form payload is
    // claiming provenance they did not earn — only an assistant grant may.
    assertNoAssistantProvenanceClaimInPayload(req.actor, approvalInput.payload);
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    if (actor.agentId && approvalInput.requestedByAgentId
        && approvalInput.requestedByAgentId !== actor.agentId) {
      throw forbidden("An agent can only request approvals on its own behalf");
    }
    // GH #919: create + issue links + the activity row are one unit — a link
    // failure must not leave a pending approval with no links and no record.
    // Issue visibility is still checked above on the outer db (read-only);
    // linkManyForApproval re-checks existence/company inside the tx.
    // The activity row is inserted inside the tx, but its live/plugin events
    // are published only after COMMIT: a listener that reads the approval back
    // (live-event visibility, plugins, the UI) must find it, and a rollback
    // must announce nothing. insertActivity also never initializes the
    // instance-settings singleton while this tx holds domain locks.
    const { approval, publication } = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const created = await approvalService(tx).create(companyId, {
        ...approvalInput,
        payload: normalizedPayload,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        requestedByAgentId:
          approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
        status: "pending",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (uniqueIssueIds.length > 0) {
        await issueApprovalService(tx).linkManyForApproval(created.id, uniqueIssueIds, {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
      }

      const activityPublication = await insertActivity(tx, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "approval.created",
        entityType: "approval",
        entityId: created.id,
        details: { type: created.type, issueIds: uniqueIssueIds },
      });
      return { approval: created, publication: activityPublication };
    });
    publishActivity(publication);

    await stewardInbox.recordApprovalEvent(approval.id, "approval.opened");

    // Push the card to the deciding steward's paired channels. Awaited rather
    // than fired and forgotten so a test can observe it and so the request does
    // not outlive its own side effects — the service swallows every failure
    // internally, so an unreachable provider cannot fail this response.
    await cardDelivery.deliverForApproval(approval.id);

    res.status(201).json(approvalResponse(approval, await canReadCompanySpend(db, req, approval.companyId)));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    // GH #916: company, requesting-agent and project visibility (GH #902).
    const approval = await requireApprovalAccess(req, id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    // A5 (GH #830): linked issues in a project the actor cannot see are absent.
    const issues = await filterVisibleByProject(db, req, await issueApprovalsSvc.listIssuesForApproval(id));
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    assertRestDecisionChannel(req.body.channel);
    const id = req.params.id as string;
    const existingApproval = await requireApprovalAccess(req, id);
    if (!existingApproval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decisionContext = await authority.requireDecisionAuthority(
      existingApproval,
      req.actor,
      req.body,
    );
    await assertCanDecideAgentLifecycleApproval(req, existingApproval);
    const decidedByUserId = req.actor.userId ?? "board";
    const resolution = await approveWithTierCapacity(
      id,
      existingApproval,
      decidedByUserId,
      req.body.decisionNote,
      res,
      decisionMeta(decisionContext),
    );
    if (!resolution) return;
    const { approval, applied } = resolution;

    await decisionEffects.afterApprove(approval, applied, {
      actorUserId: req.actor.userId ?? "board",
      decisionNote: req.body.decisionNote ?? null,
    });

    res.json(approvalResponse(approval, await canReadCompanySpend(db, req, approval.companyId)));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    assertRestDecisionChannel(req.body.channel);
    const id = req.params.id as string;
    const existingApproval = await requireApprovalAccess(req, id);
    if (!existingApproval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decisionContext = await authority.requireDecisionAuthority(
      existingApproval,
      req.actor,
      req.body,
    );
    await assertCanDecideAgentLifecycleApproval(req, existingApproval);
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(
      id,
      decidedByUserId,
      req.body.decisionNote,
      decisionMeta(decisionContext),
    );

    await decisionEffects.afterReject(approval, applied, {
      actorUserId: req.actor.userId ?? "board",
      decisionNote: req.body.decisionNote ?? null,
    });

    res.json(approvalResponse(approval, await canReadCompanySpend(db, req, approval.companyId)));
  });

  /**
   * AgentDash-MK emergency override.
   *
   * Deliberately a separate route rather than a flag on approve/reject: it is
   * an exceptional act, requires a stated reason, is restricted to
   * owners/administrators, and is audited under its own action so it can never
   * be mistaken for an ordinary steward decision in the history.
   */
  router.post("/approvals/:id/override", validate(overrideApprovalSchema), async (req, res) => {
    assertBoard(req);
    assertRestDecisionChannel(req.body.channel);
    const id = req.params.id as string;
    const existingApproval = await requireApprovalAccess(req, id);
    if (!existingApproval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }

    const context = await authority.requireEmergencyOverride(existingApproval, req.actor, req.body);
    await assertCanDecideAgentLifecycleApproval(req, existingApproval);
    const decidedByUserId = req.actor.userId ?? "board";
    const meta = decisionMeta(context, req.body.overrideReason);

    const resolution =
      req.body.decision === "approved"
        ? await approveWithTierCapacity(
            id,
            existingApproval,
            decidedByUserId,
            req.body.decisionNote,
            res,
            meta,
          )
        : await svc.reject(id, decidedByUserId, req.body.decisionNote, meta);
    if (!resolution) return;
    const { approval, applied } = resolution;

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: decidedByUserId,
        action: "approval.emergency_override",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          decision: req.body.decision,
          overrideReason: req.body.overrideReason,
          channel: context.channel,
          revision: context.revision,
          requestedByAgentId: approval.requestedByAgentId,
        },
      });

      await stewardInbox.recordApprovalEvent(approval.id, "approval.resolved");
      // An override is still a decision, so a bridge task must follow it. Left
      // out, an overridden approval would strand its task forever.
      try {
        if (req.body.decision === "approved") {
          await bridge.releaseApprovedTask(approval.id);
          await facts.releaseHeldFactAnswer(approval.id);
          // An override is still a decision, so a deliverable seat must follow
          // it. Left out, an overridden sign-off would strand the run forever.
          await deliverableReview.advanceDeliverableApproval(approval.id);
          await recommendations.settleRecommendationApproval(approval.id);
        } else {
          await bridge.declineRejectedTask(approval.id, req.body.overrideReason ?? null);
          await facts.discardHeldFactAnswer(approval.id, req.body.overrideReason ?? null);
          await deliverableReview.failDeliverableApproval(
            approval.id,
            req.body.overrideReason ?? null,
          );
          await recommendations.settleRecommendationApproval(approval.id);
        }
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "bridge task settlement failed after override; task may be stranded",
        );
      }
    }

    res.json(approvalResponse(approval, await canReadCompanySpend(db, req, approval.companyId)));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const existingApproval = await requireApprovalAccess(req, id);
      if (!existingApproval) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      // Requesting revision stamps decidedByUserId/decidedAt and moves the
      // approval out of `pending`, so it is decision-adjacent and needs the
      // same actor rules — otherwise any member could make themselves the
      // decider-of-record on another steward's approval.
      await authority.requireDecisionActor(existingApproval, req.actor);
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(approvalResponse(approval, await canReadCompanySpend(db, req, approval.companyId)));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    // GH #916: an approval the actor cannot see (hidden requesting agent or
    // hidden project) is 404 here too — resubmitting it would kill every
    // in-flight card and echo back the payload GET answers 404 for.
    const existing = await requireApprovalAccess(req, id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }
    // A resubmit now advances the revision, which invalidates every in-flight
    // card. Without an authority check that is a decision-denial vector for any
    // ordinary member, so board callers must satisfy the same actor rules.
    if (req.actor.type === "board") {
      await authority.requireDecisionActor(existing, req.actor);
    }

    // AgentDash (GH #828): a resubmit replaces the stored payload, so it may not
    // claim assistant provenance either.
    assertNoAssistantProvenanceClaimInPayload(req.actor, req.body.payload);
    // Resubmitting without a payload re-opens the stored one, so that is what
    // must be executable.
    if (existing.type === "connector_send") {
      assertConnectorSendPayloadExecutable(req.body.payload ?? existing.payload);
    }
    if (existing.type === "hire_agent" && req.body.payload) {
      assertHirePayloadHasNoHostCommands(req.body.payload);
      assertHirePayloadOmitsInternalFlags(req.body.payload);
      assertHostExecutionConfigAllowed(
        req.actor,
        hirePayloadHostExecutionInputs(req.body.payload, existing.payload),
        hostExecutionContextForCompany(existing.companyId),
      );
    }
    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });

    await stewardInbox.recordApprovalEvent(approval.id, "approval.opened");

    // A resubmit advances the revision, which kills every card already sent.
    // Without a fresh one the steward is left holding buttons that now fail
    // closed with no explanation of what replaced them.
    await cardDelivery.deliverForApproval(approval.id);

    res.json(approvalResponse(approval, await canReadCompanySpend(db, req, approval.companyId)));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    // GH #916: same visibility rule as GET /approvals/:id (GH #902 included).
    const approval = await requireApprovalAccess(req, id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    // GH #916: same visibility rule as GET /approvals/:id (GH #902 included).
    const approval = await requireApprovalAccess(req, id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
