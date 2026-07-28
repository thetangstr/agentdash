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
import { approvalAuthorityService } from "../services/approval-authority.js";
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
  // AgentDash-MK: the single decision boundary. Web, Telegram, and Teams all
  // resolve authority here; provider routes never update approval rows directly.
  const authority = approvalAuthorityService(db);
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
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
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
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
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
