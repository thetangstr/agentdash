import { issueCurrentAuthority } from "../services/issue-current-authority.js";
import { issuePatchActions, updateIssueRouteSchema, type IssuePatchContext } from "../services/issue-patch-actions.js";
import {
  issueCommentActions,
  IssueCommentPolicyRefusal,
  summarizeIssueRelationForActivity,
  summarizeIssueReferenceActivityDetails,
} from "../services/issue-mutation-actions.js";
import { dispatchResolvedInteractionContinuation } from "../services/human-control/question-continuation.js";
import { assertHostExecutionConfigAllowed } from "../services/adapter-host-execution-policy.js";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { assertProjectIdVisible, projectScopedVisibilityCondition } from "./visibility.js";
import { decodeShippedCursor } from "../services/work-products.js";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  cancelIssueThreadInteractionSchema,
  createIssueAttachmentMetadataSchema,
  createIssueThreadInteractionSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createChildIssueSchema,
  createIssueSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  rejectIssueThreadInteractionSchema,
  restoreIssueDocumentRevisionSchema,
  respondIssueThreadInteractionSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ExecutionWorkspace,
  ASSISTANT_WORK_ORIGIN_KIND,
} from "@paperclipai/shared";
// AgentDash: goals-eval-hitl
import { definitionOfDoneSchema } from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
// AgentDash: goals-eval-hitl
import { verdictsService } from "../services/verdicts.js";
import { featureFlagsService } from "../services/feature-flags.js";
import { cosReviewerAutoHire } from "../services/cos-reviewer-auto-hire.js";
import { cosVerdictOrchestrator } from "../services/cos-verdict-orchestrator.js";
import * as serviceIndex from "../services/index.js";
import {
  accessService,
  agentService,
  companyService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueThreadInteractionService,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueReferenceService,
  issueService,
  clampIssueListLimit,
  documentService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { logger } from "../middleware/logger.js";
import { conflict, forbidden, HttpError, notFound, unauthorized } from "../errors.js";
import { isUniqueViolation, pgConstraintName } from "../lib/pg-error.js";
import { assertCanSetCompanyDirection, assertBoard, assertCompanyAccess, assistantGrantAttribution, getActorInfo, reportAuthzRefusal } from "./authz.js";
import {
  WorkspaceFileError,
  contentTypeForWorkspaceFile,
  resolveAgentWorkspaceFile,
} from "../lib/agent-workspace-files.js";
import { absoluteUrl } from "../lib/public-base-url.js";
import {
  assertHostWorkspaceCommandAuthority,
  collectIssueWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import {
  isInlineAttachmentContentType,
  normalizeIssueAttachmentMaxBytes,
  normalizeContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { executionWorkspaceService as executionWorkspaceServiceDirect } from "../services/execution-workspaces.js";
import { feedbackService } from "../services/feedback.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentService } from "../services/environments.js";
import {
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;

/**
 * AgentDash (GH #745 review): server-side dedup key for assistant-grant
 * issue creates that arrive without an explicit requestId. Scoped to the
 * grant + normalized title/description + parent/project/assignee inside a
 * 10-minute bucket, matching the reviewer's suggestion — a network retry
 * inside the window replays the original issue instead of filing a
 * duplicate, while two genuinely distinct tasks never collide.
 */
const ASSISTANT_REQUEST_ID_WINDOW_MS = 10 * 60 * 1000;
function deriveAssistantIssueRequestId(input: {
  grantId: string;
  title: string;
  parentId: string | null;
  projectId: string | null;
  assigneeAgentId: string | null;
  description: string | null;
}): string {
  const normalizedTitle = input.title.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedDescription = (input.description ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const window = Math.floor(Date.now() / ASSISTANT_REQUEST_ID_WINDOW_MS);
  return createHash("sha256")
    .update(
      `${input.grantId}\n${normalizedTitle}\n${normalizedDescription}\n${input.parentId ?? ""}\n${input.projectId ?? ""}\n${input.assigneeAgentId ?? ""}\n${window}`,
    )
    .digest("hex")
    .slice(0, 32);
}

function isExplicitResumeCapableStatus(status: string | null | undefined) {
  return status === "done" || status === "blocked" || status === "todo" || status === "in_progress";
}

function queueResolvedInteractionContinuationWakeup(input: Parameters<typeof dispatchResolvedInteractionContinuation>[0]) {
  void dispatchResolvedInteractionContinuation(input)?.catch((err) => logger.warn({
    err, issueId: input.issue.id, interactionId: input.interaction.id,
    agentId: input.issue.assigneeAgentId,
  }, "failed to wake assignee on issue interaction resolution"));
}

// AgentDash (security, #719): issue override config carries the same host
// execution gate as the assignee adapter's config.
function assertIssueOverrideHostExecutionAllowed(req: Request, storedOverrides: unknown) {
  const overrides = (req.body as Record<string, unknown> | undefined)?.assigneeAdapterOverrides;
  if (typeof overrides !== "object" || overrides === null) return;
  const stored =
    typeof storedOverrides === "object" && storedOverrides !== null
      ? (storedOverrides as Record<string, unknown>).adapterConfig
      : undefined;
  assertHostExecutionConfigAllowed(req.actor, {
    adapterType: null,
    adapterConfig: (overrides as Record<string, unknown>).adapterConfig,
    stored,
    prefix: "assigneeAdapterOverrides.adapterConfig",
  });
}

// AgentDash: finite native question entry points bind their actual Request.
import { foundationAuthority } from '../services/human-control/authority.js';
import { insertActivity, publishActivity, type ActivityPublication } from '../services/activity-log.js';
import type { QuestionWriteGuards } from '../services/issue-thread-interactions.js';
import type { ActivityAcceptance } from '../services/workforce.js';

export function issueRoutes(
  db: Db,
  storage: StorageService,
  opts: {
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    pluginWorkerManager?: PluginWorkerManager;
  } = {},
) {
  const router = Router();
  const svc = issueService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const feedback = feedbackService(db);
  const companiesSvc = companyService(db);
  const instanceSettings = instanceSettingsService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const executionWorkspacesSvc = executionWorkspaceServiceDirect(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const issueReferencesSvc = issueReferenceService(db);
  // AgentDash: goals-eval-hitl
  const verdictsSvc = verdictsService(db);
  const featureFlagsSvc = featureFlagsService(db);
  const reviewerAutoHireSvc = cosReviewerAutoHire(db);
  const cosVerdictOrchestratorSvc = cosVerdictOrchestrator(db, {
    verdicts: verdictsSvc,
    featureFlags: featureFlagsSvc,
    autoHire: reviewerAutoHireSvc,
  });
  const routinesSvc = routineService(db, {
    pluginWorkerManager: opts.pluginWorkerManager,
  });
  const issueTreeControlFactory = Object.prototype.hasOwnProperty.call(
    serviceIndex,
    "issueTreeControlService",
  )
    ? serviceIndex.issueTreeControlService
    : undefined;
  const treeControlSvc = issueTreeControlFactory?.(db) ?? {
    getActivePauseHoldGate: async () => null,
  };
  const feedbackExportService = opts?.feedbackExportService;
  const environmentsSvc = environmentService(db);
  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function parseBooleanQuery(value: unknown) {
    return value === true || value === "true" || value === "1";
  }

  async function assertIssueEnvironmentSelection(
    companyId: string,
    environmentId: string | null | undefined,
  ) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(
      environmentsSvc,
      companyId,
      environmentId,
      { allowedDrivers: ["local", "ssh", "sandbox"] },
    );
  }

  async function logExpiredRequestConfirmations(input: {
    issue: { id: string; companyId: string; identifier?: string | null };
    interactions: Array<{ id: string; kind: string; status: string; result?: unknown }>;
    actor: ReturnType<typeof getActorInfo>;
    source: string;
  }) {
    for (const interaction of input.interactions) {
      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        agentId: input.actor.agentId,
        runId: input.actor.runId,
        action: "issue.thread_interaction_expired",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          identifier: input.issue.identifier ?? null,
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          source: input.source,
          result: interaction.result ?? null,
        },
      });
    }
  }

  function parseDateQuery(value: unknown, field: string) {
    if (typeof value !== "string" || value.trim().length === 0) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new HttpError(400, `Invalid ${field} query value`);
    }
    return parsed;
  }

  async function runSingleFileUpload(req: Request, res: Response, fileSizeLimit: number) {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: fileSizeLimit, files: 1 },
    });
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, companyId: string) {
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.companyId !== companyId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === companyId;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, companyId: string, policyDb?: Db) {
    // Composed acceptance is already bound to the authenticated source company.
    // Keep refusal telemetry outside its read-only policy preparation.
    if (!policyDb) assertCompanyAccess(req, companyId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await (policyDb ? accessService(policyDb) : access).canUser(companyId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await (policyDb ? accessService(policyDb) : access).hasPermission(companyId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await (policyDb ? agentService(policyDb) : agentsSvc).getById(req.actor.agentId);
      if (actorAgent && actorAgent.companyId === companyId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  /**
   * AgentDash: may this create hand an unowned `todo` to the Chief of Staff?
   * Routing assigns the CoS and wakes it with text the caller wrote, so it
   * takes the same `tasks:assign` authority as naming an assignee yourself.
   * Without it the issue is created unowned, exactly as before. Never throws:
   * the answer is only ever "route" or "don't".
   */
  async function callerMayRouteToChiefOfStaff(
    req: Request,
    companyId: string,
    input: { assigneeAgentId?: string | null; assigneeUserId?: string | null },
  ): Promise<boolean> {
    if (input.assigneeAgentId || input.assigneeUserId) return false;
    try {
      await assertCanAssignTasks(req, companyId);
      return true;
    } catch {
      return false;
    }
  }

  function wasRoutedToChiefOfStaff(
    input: { assigneeAgentId?: string | null; assigneeUserId?: string | null },
    issue: { assigneeAgentId: string | null },
  ): boolean {
    return !input.assigneeAgentId && !input.assigneeUserId && Boolean(issue.assigneeAgentId);
  }

  function respondIssueMutationPolicy(res: Response, policyDb: Db | undefined, status: number, body: Record<string, unknown>) {
    if (policyDb) throw new IssueCommentPolicyRefusal(status, body);
    return res.status(status).json(body);
  }

  function requireAgentRunId(req: Request, res: Response, policyDb?: Db) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    respondIssueMutationPolicy(res, policyDb, 401, { error: "Agent run id required" });
    return null;
  }

  async function hasActiveCheckoutManagementOverride(
    actorAgentId: string,
    companyId: string,
    assigneeAgentId: string,
    policyDb?: Db,
  ) {
    const allowedByGrant = await (policyDb ? accessService(policyDb) : access).hasPermission(
      companyId,
      "agent",
      actorAgentId,
      "tasks:manage_active_checkouts",
    );
    if (allowedByGrant) return true;

    const companyAgents = await (policyDb ? agentService(policyDb) : agentsSvc).list(companyId);
    const agentsById = new Map(companyAgents.map((agent) => [agent.id, agent]));
    const actorAgent = agentsById.get(actorAgentId);
    if (!actorAgent) return false;
    if (canCreateAgentsLegacy(actorAgent)) return true;

    // Reporting-chain managers may intervene in an agent's active checkout
    // without taking the task over. Peers must own the checkout/run first.
    let cursor: string | null = assigneeAgentId;
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      const assignee = agentsById.get(cursor);
      if (!assignee) return false;
      if (assignee.reportsTo === actorAgentId) return true;
      cursor = assignee.reportsTo;
    }

    return false;
  }

  async function assertAgentIssueMutationAllowed(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
    policyDb?: Db,
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      respondIssueMutationPolicy(res, policyDb, 403, { error: "Agent authentication required" });
      return false;
    }
    if (issue.assigneeAgentId === null) {
      return true;
    }
    if (issue.assigneeAgentId !== actorAgentId) {
      if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId, policyDb)) {
        return true;
      }
      // AGE-91: an agent mutating another agent's issue is a P6-class authority
      // refusal — record it like the authz guards do (fire-and-forget; the
      // response below is untouched). The 409 on an in_progress issue is
      // checkout contention between agents, a lock conflict rather than a
      // denial of authority, and is deliberately not recorded as a refusal.
      if (!policyDb && issue.status !== "in_progress") {
        reportAuthzRefusal(req, {
          companyId: issue.companyId,
          entityType: "issue",
          entityId: issue.id,
          reasonCode: "ISSUE_MUTATION_OTHER_AGENT",
        });
      }
      if (issue.status === "in_progress") {
        respondIssueMutationPolicy(res, policyDb, 409, {
          error: "Issue is checked out by another agent",
          details: {
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            actorAgentId,
          },
        });
      } else {
        respondIssueMutationPolicy(res, policyDb, 403, {
          error: "Agent cannot mutate another agent's issue",
          details: {
            issueId: issue.id,
            assigneeAgentId: issue.assigneeAgentId,
            actorAgentId,
            status: issue.status,
            securityPrinciples: ["Least Privilege", "Complete Mediation", "Fail Securely"],
          },
        });
      }
      return false;
    }
    if (issue.status !== "in_progress") {
      return true;
    }
    const runId = requireAgentRunId(req, res, policyDb);
    if (!runId) return false;
    if (policyDb) {
      await svc.evaluateCheckoutOwner(issue.id, actorAgentId, runId, policyDb);
      return true;
    }
    const ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  async function assertExplicitResumeIntentAllowed(
    req: Request,
    res: Response,
    issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null },
    policyDb?: Db,
  ) {
    if (issue.status === "cancelled") {
      respondIssueMutationPolicy(res, policyDb, 409, {
        error: "Cancelled issues must be restored through the dedicated restore flow",
        details: {
          issueId: issue.id,
          status: issue.status,
        },
      });
      return false;
    }

    if (!isExplicitResumeCapableStatus(issue.status)) {
      respondIssueMutationPolicy(res, policyDb, 409, {
        error: "Issue is not resumable through comment follow-up intent",
        details: { issueId: issue.id, status: issue.status },
      });
      return false;
    }

    const activePauseHold = await (policyDb ? serviceIndex.issueTreeControlService(policyDb) : treeControlSvc).getActivePauseHoldGate(issue.companyId, issue.id);
    if (activePauseHold) {
      respondIssueMutationPolicy(res, policyDb, 409, {
        error: "Issue follow-up blocked by active subtree pause hold",
        details: {
          issueId: issue.id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
        },
      });
      return false;
    }

    if (issue.status === "blocked") {
      const readiness = await svc.getDependencyReadiness(issue.id, policyDb ?? db);
      if (readiness.unresolvedBlockerCount > 0) {
        respondIssueMutationPolicy(res, policyDb, 409, {
          error: "Issue follow-up blocked by unresolved blockers",
          details: {
            issueId: issue.id,
            unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
          },
        });
        return false;
      }
    }

    if (req.actor.type !== "agent") return true;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      respondIssueMutationPolicy(res, policyDb, 403, { error: "Agent authentication required" });
      return false;
    }
    if (!issue.assigneeAgentId) {
      respondIssueMutationPolicy(res, policyDb, 409, {
        error: "Issue follow-up requires an assigned agent",
        details: { issueId: issue.id, actorAgentId },
      });
      return false;
    }
    if (issue.assigneeAgentId === actorAgentId) return true;
    if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId, policyDb)) {
      return true;
    }

    respondIssueMutationPolicy(res, policyDb, 403, {
      error: "Agent cannot request follow-up for another agent's issue",
      details: {
        issueId: issue.id,
        assigneeAgentId: issue.assigneeAgentId,
        actorAgentId,
      },
    });
    return false;
  }

  async function resolveActiveIssueRun(issue: {
    id: string;
    assigneeAgentId: string | null;
    executionRunId?: string | null;
  }) {
    let runToInterrupt = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;

    if ((!runToInterrupt || runToInterrupt.status !== "running") && issue.assigneeAgentId) {
      const activeRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const activeIssueId =
        activeRun &&
        activeRun.contextSnapshot &&
        typeof activeRun.contextSnapshot === "object" &&
        typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      if (activeRun && activeRun.status === "running" && activeIssueId === issue.id) {
        runToInterrupt = activeRun;
      }
    }

    return runToInterrupt?.status === "running" ? runToInterrupt : null;
  }

  async function normalizeIssueAssigneeAgentReference(
    companyId: string,
    rawAssigneeAgentId: string | null | undefined,
  ) {
    if (rawAssigneeAgentId === undefined || rawAssigneeAgentId === null) {
      return rawAssigneeAgentId;
    }

    const raw = rawAssigneeAgentId.trim();
    if (raw.length === 0) {
      return rawAssigneeAgentId;
    }

    const resolved = await agentsSvc.resolveByReference(companyId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this company. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }
  function toValidTimestamp(value: Date | string | null | undefined) {
    if (!value) return null;
    const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function isQueuedIssueCommentForActiveRun(params: {
    comment: {
      authorAgentId?: string | null;
      createdAt?: Date | string | null;
    };
    activeRun: {
      agentId?: string | null;
      startedAt?: Date | string | null;
      createdAt?: Date | string | null;
    };
  }) {
    const activeRunStartedAtMs =
      toValidTimestamp(params.activeRun.startedAt) ?? toValidTimestamp(params.activeRun.createdAt);
    const commentCreatedAtMs = toValidTimestamp(params.comment.createdAt);

    if (activeRunStartedAtMs === null || commentCreatedAtMs === null) return false;
    if (params.comment.authorAgentId && params.comment.authorAgentId === params.activeRun.agentId) return false;
    return commentCreatedAtMs >= activeRunStartedAtMs;
  }
  async function getClosedIssueExecutionWorkspace(issue: { executionWorkspaceId?: string | null }) {
    if (!issue.executionWorkspaceId) return null;
    const workspace = await executionWorkspacesSvc.getById(issue.executionWorkspaceId);
    if (!workspace || !isClosedIsolatedExecutionWorkspace(workspace)) return null;
    return workspace;
  }

  function respondClosedIssueExecutionWorkspace(
    res: Response,
    workspace: Pick<ExecutionWorkspace, "closedAt" | "id" | "mode" | "name" | "status">,
  ) {
    res.status(409).json({
      error: getClosedIsolatedExecutionWorkspaceMessage(workspace),
      executionWorkspace: workspace,
    });
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  async function resolveIssueProjectAndGoal(issue: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = issue.projectId ? projectsSvc.getById(issue.projectId) : Promise.resolve(null);
    const directGoalPromise = issue.goalId ? goalsSvc.getById(issue.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    const projectGoalId = project?.goalId ?? project?.goalIds[0] ?? null;
    if (projectGoalId) {
      const projectGoal = await goalsSvc.getById(projectGoalId);
      return { project, goal: projectGoal };
    }

    if (!issue.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(issue.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when companyId is empty in "/api/companies/{companyId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  router.get("/companies/:companyId/issues", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const inboxArchivedByUserFilterRaw = req.query.inboxArchivedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const inboxArchivedByUserId =
      inboxArchivedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : inboxArchivedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;
    // AgentDash: goals-eval-hitl — `reviewerAgentId=me` resolves to the calling
    // agent so a CoS reviewer can list exactly the issues the queue assigned
    // to it without knowing another call surface. A literal id stays allowed:
    // the data is company-scoped and read-only either way.
    const reviewerAgentFilterRaw = req.query.reviewerAgentId as string | undefined;
    const reviewerAgentId =
      reviewerAgentFilterRaw === "me" && req.actor.type === "agent"
        ? req.actor.agentId
        : reviewerAgentFilterRaw;
    // AgentDash: age-2 — always tell the service who is looking at the board
    // so awaitingReviewByViewer can be derived without any user filter set.
    const viewerUserId =
      req.actor.type === "board" ? req.actor.userId : undefined;
    const rawLimit = req.query.limit as string | undefined;
    const parsedLimit = rawLimit !== undefined && /^\d+$/.test(rawLimit)
      ? Number.parseInt(rawLimit, 10)
      : null;
    const limit = parsedLimit === null ? ISSUE_LIST_DEFAULT_LIMIT : clampIssueListLimit(parsedLimit);
    const rawOffset = req.query.offset as string | undefined;
    const parsedOffset = rawOffset !== undefined && /^\d+$/.test(rawOffset)
      ? Number.parseInt(rawOffset, 10)
      : null;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (inboxArchivedByUserFilterRaw === "me" && (!inboxArchivedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "inboxArchivedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }
    if (reviewerAgentFilterRaw === "me" && (!reviewerAgentId || req.actor.type !== "agent")) {
      res.status(403).json({ error: "reviewerAgentId=me requires agent authentication" });
      return;
    }
    if (rawLimit !== undefined && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      res.status(400).json({ error: `limit must be a positive integer up to ${ISSUE_LIST_MAX_LIMIT}` });
      return;
    }
    if (rawOffset !== undefined && (parsedOffset === null || !Number.isInteger(parsedOffset) || parsedOffset < 0)) {
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }
    const offset = parsedOffset ?? 0;

    const result = await svc.list(companyId, {
      // A5: issues inside a restricted project vanish for actors off its list.
      visibleWhere: projectScopedVisibilityCondition(req, companyId, issues.projectId),
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      reviewerAgentId,
      assigneeUserId,
      touchedByUserId,
      inboxArchivedByUserId,
      unreadForUserId,
      viewerUserId,
      projectId: req.query.projectId as string | undefined,
      workspaceId: req.query.workspaceId as string | undefined,
      executionWorkspaceId: req.query.executionWorkspaceId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      descendantOf: req.query.descendantOf as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      includeRoutineExecutions:
        req.query.includeRoutineExecutions === "true" || req.query.includeRoutineExecutions === "1",
      excludeRoutineExecutions:
        req.query.excludeRoutineExecutions === "true" || req.query.excludeRoutineExecutions === "1",
      includeBlockedBy: req.query.includeBlockedBy === "true" || req.query.includeBlockedBy === "1",
      // AgentDash: age-2 — the steward chip is a human-UI affordance. Join it
      // for board viewers only; agents and API-key callers never render it.
      includeAssigneeSteward: req.actor.type === "board",
      q: req.query.q as string | undefined,
      limit,
      offset,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/labels", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listLabels(companyId);
    res.json(result);
  });

  router.post("/companies/:companyId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const label = await svc.createLabel(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const currentExecutionWorkspacePromise = issue.executionWorkspaceId
      ? executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : Promise.resolve(null);
    const [
      { project, goal },
      ancestors,
      commentCursor,
      wakeComment,
      relations,
      blockerAttention,
      productivityReview,
      attachments,
      continuationSummary,
      currentExecutionWorkspace,
    ] =
      await Promise.all([
        resolveIssueProjectAndGoal(issue),
        svc.getAncestors(issue.id),
        svc.getCommentCursor(issue.id),
        wakeCommentId ? svc.getComment(wakeCommentId) : null,
        svc.getRelationSummaries(issue.id),
        svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
        svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
        svc.listAttachments(issue.id),
        documentsSvc.getIssueDocumentByKey(issue.id, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
        currentExecutionWorkspacePromise,
      ]);

    res.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        ...(blockerAttention ? { blockerAttention } : {}),
        productivityReview,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: issue.parentId,
        blockedBy: relations.blockedBy,
        blocks: relations.blocks,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        originKind: issue.originKind,
        originId: issue.originId,
        updatedAt: issue.updatedAt,
      },
      ancestors: ancestors.map((ancestor) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      commentCursor,
      wakeComment:
        wakeComment && wakeComment.issueId === issue.id
          ? wakeComment
          : null,
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        contentType: a.contentType,
        byteSize: a.byteSize,
        contentPath: withContentPath(a).contentPath,
        createdAt: a.createdAt,
      })),
      continuationSummary: continuationSummary
        ? {
            key: continuationSummary.key,
            title: continuationSummary.title,
            body: continuationSummary.body,
            latestRevisionId: continuationSummary.latestRevisionId,
            latestRevisionNumber: continuationSummary.latestRevisionNumber,
            updatedAt: continuationSummary.updatedAt,
          }
        : null,
      currentExecutionWorkspace,
    });
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    // A5: 404, never 403 — an issue in a restricted project does not exist
    // for actors off the project's access list.
    await assertProjectIdVisible(db, req, issue.companyId, issue.projectId);
    const [
      { project, goal },
      ancestors,
      mentionedProjectIds,
      documentPayload,
      relations,
      blockerAttention,
      productivityReview,
      referenceSummary,
    ] = await Promise.all([
      resolveIssueProjectAndGoal(issue),
      svc.getAncestors(issue.id),
      svc.findMentionedProjectIds(issue.id, { includeCommentBodies: false }),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id),
      svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
      issueReferencesSvc.listIssueReferenceSummary(issue.id),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json({
      ...issue,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...(blockerAttention ? { blockerAttention } : {}),
      productivityReview,
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentExecutionWorkspace,
      workProducts,
    });
  });

  /**
   * Complete child contributions for a parent issue.
   *
   * This is the retrieval path design section 12 requires: the parent agent
   * fetches full comments, documents, and work products with author
   * provenance, rather than consolidating from the truncated summary that used
   * to ride along in the wake payload.
   */
  router.get("/issues/:id/child-contributions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    res.json(await svc.listChildContributions(issue.companyId, issue.id));
  });

  // AgentDash: UX-2 (#783) — the company-wide Shipped feed. Company-scoped,
  // and restricted-project visibility applies exactly as on the issue list.
  router.get("/companies/:companyId/work-products", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const readUuid = (key: string): string | undefined | null => {
      const raw = req.query[key];
      if (raw === undefined || raw === "") return undefined;
      return typeof raw === "string" && UUID_RE.test(raw) ? raw : null;
    };
    const projectId = readUuid("projectId");
    const agentId = readUuid("agentId");
    const issueId = readUuid("issueId");
    if (projectId === null || agentId === null || issueId === null) {
      res.status(400).json({ error: "projectId, agentId and issueId must be UUIDs" });
      return;
    }
    const rawLimit = req.query.limit as string | undefined;
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return;
    }
    const rawSince = typeof req.query.since === "string" && req.query.since ? req.query.since : null;
    const since = rawSince ? new Date(rawSince) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      res.status(400).json({ error: "since must be an ISO 8601 timestamp" });
      return;
    }
    const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;
    if (before && !decodeShippedCursor(before)) {
      res.status(400).json({ error: "before is not a valid cursor" });
      return;
    }
    res.json(
      await workProductsSvc.listForCompany(companyId, {
        visibleWhere: projectScopedVisibilityCondition(req, companyId, issues.projectId),
        projectId,
        agentId,
        issueId,
        since,
        limit,
        before,
      }),
    );
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const docs = await documentsSvc.listIssueDocuments(issue.id, {
      includeSystem: req.query.includeSystem === "true",
    });
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      createdByRunId: actor.runId ?? null,
    });
    const doc = result.document;
    await issueReferencesSvc.syncDocument(doc.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: result.created ? "issue.document_created" : "issue.document_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: doc.key,
        documentId: doc.id,
        title: doc.title,
        format: doc.format,
        revisionNumber: doc.latestRevisionNumber,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    if (!result.created) {
      const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
        issue,
        {
          id: doc.id,
          key: doc.key,
          latestRevisionId: doc.latestRevisionId,
          latestRevisionNumber: doc.latestRevisionNumber,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.document_updated",
      });
    }

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.post(
    "/issues/:id/documents/:key/revisions/:revisionId/restore",
    validate(restoreIssueDocumentRevisionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const revisionId = req.params.revisionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
      if (!keyParsed.success) {
        res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
        return;
      }

      const actor = getActorInfo(req);
      const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const result = await documentsSvc.restoreIssueDocumentRevision({
        issueId: issue.id,
        key: keyParsed.data,
        revisionId,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      await issueReferencesSvc.syncDocument(result.document.id);
      const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
      const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.document_restored",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: result.document.key,
          documentId: result.document.id,
          title: result.document.title,
          format: result.document.format,
          revisionNumber: result.document.latestRevisionNumber,
          restoredFromRevisionId: result.restoredFromRevisionId,
          restoredFromRevisionNumber: result.restoredFromRevisionNumber,
          ...summarizeIssueReferenceActivityDetails({
            addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
            removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
            currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
          }),
        },
      });

      const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
        issue,
        {
          id: result.document.id,
          key: result.document.key,
          latestRevisionId: result.document.latestRevisionId,
          latestRevisionNumber: result.document.latestRevisionNumber,
        },
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );
      await logExpiredRequestConfirmations({
        issue,
        interactions: expiredInteractions,
        actor,
        source: "issue.document_restored",
      });

      res.json(result.document);
    },
  );

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const referenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    await issueReferencesSvc.deleteDocumentSource(removed.id);
    const referenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(referenceSummaryBefore, referenceSummaryAfter);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });
    const expiredInteractions = await issueThreadInteractionService(db).expireStaleRequestConfirmationsForIssueDocument(
      issue,
      {
        id: removed.id,
        key: removed.key,
        latestRevisionId: null,
        latestRevisionNumber: null,
      },
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      issue,
      interactions: expiredInteractions,
      actor,
      source: "issue.document_deleted",
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...req.body,
      projectId: req.body.projectId ?? issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const product = await workProductsSvc.update(id, req.body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(req.body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readState = await svc.markRead(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_marked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, lastReadAt: readState.lastReadAt },
    });
    res.json(readState);
  });

  router.delete("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.markUnread(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.read_unmarked",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json({ id: issue.id, removed });
  });

  router.post("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const archiveState = await svc.archiveInbox(issue.companyId, issue.id, req.actor.userId, new Date());
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_archived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId, archivedAt: archiveState.archivedAt },
    });
    res.json(archiveState);
  });

  router.delete("/issues/:id/inbox-archive", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const removed = await svc.unarchiveInbox(issue.companyId, issue.id, req.actor.userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.inbox_unarchived",
      entityType: "issue",
      entityId: issue.id,
      details: { userId: req.actor.userId },
    });
    res.json(removed ?? { ok: true });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    const actor = getActorInfo(req);
    await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId: req.body.approvalId },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.companyId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/issues", validate(createIssueSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertHostWorkspaceCommandAuthority(db, req, companyId, collectIssueWorkspaceCommandPaths(req.body));
    assertIssueOverrideHostExecutionAllowed(req, undefined);
    // AGE-113: assignee adapter overrides change which adapter/model runs an
    // assigned issue. That is agent configuration, and only a human may set it.
    if (req.actor.type === "agent" && req.body.assigneeAdapterOverrides !== undefined) {
      res.status(403).json({
        error: "Agent-authenticated callers cannot set assigneeAdapterOverrides; only a human with agent-configuration authority may change adapter or model configuration",
      });
      return;
    }
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, companyId);
    }
    await assertIssueEnvironmentSelection(companyId, req.body.executionWorkspaceSettings?.environmentId);

    const actor = getActorInfo(req);
    // AgentDash (GH #745 review): `requestId` is the assistant-grant dedup
    // key, recorded as (originKind='assistant_work', originId=requestId)
    // under issues_assistant_work_request_uq. Only assistant-grant writes
    // may send it — every other caller gets 400 so the dedup domain can't
    // be squatted. When an assistant write omits it we derive a stable
    // windowed key so a transport retry still cannot double-create.
    const isAssistantGrant = req.actor.source === "assistant_grant";
    const rawRequestId: unknown = req.body.requestId;
    if (rawRequestId !== undefined && !isAssistantGrant) {
      res.status(400).json({ error: "requestId is only accepted on assistant-grant writes" });
      return;
    }
    // AgentDash: an assistant-grant write is always recorded under its own
    // assistant_work origin, so an ExecOS origin on the same write would be
    // silently overwritten. The loopback middleware's body allowlist (GH #745)
    // already refuses these fields with 403 before the route runs; this is
    // defence in depth for any assistant_grant actor that reaches the route.
    if (isAssistantGrant && (req.body.originKind !== undefined || req.body.originId != null)) {
      res.status(400).json({ error: "originKind/originId are not accepted on assistant-grant writes" });
      return;
    }
    const requestId =
      typeof rawRequestId === "string" && rawRequestId.trim().length > 0 ? rawRequestId.trim() : null;
    const originId = isAssistantGrant
      ? requestId ??
        deriveAssistantIssueRequestId({
          grantId: req.actor.assistantGrantId ?? "unknown",
          title: typeof req.body.title === "string" ? req.body.title : "",
          parentId: typeof req.body.parentId === "string" ? req.body.parentId : null,
          projectId: typeof req.body.projectId === "string" ? req.body.projectId : null,
          assigneeAgentId: typeof req.body.assigneeAgentId === "string" ? req.body.assigneeAgentId : null,
          description: typeof req.body.description === "string" ? req.body.description : null,
        })
      : null;
    if (originId) {
      const existing = await svc.getByOrigin(companyId, ASSISTANT_WORK_ORIGIN_KIND, originId);
      if (existing) {
        res.status(200).json({ ...existing, replayed: true });
        return;
      }
    }

    const executionPolicy = normalizeIssueExecutionPolicy(req.body.executionPolicy);
    const { requestId: _requestId, ...issueInput } = req.body;
    const routeUnownedTodoToChiefOfStaff = await callerMayRouteToChiefOfStaff(req, companyId, issueInput);
    let issue;
    try {
      issue = await svc.create(companyId, {
        ...issueInput,
        routeUnownedTodoToChiefOfStaff,
        executionPolicy,
        ...(originId ? { originKind: ASSISTANT_WORK_ORIGIN_KIND, originId } : {}),
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
    } catch (err) {
      // Concurrent assistant retry won the unique index: return the row it
      // created rather than surfacing a 500 to the caller.
      if (originId && isUniqueViolation(err) && pgConstraintName(err) === "issues_assistant_work_request_uq") {
        const existing = await svc.getByOrigin(companyId, ASSISTANT_WORK_ORIGIN_KIND, originId);
        if (existing) {
          res.status(200).json({ ...existing, replayed: true });
          return;
        }
      }
      // AgentDash: ExecOS request identity. The caller owns the retry, so a
      // duplicate (companyId, execos_request, originId) is an explicit 409,
      // translated only from its named constraint.
      if (
        issueInput.originKind === "execos_request" &&
        isUniqueViolation(err) &&
        pgConstraintName(err) === "issues_execos_request_origin_uq"
      ) {
        throw conflict("ExecOS request is already recorded", {
          code: "EXECOS_REQUEST_ALREADY_RECORDED",
          originId: issueInput.originId,
        });
      }
      throw err;
    }
    await issueReferencesSvc.syncIssue(issue.id);
    const referenceSummary = await issueReferencesSvc.listIssueReferenceSummary(issue.id);
    const referenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      issueReferencesSvc.emptySummary(),
      referenceSummary,
    );

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        title: issue.title,
        identifier: issue.identifier,
        // AgentDash (GH #678): provenance when the write came via an assistant grant.
        ...assistantGrantAttribution(req),
        ...(wasRoutedToChiefOfStaff(issueInput, issue) ? { routedToChiefOfStaff: issue.assigneeAgentId } : {}),
        ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: referenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: referenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: referenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json({
      ...issue,
      relatedWork: referenceSummary,
      referencedIssueIdentifiers: referenceSummary.outbound.map((item) => item.issue.identifier ?? item.issue.id),
    });
  });

  router.post("/issues/:id/children", validate(createChildIssueSchema), async (req, res) => {
    const parentId = req.params.id as string;
    const parent = await svc.getById(parentId);
    if (!parent) {
      res.status(404).json({ error: "Parent issue not found" });
      return;
    }
    assertCompanyAccess(req, parent.companyId);
    await assertHostWorkspaceCommandAuthority(db, req, parent.companyId, collectIssueWorkspaceCommandPaths(req.body));
    assertIssueOverrideHostExecutionAllowed(req, undefined);
    // AGE-113: same gate as issue create — overrides are agent configuration.
    if (req.actor.type === "agent" && req.body.assigneeAdapterOverrides !== undefined) {
      res.status(403).json({
        error: "Agent-authenticated callers cannot set assigneeAdapterOverrides; only a human with agent-configuration authority may change adapter or model configuration",
      });
      return;
    }
    if (req.body.assigneeAgentId || req.body.assigneeUserId) {
      await assertCanAssignTasks(req, parent.companyId);
    }
    await assertIssueEnvironmentSelection(parent.companyId, req.body.executionWorkspaceSettings?.environmentId);

    // AgentDash (GH #745 review): createChildIssueSchema inherits the
    // assistant `requestId` field, but this route is not reachable by an
    // assistant credential — refuse it instead of letting a meaningless
    // dedup key flow into the insert payload.
    if (req.body.requestId !== undefined) {
      res.status(400).json({ error: "requestId is only accepted on assistant-grant writes" });
      return;
    }

    const actor = getActorInfo(req);
    const executionPolicy = normalizeIssueExecutionPolicy(req.body.executionPolicy);
    const routeUnownedTodoToChiefOfStaff = await callerMayRouteToChiefOfStaff(req, parent.companyId, req.body);
    const { issue, parentBlockerAdded } = await svc.createChild(parent.id, {
      ...req.body,
      routeUnownedTodoToChiefOfStaff,
      executionPolicy,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      actorAgentId: actor.agentId,
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.child_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        parentId: parent.id,
        identifier: issue.identifier,
        title: issue.title,
        inheritedExecutionWorkspaceFromIssueId: parent.id,
        ...(wasRoutedToChiefOfStaff(req.body, issue) ? { routedToChiefOfStaff: issue.assigneeAgentId } : {}),
        ...(Array.isArray(req.body.blockedByIssueIds) ? { blockedByIssueIds: req.body.blockedByIssueIds } : {}),
        ...(parentBlockerAdded ? { parentBlockerAdded: true } : {}),
      },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.child_create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    res.status(201).json(issue);
  });

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) throw notFound("Issue not found");
    assertCompanyAccess(req, existing.companyId);
    const actions = issuePatchActions(db, heartbeat, {
      statusChanged: (id, before, after) => cosVerdictOrchestratorSvc.onIssueStatusChanged(id, before, after),
      completed: async agentId => {
        const tc = getTelemetryClient();
        if (!tc) return;
        const agent = await agentsSvc.getById(agentId);
        if (agent) trackAgentTaskCompleted(tc, { agentRole: agent.role, agentId: agent.id, adapterType: agent.adapterType,
          model: typeof agent.adapterConfig?.model === "string" ? agent.adapterConfig.model : undefined });
      },
    });
    try {
      const context: IssuePatchContext = { issueId: existing.id, companyId: existing.companyId,
        actor: getActorInfo(req), actorKind: req.actor.type, attribution: assistantGrantAttribution(req), intent: req.body,
        stageAuthority: issueCurrentAuthority(req, req.body.projectId),
        validate: async (executor, current, intent) => {
          const policyDb = executor as Db;
          await assertHostWorkspaceCommandAuthority(policyDb, req, current.companyId, collectIssueWorkspaceCommandPaths(intent, {
            executionWorkspaceSettings: current.executionWorkspaceSettings, assigneeAdapterOverrides: current.assigneeAdapterOverrides }));
          assertIssueOverrideHostExecutionAllowed(req, current.assigneeAdapterOverrides);
          if (req.actor.type === "agent" && intent.assigneeAdapterOverrides !== undefined) throw new IssueCommentPolicyRefusal(403, {
            error: "Agent-authenticated callers cannot change assigneeAdapterOverrides; only a human with agent-configuration authority may change adapter or model configuration" });
          await assertAgentIssueMutationAllowed(req, res, current, policyDb);
          if (intent.executionWorkspaceSettings?.environmentId) await assertEnvironmentSelectionForCompany(environmentService(policyDb),
            current.companyId, intent.executionWorkspaceSettings.environmentId, { allowedDrivers: ["local", "ssh", "sandbox"] });
          const { comment, reviewRequest, reopen: _reopen, resume: _resume, interrupt: _interrupt, hiddenAt: _hiddenAt, ...fields } = intent;
          const agentWork = req.actor.type === "agent" && (Object.keys(fields).length > 0 || reviewRequest !== undefined);
          const workspace = current.executionWorkspaceId ? await executionWorkspaceServiceDirect(policyDb).getById(current.executionWorkspaceId) : null;
          if (workspace && isClosedIsolatedExecutionWorkspace(workspace) && (comment || agentWork)) throw new IssueCommentPolicyRefusal(409, {
            error: getClosedIsolatedExecutionWorkspaceMessage(workspace), executionWorkspace: workspace });
        },
        validateResume: async (executor, current) => { await assertExplicitResumeIntentAllowed(req, res, current, executor as Db); },
        validateAssignment: (executor, current) => assertCanAssignTasks(req, current.companyId, executor as Db),
      };
      const accepted = await actions.accept(context);
      const effects = await actions.dispatch(accepted);
      if (effects.unresolved) {
        logger.warn({ issueId: existing.id, mutationId: accepted.mutationId, effects: effects.outcomes }, "issue update accepted with unresolved effects");
        res.status(500).json({ error: "Issue update accepted, but follow-up effects are unresolved. Read the issue before retrying." });
        return;
      }
      res.json({ ...accepted.issueResponse, comment: accepted.comment });
    } catch (error) {
      if (error instanceof IssueCommentPolicyRefusal) {
        if (error.body.error === "Agent cannot mutate another agent's issue") reportAuthzRefusal(req, {
          companyId: existing.companyId, entityType: "issue", entityId: existing.id, reasonCode: "ISSUE_MUTATION_OTHER_AGENT" });
        res.status(error.status).json(error.body);
        return;
      }
      throw error;
    }
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.post("/issues/:id/admin/force-release", async (req, res) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board access required" });
      return;
    }
    if (!req.actor.userId) {
      throw forbidden("Board user context required");
    }

    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const clearAssignee = req.query.clearAssignee === "true";
    const result = await svc.adminForceRelease(id, { clearAssignee });
    if (!result) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.admin_force_release",
      entityType: "issue",
      entityId: result.issue.id,
      details: {
        issueId: result.issue.id,
        actorUserId: req.actor.userId,
        prevCheckoutRunId: result.previous.checkoutRunId,
        prevExecutionRunId: result.previous.executionRunId,
        clearAssignee,
      },
    });

    res.json(result);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  async function protectedQuestions<T>(req: Request, authority: ReturnType<typeof foundationAuthority>, companyId: string, operationId: string, input: Record<string, unknown>,
    work: (executor: Db, acceptance: ActivityAcceptance, guards: QuestionWriteGuards, visible: (id: string, issueId: string) => Promise<unknown>) => Promise<T>, mutation = false) {
    const publications: ActivityPublication[] = [];
    let callbackCompleted = false;
    let value: T;
    try {
      value = await db.transaction(async tx => {
        const executor = tx as unknown as Db;
        const guard = await authority.stage(executor, { companyId, operationId, input, native: true });
        assertBoard(req); assertCompanyAccess(req, companyId);
        await guard.seal();
        const value = await work(executor, { executor, publications }, { assertSource: guard.assertSource, beforeWrite: guard.checkTime }, guard.visibleQuestion);
        if (!mutation) await guard.seal();
        guard.checkTime(); callbackCompleted = true;
        return value;
      });
    } catch (error) {
      if (mutation && callbackCompleted) throw conflict('Question persistence is uncertain; inspect current state before retrying', { persistenceOutcome: 'unknown' });
      throw error;
    }
    for (const publication of publications) publishActivity(publication);
    return value;
  }
  async function currentQuestion(req: Request, authority: ReturnType<typeof foundationAuthority>, issue: { id: string; companyId: string }, interactionId: string) {
    return protectedQuestions(req, authority, issue.companyId, 'human_questions.read', { issueId: issue.id, interactionId }, executor => issueThreadInteractionService(executor).getById(interactionId));
  }
  router.get("/issues/:id/interactions", async (req, res) => {
    const authority = req.actor.type === 'board' ? foundationAuthority(req) : null;
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const interactions = authority ? await protectedQuestions(req, authority, issue.companyId, 'native.question.list', { issueId: id }, async (executor, _acceptance, _guards, visible) => {
      const rows = await issueThreadInteractionService(executor).listForIssue(id), allowed = [];
      for (const value of rows) {
        if (value.kind !== 'ask_user_questions') { allowed.push(value); continue; }
        try { await visible(value.id, id); allowed.push(value); }
        catch (error) { if ((error as {status?: number}).status !== 404) throw error; }
      }
      return allowed;
    }) : await issueThreadInteractionService(db).listForIssue(id);
    res.json(interactions);
  });

  router.post("/issues/:id/interactions", validate(createIssueThreadInteractionSchema), async (req, res) => {
    const authority = req.actor.type === 'board' && req.body.kind === 'ask_user_questions' ? foundationAuthority(req) : null;
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type === "agent") {
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    } else {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const agentSourceRunId = req.actor.type === "agent" ? requireAgentRunId(req, res) : null;
    if (req.actor.type === "agent" && !agentSourceRunId) return;

    if (authority) {
      const input = { ...req.body, sourceRunId: req.body.sourceRunId ?? null };
      const interaction = await protectedQuestions(req, authority, issue.companyId, 'native.question.create', { issueId: id, body: input }, async (executor, acceptance, guards) => {
        const value = await issueThreadInteractionService(executor).create(issue, input, { userId: actor.actorId }, acceptance, guards);
        acceptance.publications.push(await insertActivity(executor, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
          action: 'issue.thread_interaction_created', entityType: 'issue', entityId: issue.id,
          details: { interactionId: value.id, interactionKind: value.kind, interactionStatus: value.status, continuationPolicy: value.continuationPolicy } }, guards.beforeWrite));
        return value;
      }, true);
      res.status(201).json(await currentQuestion(req, authority, issue, interaction.id));
      return;
    }
    const interaction = await issueThreadInteractionService(db).create(issue, {
      ...req.body,
      sourceRunId: req.actor.type === "agent" ? agentSourceRunId : req.body.sourceRunId ?? null,
    }, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
      },
    });

    res.status(201).json(interaction);
  });

  router.post(
    "/issues/:id/interactions/:interactionId/accept",
    validate(acceptIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const { interaction, createdIssues, continuationIssue } = await issueThreadInteractionService(db).acceptInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      const continuationWakeIssue = continuationIssue ?? issue;

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          createdTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.createdTasks?.length ?? 0)
              : 0,
          skippedTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.skippedClientKeys?.length ?? 0)
              : 0,
        },
      });

      if (continuationIssue) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            status: continuationIssue.status,
            assigneeAgentId: continuationIssue.assigneeAgentId ?? null,
            assigneeUserId: continuationIssue.assigneeUserId ?? null,
            source: "request_confirmation_accept",
            interactionId: interaction.id,
            _previous: {
              status: issue.status,
              assigneeAgentId: issue.assigneeAgentId ?? null,
              assigneeUserId: issue.assigneeUserId ?? null,
            },
          },
        });
      }

      for (const createdIssue of createdIssues) {
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "interaction_accept",
          contextSource: "issue.interaction.accept",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
        });
      }

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue: continuationWakeIssue,
        interaction,
        actor,
        source: "issue.interaction.accept",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/reject",
    validate(rejectIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).rejectInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_rejected",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          rejectionReason:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.rejectionReason ?? null)
              : interaction.kind === "request_confirmation"
                ? (interaction.result?.reason ?? null)
              : null,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.reject",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/respond",
    validate(respondIssueThreadInteractionSchema),
    async (req, res) => {
      const authority = foundationAuthority(req);
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await protectedQuestions(req, authority, issue.companyId, 'human_questions.respond', { issueId: id, interactionId, shareWithCompany: req.body.shareWithCompany === true }, async (executor, acceptance, guards) => {
        const value = await issueThreadInteractionService(executor).answerQuestions(issue, interactionId, req.body, { agentId: actor.agentId, userId: actor.actorType === 'user' ? actor.actorId : null }, acceptance, guards);
        acceptance.publications.push(await insertActivity(executor, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
          action: 'issue.thread_interaction_answered', entityType: 'issue', entityId: issue.id,
          details: { interactionId: value.id, interactionKind: value.kind, interactionStatus: value.status, answeredQuestionCount: value.kind === 'ask_user_questions' ? value.result?.answers?.length ?? 0 : 0 } }, guards.beforeWrite));
        return value;
      }, true);

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.respond",
      });

      res.json(await currentQuestion(req, authority, issue, interaction.id));
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/cancel",
    validate(cancelIssueThreadInteractionSchema),
    async (req, res) => {
      const authority = foundationAuthority(req);
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await svc.getById(id);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      assertCompanyAccess(req, issue.companyId);
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await protectedQuestions(req, authority, issue.companyId, 'human_questions.cancel', { issueId: id, interactionId }, async (executor, acceptance, guards) => {
        const value = await issueThreadInteractionService(executor).cancelQuestions(issue, interactionId, req.body, { agentId: actor.agentId, userId: actor.actorType === 'user' ? actor.actorId : null }, acceptance, guards);
        acceptance.publications.push(await insertActivity(executor, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
          action: 'issue.thread_interaction_cancelled', entityType: 'issue', entityId: issue.id,
          details: { interactionId: value.id, interactionKind: value.kind, interactionStatus: value.status, cancellationReason: value.kind === 'ask_user_questions' ? value.result?.cancellationReason ?? null : null } }, guards.beforeWrite));
        return value;
      }, true);

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.cancel",
      });

      res.json(await currentQuestion(req, authority, issue, interaction.id));
    },
  );

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.delete("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    const actor = getActorInfo(req);
    const actorOwnsComment =
      actor.actorType === "agent"
        ? comment.authorAgentId === actor.agentId
        : comment.authorUserId === actor.actorId;
    if (!actorOwnsComment) {
      res.status(403).json({ error: "Only the comment author can cancel queued comments" });
      return;
    }

    const activeRun = await resolveActiveIssueRun(issue);
    if (!activeRun) {
      res.status(409).json({ error: "Queued comment can no longer be canceled" });
      return;
    }

    if (!isQueuedIssueCommentForActiveRun({ comment, activeRun })) {
      res.status(409).json({ error: "Only queued comments can be canceled" });
      return;
    }

    const removed = await svc.removeComment(commentId);
    if (!removed) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_cancelled",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: removed.id,
        bodySnippet: removed.body.slice(0, 120),
        identifier: issue.identifier,
        issueTitle: issue.title,
        source: "queue_cancel",
        queueTargetRunId: activeRun.id,
      },
    });

    res.json(removed);
  });

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const issue = await svc.getById(req.params.id as string);
    if (!issue) throw notFound("Issue not found");
    assertCompanyAccess(req, issue.companyId);
    const actions = issueCommentActions(db, heartbeat);
    try {
      const accepted = await actions.accept({
        issueId: issue.id,
        companyId: issue.companyId,
        actor: getActorInfo(req),
        actorKind: req.actor.type,
        attribution: assistantGrantAttribution(req),
        intent: req.body,
        stageAuthority: issueCurrentAuthority(req),
        validate: async (executor, current) => {
          // Company access was checked on this authenticated request above;
          // acceptance refreshes existence and enforces that same source binding.
          const policyDb = executor as Db;
          await assertAgentIssueMutationAllowed(req, res, current, policyDb);
          const workspace = current.executionWorkspaceId
            ? await executionWorkspaceService(policyDb).getById(current.executionWorkspaceId)
            : null;
          if (workspace && isClosedIsolatedExecutionWorkspace(workspace)) {
            throw new IssueCommentPolicyRefusal(409, {
              error: getClosedIsolatedExecutionWorkspaceMessage(workspace), executionWorkspace: workspace,
            });
          }
          if (req.body.resume === true || (req.body.reopen === true && req.actor.type === "agent")) {
            await assertExplicitResumeIntentAllowed(req, res, current, policyDb);
          }
        },
      });
      const effects = await actions.dispatch(accepted);
      if (effects.unresolved) {
        // Deliberately bypass generic exception/request-body logging. Private
        // accepted IDs/outcomes remain on the server-side result for later transports.
        logger.warn({ issueId: issue.id, mutationId: accepted.mutationId, effects: effects.outcomes },
          "issue comment accepted with unresolved effects");
        res.status(500).json({ error: "Comment accepted, but follow-up effects are unresolved. Read the issue before retrying." });
        return;
      }
      res.status(201).json(accepted.comment);
    } catch (err) {
      if (err instanceof IssueCommentPolicyRefusal) {
        if (err.body.error === "Agent cannot mutate another agent's issue") {
          reportAuthzRefusal(req, { companyId: issue.companyId, entityType: "issue",
            entityId: issue.id, reasonCode: "ISSUE_MUTATION_OTHER_AGENT" });
        }
        res.status(err.status).json(err.body);
        return;
      }
      throw err;
    }
  });

  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await feedback.saveIssueVote({
      issueId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId ?? "local-board",
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    const company = await companiesSvc.getById(companyId);
    const attachmentMaxBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);

    try {
      await runSingleFileUpload(req, res, attachmentMaxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${attachmentMaxBytes} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = normalizeContentType(file.mimetype);
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  /**
   * Attach a file the calling agent wrote in its own workspace.
   *
   * An agent produces a file on the machine running the server and then has to tell
   * a human about it. Naming the path is useless — it is true only on that machine,
   * and the person reading the response is on a laptop. This turns the file into an
   * attachment with a URL, which is the same shape of fix as #539: stop handing out
   * an identifier that is only valid where it was made.
   *
   * Deliberately a separate route from the multipart upload rather than a mode on
   * it. The upload path takes bytes from an HTTP client; this one takes a filename
   * from an authenticated agent and reads the disk on its behalf. Those have
   * different threat models and belong apart.
   *
   * Agent-only. A signed-in human already has the file locally and uses the upload.
   */
  router.post(
    "/companies/:companyId/issues/:issueId/attachments/from-workspace",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const issueId = req.params.issueId as string;
      assertCompanyAccess(req, companyId);

      const actor = getActorInfo(req);
      if (actor.actorType !== "agent" || !actor.agentId) {
        // Not 403-for-flavour: the workspace root is derived from the agent id, so
        // without one there is no root to resolve against and nothing to serve.
        res.status(403).json({
          error: "Only an agent can attach from a workspace; use the upload endpoint instead.",
        });
        return;
      }

      const issue = await svc.getById(issueId);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      if (issue.companyId !== companyId) {
        res.status(422).json({ error: "Issue does not belong to company" });
        return;
      }
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

      const parsed = z
        .object({
          path: z.string().min(1).max(1024),
          filename: z.string().min(1).max(255).optional(),
          issueCommentId: z.string().uuid().optional(),
        })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
        return;
      }

      let resolved;
      try {
        resolved = await resolveAgentWorkspaceFile(actor.agentId, parsed.data.path);
      } catch (err) {
        if (err instanceof WorkspaceFileError) {
          // 404 for a missing file, 400 for a path we refuse to honour. Both are the
          // agent's mistake to fix, and neither reveals anything about the filesystem
          // beyond what the agent already supplied.
          res.status(err.code === "not_found" ? 404 : 400).json({ error: err.message });
          return;
        }
        throw err;
      }

      const company = await companiesSvc.getById(companyId);
      const maxBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);
      if (resolved.byteSize <= 0) {
        res.status(422).json({ error: "File is empty" });
        return;
      }
      if (resolved.byteSize > maxBytes) {
        res.status(422).json({ error: `File exceeds ${maxBytes} bytes` });
        return;
      }

      // Read after the size check so an oversized file is never pulled into memory.
      const body = await fs.readFile(resolved.absolutePath);

      // Name the stored file after what the agent called it, but take the content
      // type from the extension we resolved — never from the caller, which would let
      // an agent choose how a browser interprets its bytes.
      const originalFilename = parsed.data.filename ?? resolved.filename;
      const contentType = contentTypeForWorkspaceFile(originalFilename);

      const stored = await storage.putFile({
        companyId,
        namespace: `issues/${issueId}`,
        originalFilename,
        contentType,
        body,
      });

      const attachment = await svc.createAttachment({
        issueId,
        issueCommentId: parsed.data.issueCommentId ?? null,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.attachment_added",
        entityType: "issue",
        entityId: issueId,
        details: {
          attachmentId: attachment.id,
          originalFilename: attachment.originalFilename,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          // The path is recorded because "which file did it attach" is the first
          // question an operator asks, and the agent's own wording is the answer.
          workspacePath: resolved.relativePath,
          source: "agent_workspace",
        },
      });

      const withPath = withContentPath(attachment);
      res.status(201).json({
        ...withPath,
        // Absolute where the instance advertises an address, so the agent can put a
        // working link in its response instead of composing one from whatever
        // endpoint it happened to dial.
        url: absoluteUrl(withPath.contentPath) ?? null,
      });
    },
  );

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    const responseContentType = normalizeContentType(attachment.contentType || object.contentType);
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.companyId);
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  // AgentDash: goals-eval-hitl
  router.put(
    "/companies/:companyId/issues/:issueId/dod",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const issueId = req.params.issueId as string;
        // The DoD is what this agent's own work is judged against. Same argument
          // as the goal one level up: an agent that can move the bar can clear it.
          assertCanSetCompanyDirection(req, companyId);
        const parsed = definitionOfDoneSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid definition of done",
            code: "DOD_INVALID",
            issues: parsed.error.issues,
          });
          return;
        }
        const updated = await verdictsSvc.setIssueDoD(
          companyId,
          issueId,
          parsed.data,
          getActorInfo(req),
        );
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
