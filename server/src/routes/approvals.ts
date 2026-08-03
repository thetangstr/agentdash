import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
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
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { buildRequireTierDeps } from "../middleware/build-tier-deps.js";
import {
  exceededFreeTierCapacityAction,
  freeTierCapExceededPayload,
  isBillingDisabled,
  withCompanyTierCapacityLock,
} from "../services/tier-policy.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; autoDispatchQueuedRuns?: boolean } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const cardDelivery = approvalCardDeliveryService(db);
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

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
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
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    if (approvalInput.type === "hire_agent") {
      assertHirePayloadHasNoHostCommands(approvalInput.payload);
    }
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
    const approval = await svc.create(companyId, {
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
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    // Push the card to the deciding steward's paired channels. Awaited rather
    // than fired and forgotten so a test can observe it and so the request does
    // not outlive its own side effects — the service swallows every failure
    // internally, so an unreachable provider cannot fail this response.
    await cardDelivery.deliverForApproval(approval.id);

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
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

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.type === "mandate_violation" && approval.requestedByAgentId) {
        try {
          await agentService(db).resume(approval.requestedByAgentId);
        } catch {
          /* already resumed/terminated — non-fatal */
        }
      }

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    // AgentDash-MK: an approved bridge `act` task becomes visible to polling.
    // Until this runs the task is `awaiting_approval` and no endpoint can see
    // it, which is what keeps the bridge from having a private path to action.
    if (applied) {
      // Logged rather than thrown: the decision is already committed, so a 500
      // here would tell the client their approval failed when it did not. But
      // this is NOT best-effort the way a notification is — a release that
      // fails strands the task invisibly, so it is an error-level event, not a
      // warning to scroll past.
      try {
        await bridge.releaseApprovedTask(approval.id);
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "bridge task release failed after approval; task may be stranded",
        );
      }
      // Released still framed: the decision was that this content may travel,
      // not that it stopped being untrusted.
      try {
        await facts.releaseHeldFactAnswer(approval.id);
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "held fact answer release failed after approval; the fact may be stranded",
        );
      }
      // AgentDash-MK: one seat of a deliverable's two-approver sign-off. The
      // first approval opens the second seat; the second ships. Error-level
      // rather than best-effort: a failure here strands a run that two people
      // believe they approved.
      try {
        await deliverableReview.advanceDeliverableApproval(approval.id);
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "deliverable approval advance failed; the run may be stranded mid-approval",
        );
      }
      // AgentDash-MK: a recommendation the pipeline owner agreed with. This
      // records the agreement and stops — there is no branch anywhere that
      // acts on one, which is the whole of what "advisory" means here.
      try {
        await recommendations.settleRecommendationApproval(approval.id);
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "recommendation settlement failed; it may stay open after being decided",
        );
      }
    }

    if (applied && approval.type === "connector_send") {
      // Executed here rather than inside the approval service, so the service
      // stays the decision boundary and nothing else. Awaited so the response
      // does not outlive its own side effect; the executor swallows every
      // failure internally, so an unreachable provider cannot fail this call.
      await connectorSend.executeForApproval(approval.id);
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
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

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
      // A rejected bridge task terminates carrying the steward's reason, so the
      // requesting agent can read WHY rather than watch a request vanish.
      try {
        await bridge.declineRejectedTask(approval.id, req.body.decisionNote ?? null);
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "bridge task decline failed after rejection; task may be stranded",
        );
      }
      // A refused release destroys the content and declines the fact, flagged.
      // Left held it would be a figure nobody can ever obtain and nobody can
      // see is outstanding.
      try {
        await facts.discardHeldFactAnswer(approval.id, req.body.decisionNote ?? null);
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "held fact answer discard failed after rejection; the fact may be stranded",
        );
      }
      // AgentDash-MK: a refused deliverable goes back to collection with its
      // verdict cleared, not to the second approver and not to the bin. A
      // weekly artifact that is wrong on Tuesday should still ship on Wednesday.
      try {
        await deliverableReview.failDeliverableApproval(approval.id, req.body.decisionNote ?? null);
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "deliverable rejection handling failed; the run may be stranded awaiting approval",
        );
      }
      // A declined recommendation. It comes back only if the condition gets
      // worse, never merely because the tick came round again.
      try {
        await recommendations.settleRecommendationApproval(approval.id);
      } catch (err) {
        logger.error(
          { err, approvalId: approval.id },
          "recommendation settlement failed; it may stay open after being declined",
        );
      }
    }

    res.json(redactApprovalPayload(approval));
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

    res.json(redactApprovalPayload(approval));
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

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

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

    if (existing.type === "hire_agent" && req.body.payload) {
      assertHirePayloadHasNoHostCommands(req.body.payload);
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

    // A resubmit advances the revision, which kills every card already sent.
    // Without a fresh one the steward is left holding buttons that now fail
    // closed with no explanation of what replaced them.
    await cardDelivery.deliverForApproval(approval.id);

    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
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
