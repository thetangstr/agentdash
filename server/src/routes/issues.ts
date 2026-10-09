import { redactApprovalForReader } from "../redaction.js";
import { issueCurrentAuthority } from "../services/issue-current-authority.js";
import { registerRossRequestRoutes } from "./ross-requests.js";
import { issuePatchActions, updateIssueRouteSchema, type IssuePatchContext } from "../services/issue-patch-actions.js";
import {
  issueCommentActions,
  IssueCommentPolicyRefusal,
  summarizeIssueRelationForActivity,
  summarizeIssueReferenceActivityDetails,
} from "../services/issue-mutation-actions.js";
import { dispatchResolvedInteractionContinuation } from "../services/issue-interaction-continuation.js";
import { assertHostExecutionConfigAllowed } from "../services/adapter-host-execution-policy.js";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issueExecutionDecisions, issues, issueWorkProducts } from "@paperclipai/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assertFeedbackTraceVisible,
  assertIssueIdVisible,
  assertIssueIdsVisibleInCompany,
  assertProjectIdVisible,
  assertWorkspaceIdsVisible,
  feedbackTraceVisibilityCondition,
  filterVisibleBlockedByOnRows,
  filterVisibleIssueRelations,
  filterVisibleReferenceSummary,
  isCanonicalUuid,
  isProjectIdVisible,
  issueVisibilityCondition,
  listVisibleIssueIds,
  projectScopedVisibilityCondition,
  redactHiddenIssueRefsOnRows,
  resolveAgentVisibility,
  truncateAncestorsAtInvisible,
  visibleAgentIdsFor,
  canReadCompanySpend,
} from "./visibility.js";
import { decodeShippedCursor, sanitizeWorkProductTitle, workProductDocumentKey } from "../services/work-products.js";
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
  requestIssueChangesSchema,
  upsertIssueDocumentSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  type ExecutionWorkspace,
  ASSISTANT_WORK_ORIGIN_KIND,
  preserveIssueRecoveryBudget,
} from "@paperclipai/shared";
// AgentDash: goals-eval-hitl
import { definitionOfDoneSchema, isUuidLike } from "@paperclipai/shared";
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
import { actorHumanRole, assertCanSetCompanyDirection, assertBoard, assertCompanyAccess, assistantGrantAttribution, getActorInfo, reportAuthzRefusal } from "./authz.js";
// AgentDash (GH #505): member emails reach only callers allowed to read them.
import { canViewMemberEmails, visibleMemberEmail } from "./member-email-visibility.js";
import { clearWorkspacePersistenceHold } from "../services/workspace-persistence-recovery.js";
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
import { resolveStewardedAgentRoute, type StewardedAgentRoute } from "../services/stewarded-agent-routing.js";
import {
  clearIssueRecoveryBudget,
  EXHAUSTED_RECOVERY_CHECKOUT_REFUSAL,
  exhaustedRecoveryBudgetAllowsRun,
  hasExhaustedRecoveryBudget,
  recoveryBudgetNotice,
} from "../services/issue-recovery-budget.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { executionWorkspaceService as executionWorkspaceServiceDirect } from "../services/execution-workspaces.js";
import { feedbackService } from "../services/feedback.js";
import { documentRunAccess } from "./document-run-access.js";
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

/**
 * AgentDash (recovery budget remediation): only a person may clear an exhausted
 * automatic-recovery budget. Agent keys never qualify, and neither do
 * assistant grants: the clear lifts a spend guard, so it takes a human at the
 * board, not an assistant acting with their token.
 */
function isHumanBoardActor(req: Request) {
  return req.actor.type === "board" && req.actor.source !== "assistant_grant";
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
import type { ActivityAcceptance } from '../services/activity-log.js';

/**
 * AgentDash (Scan 3 lane I): why a work-product write is refused as
 * self-acceptance, or null. An agent, or a client acting for a person through
 * an assistant grant (not an acceptance on done either), cannot record a work
 * product as approved or merged: nothing verifies a merge with GitHub today,
 * and the caller picks the type. An agent cannot change a work product's type.
 *
 * AgentDash (batch 2 review lane, review #1003): an agent cannot send a work
 * product back to review either. Only the in_review move and the
 * document-write hook may flip changes_requested to ready_for_review —
 * otherwise a direct PATCH would bring Accept back for a revision the
 * reviewer never saw.
 */
// AgentDash (review #1003, round 2): a deliverable that has been through
// review — sent back (changes_requested), accepted (approved/merged), or
// carrying the server's review stamps — may not have its status or
// reviewState touched by an agent at all. Otherwise a two-step PATCH
// (changes_requested → active → ready_for_review) walks around the
// back-to-review refusal and revives Accept without a new revision.
const REVIEWED_WORK_PRODUCT_STATUSES = new Set(["changes_requested", "approved", "merged"]);
const REVIEWED_METADATA_KEYS = ["changesRequestedAt", "acceptance"] as const;

function workProductWasReviewed(existingStatus?: string, existingMetadata?: unknown): boolean {
  if (existingStatus !== undefined && REVIEWED_WORK_PRODUCT_STATUSES.has(existingStatus)) return true;
  if (!existingMetadata || typeof existingMetadata !== "object" || Array.isArray(existingMetadata)) return false;
  return REVIEWED_METADATA_KEYS.some((key) => key in (existingMetadata as Record<string, unknown>));
}

export function workProductSelfAcceptanceRefusal(
  actor: { type?: string | null; source?: string | null },
  body: { status?: unknown; reviewState?: unknown; type?: unknown },
  existingType?: string,
  existingStatus?: string,
  existingMetadata?: unknown,
): string | null {
  const notAPerson = actor.type === "agent" || actor.source === "assistant_grant";
  if (!notAPerson) return null;
  if (actor.type === "agent" && existingType !== undefined && body.type !== undefined && body.type !== existingType) {
    return "Agents cannot change a work product's type.";
  }
  const status = typeof body.status === "string" ? body.status : null;
  if (status === "approved" || status === "merged" || body.reviewState === "approved") {
    return "Only a person can accept work. A board user accepts it from the issue.";
  }
  if (
    (body.status !== undefined || body.reviewState !== undefined)
    && workProductWasReviewed(existingStatus, existingMetadata)
  ) {
    return "Only the server changes a reviewed deliverable's status: write the revised document revision, then move the issue to in_review.";
  }
  return null;
}

/**
 * AgentDash (batch 2 review lane): a new revision written to the document of
 * a deliverable sends that deliverable back to review. An accepted
 * deliverable whose document changed after the accepted revision returns to
 * ready_for_review — and reopens a done issue to in_review so the review
 * actually surfaces again; a sent-back deliverable on an issue already in
 * review becomes reviewable once the revision it was asked for lands.
 *
 * AgentDash (review #1003): a board user's own write or restore does not
 * reopen what they accepted — the new revision is recorded as the accepted
 * one instead. The issue status is re-read under the row lock so a
 * concurrent PATCH cannot move the issue between the route's stale read and
 * this hook, and the reopen goes through the issue service rather than a raw
 * update.
 */
async function applyDeliverableReviewAfterDocumentRevision(input: {
  db: Db;
  issue: { id: string; companyId: string; identifier?: string | null };
  key: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  actor: { actorType: "agent" | "plugin" | "system" | "user"; actorId: string; agentId: string | null; runId: string | null; source?: string | null };
  onIssueStatusChanged: (issueId: string, before: string, after: string) => Promise<unknown>;
}) {
  const { db, issue, key, latestRevisionId, latestRevisionNumber, actor, onIssueStatusChanged } = input;
  const publications: ActivityPublication[] = [];
  let reopenedDoneIssue = false;
  await db.transaction(async (tx) => {
    const freshIssue = await tx
      .select({ status: issues.status, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!freshIssue) return;
    const identifier = freshIssue.identifier ?? issue.identifier ?? null;
    const candidates = await tx
      .select({ id: issueWorkProducts.id, status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, issue.companyId),
        eq(issueWorkProducts.issueId, issue.id),
        inArray(issueWorkProducts.status, ["approved", "changes_requested"]),
        sql`${issueWorkProducts.metadata} ->> 'documentKey' = ${key}`,
      ));
    if (candidates.length === 0) return;
    const now = new Date();
    let reopenedAccepted = false;
    for (const product of candidates) {
      const meta = (product.metadata ?? null) as Record<string, unknown> | null;
      if (product.status === "approved") {
        const acceptance = meta?.acceptance as Record<string, unknown> | undefined;
        const acceptedRevision =
          typeof acceptance?.acceptedRevisionNumber === "number" ? acceptance.acceptedRevisionNumber : null;
        // The revision the person accepted already covers this write.
        if (acceptedRevision !== null && acceptedRevision >= latestRevisionNumber) continue;
        // A board user's own edit or restore accepts what they just wrote —
        // reopening their own change would churn the review queue. Writes by
        // an agent, plugin or assistant grant are not the reviewer.
        const boardUserWrite = actor.actorType === "user" && actor.source !== "assistant_grant";
        if (boardUserWrite) {
          await tx.update(issueWorkProducts)
            .set({
              metadata: sql`${issueWorkProducts.metadata} || jsonb_build_object('acceptance',
                coalesce(${issueWorkProducts.metadata} -> 'acceptance', '{}'::jsonb) || jsonb_build_object(
                  'acceptedRevisionId', ${latestRevisionId}::text,
                  'acceptedRevisionNumber', ${latestRevisionNumber}::int,
                  'acceptedAt', ${now.toISOString()}::text,
                  'acceptedByUserId', ${actor.actorId}::text))`,
              updatedAt: now,
            })
            .where(eq(issueWorkProducts.id, product.id));
          publications.push(await insertActivity(tx, {
            companyId: issue.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.work_product_updated",
            entityType: "issue",
            entityId: issue.id,
            details: {
              identifier,
              workProductId: product.id,
              changedKeys: ["metadata"],
              reason: "accepted_revision_updated",
              key,
              revisionNumber: latestRevisionNumber,
            },
          }));
          continue;
        }
        await tx.update(issueWorkProducts)
          .set({
            status: "ready_for_review",
            reviewState: "needs_board_review",
            metadata: sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || jsonb_build_object(
              'reviewReopenedAt', ${now.toISOString()}::text,
              'reviewReopenReason', 'document_revised_after_acceptance')`,
            updatedAt: now,
          })
          .where(eq(issueWorkProducts.id, product.id));
        reopenedAccepted = true;
        publications.push(await insertActivity(tx, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.work_product_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier,
            workProductId: product.id,
            changedKeys: ["metadata", "reviewState", "status"],
            status: "ready_for_review",
            reviewState: "needs_board_review",
            reason: "document_revised_after_acceptance",
            key,
            revisionNumber: latestRevisionNumber,
          },
        }));
      } else if (product.status === "changes_requested") {
        // A sent-back deliverable is resubmitted by the new revision only
        // while the issue sits in review — and only when this revision is
        // newer than the one the changes request was made against.
        if (freshIssue.status !== "in_review") continue;
        const requestedRevision =
          typeof meta?.changesRequestedAtRevision === "number" ? meta.changesRequestedAtRevision : null;
        if (requestedRevision !== null && latestRevisionNumber <= requestedRevision) continue;
        await tx.update(issueWorkProducts)
          .set({
            status: "ready_for_review",
            reviewState: "needs_board_review",
            metadata: sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || jsonb_build_object('resubmittedAt', ${now.toISOString()}::text)`,
            updatedAt: now,
          })
          .where(eq(issueWorkProducts.id, product.id));
        publications.push(await insertActivity(tx, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.work_product_updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier,
            workProductId: product.id,
            changedKeys: ["metadata", "reviewState", "status"],
            status: "ready_for_review",
            reviewState: "needs_board_review",
            reason: "resubmitted_for_review",
            key,
            revisionNumber: latestRevisionNumber,
          },
        }));
      }
    }
    if (reopenedAccepted && freshIssue.status === "done") {
      reopenedDoneIssue = true;
      await issueService(tx as unknown as Db).update(issue.id, { status: "in_review" }, tx as unknown as Db);
      publications.push(await insertActivity(tx, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          identifier,
          status: "in_review",
          _previous: { status: "done" },
          reason: "document_revised_after_acceptance",
          key,
        },
      }));
    }
  });
  for (const publication of publications) publishActivity(publication);
  if (reopenedDoneIssue) {
    await onIssueStatusChanged(issue.id, "done", "in_review");
  }
}

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

  /**
   * AgentDash: work assigned to a person who stewards an agent goes to that
   * agent, whoever assigns it (see services/stewarded-agent-routing.ts).
   * Returns the input with `assignToPerson` removed — it is a request flag,
   * never stored — and the assignee moved when the rule applies. On an
   * update, a person who already holds the issue is not a new assignment and
   * is left alone, and an agent handing its issue back to the person who
   * created it (the return-to-creator exemption in issue-patch-actions.ts) is
   * returning work for review, not delegating it, so it is left alone too.
   * Work is never given to an agent the caller cannot see (agent visibility),
   * so a hidden steward's agent leaves the assignment with the person. A
   * person assigning themselves is taking the work, and a person named as a
   * reviewer or approver by the issue's execution policy is that stage's
   * participant: both keep the assignment.
   */
  async function routePersonAssigneeToStewardedAgent<
    T extends { assigneeAgentId?: string | null; assigneeUserId?: string | null; assignToPerson?: boolean },
  >(
    req: Request,
    companyId: string,
    input: T,
    current?: {
      assigneeUserId: string | null;
      assigneeAgentId: string | null;
      createdByUserId: string | null;
      executionPolicy?: unknown;
    },
  ): Promise<{ input: T; routed: StewardedAgentRoute | null }> {
    const { assignToPerson, ...fields } = input;
    const rest = fields as T;
    if (current && input.assigneeUserId === current.assigneeUserId) return { input: rest, routed: null };
    const actorAgentId = req.actor.type === "agent" ? req.actor.agentId ?? null : null;
    if (
      current &&
      actorAgentId &&
      current.assigneeAgentId === actorAgentId &&
      !!current.createdByUserId &&
      input.assigneeUserId === current.createdByUserId
    ) {
      return { input: rest, routed: null };
    }
    const requestedPolicy = (input as { executionPolicy?: unknown }).executionPolicy;
    if (
      typeof input.assigneeUserId === "string" &&
      namesStageUser(requestedPolicy !== undefined ? requestedPolicy : current?.executionPolicy, input.assigneeUserId)
    ) {
      return { input: rest, routed: null };
    }
    const routed = await resolveStewardedAgentRoute(db, {
      companyId,
      actorAgentId,
      actorUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
      assigneeAgentId: input.assigneeAgentId,
      assigneeUserId: input.assigneeUserId,
      assignToPerson,
    });
    if (!routed) return { input: rest, routed: null };
    const visibleIds = await visibleAgentIdsFor(db, req, companyId);
    if (visibleIds !== null && !visibleIds.has(routed.toAgentId)) return { input: rest, routed: null };
    return { input: { ...rest, assigneeAgentId: routed.toAgentId, assigneeUserId: null }, routed };
  }

  /** Whether an execution policy names this person as a stage participant. */
  function namesStageUser(policy: unknown, userId: string): boolean {
    const stages = (policy as { stages?: unknown } | null | undefined)?.stages;
    if (!Array.isArray(stages)) return false;
    return stages.some((stage) => {
      const participants = (stage as { participants?: unknown } | null)?.participants;
      return Array.isArray(participants) && participants.some((participant) => {
        const p = participant as { type?: unknown; userId?: unknown } | null;
        return p?.type === "user" && p.userId === userId;
      });
    });
  }

  /**
   * AgentDash: which accepted drafts were routed to a steward's agent when
   * they were written (the route stamps `routedFromStewardUserId` on the
   * draft), keyed by the issue each one became.
   */
  function routedDraftStewards(
    interaction: Awaited<ReturnType<ReturnType<typeof issueThreadInteractionService>["acceptInteraction"]>>["interaction"],
  ): Map<string, StewardedAgentRoute> {
    const byIssueId = new Map<string, StewardedAgentRoute>();
    if (interaction.kind !== "suggest_tasks") return byIssueId;
    const drafts = new Map(interaction.payload.tasks.map((task) => [task.clientKey, task]));
    for (const created of interaction.result?.createdTasks ?? []) {
      const draft = drafts.get(created.clientKey);
      if (draft?.routedFromStewardUserId && draft.assigneeAgentId) {
        byIssueId.set(created.issueId, { fromUserId: draft.routedFromStewardUserId, toAgentId: draft.assigneeAgentId });
      }
    }
    return byIssueId;
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

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes,
  // then apply the A5 project rule once for the whole surface (GH #830): an
  // issue in a restricted project is 404 — never 403 — on every sub-route
  // (comments, documents, heartbeat-context, PATCH, attachments, ...) for an
  // actor off the project's access list. `/work-products/:id` shares the
  // param name but not the meaning; its handlers check the owning issue.
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      const routePath: unknown = req.route?.path;
      if (typeof routePath === "string" && routePath.startsWith("/issues/:id")) {
        await assertIssueIdVisible(db, req, req.params.id);
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for company-scoped attachment routes,
  // under the same A5 project rule as /issues/:id.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      await assertIssueIdVisible(db, req, req.params.issueId);
      next();
    } catch (err) {
      next(err);
    }
  });

  /**
   * A5 on writes (GH #830): an issue may only be created in, or moved into,
   * a project the actor can see, and only under a parent it can see. 404,
   * matching the read side — a refusal naming the project would confirm it.
   * A workspace id names its project too: without `projectId` the service
   * does not match the workspace to a project, so check it here.
   */
  async function assertIssueWriteTargetsVisible(
    req: Request,
    companyId: string,
    body: {
      projectId?: unknown;
      parentId?: unknown;
      inheritExecutionWorkspaceFromIssueId?: unknown;
      projectWorkspaceId?: unknown;
      executionWorkspaceId?: unknown;
      blockedByIssueIds?: unknown;
      assigneeAgentId?: unknown;
    },
  ) {
    if (typeof body.projectId === "string") {
      await assertProjectIdVisible(db, req, companyId, body.projectId, "Project");
    }
    if (typeof body.parentId === "string") {
      await assertIssueIdVisible(db, req, body.parentId, "Parent issue");
    }
    if (typeof body.inheritExecutionWorkspaceFromIssueId === "string") {
      await assertIssueIdVisible(db, req, body.inheritExecutionWorkspaceFromIssueId);
    }
    await assertWorkspaceIdsVisible(db, req, body);
    // AgentDash (GH #830 follow-up): a blocker id is a link to another
    // issue; linking a restricted one would echo its title back in the
    // response. Missing, foreign and restricted ids share one 404.
    await assertIssueIdsVisibleInCompany(db, req, companyId, body.blockedByIssueIds);
    // Agent visibility (2026-09-30): work may only be given to an agent the
    // actor can see; an invisible one is nonexistent, so 404, not 403.
    if (typeof body.assigneeAgentId === "string" && body.assigneeAgentId) {
      const visibleIds = await visibleAgentIdsFor(db, req, companyId);
      if (visibleIds !== null && !visibleIds.has(body.assigneeAgentId)) throw notFound("Agent not found");
    }
  }

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
    // AgentDash: GH #701 — a literal reviewerAgentId that isn't a UUID used to
    // reach the SQL filter as a raw string and surface as a 500 (invalid uuid
    // cast). Reject non-UUID literals (except the "me" alias) with 400.
    if (
      reviewerAgentId !== undefined &&
      reviewerAgentFilterRaw !== "me" &&
      !isUuidLike(reviewerAgentId)
    ) {
      res.status(400).json({ error: "reviewerAgentId must be a UUID" });
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

    // Agent visibility (2026-09-30) composes with A5 here; the one predicate
    // is the same one the /issues/:id guard asks of a single row.
    await resolveAgentVisibility(db, req, companyId);
    const result = await svc.list(companyId, {
      visibleWhere: issueVisibilityCondition(req, companyId),
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
    // A5: a visible issue's blockedBy must not name an invisible blocker.
    // GH #863: and its parentId / blockerAttention samples must not name one either.
    // AgentDash (GH #505): the steward chip names the person; its email goes
    // only to callers allowed to read member emails.
    const canViewEmails = await canViewMemberEmails(access, req, companyId);
    const emailScoped = canViewEmails
      ? result
      : result.map((row) => {
          const steward = (row as { assigneeSteward?: { userId: string; email: string | null } | null })
            .assigneeSteward;
          if (!steward) return row;
          return {
            ...row,
            assigneeSteward: {
              ...steward,
              email: visibleMemberEmail(req, false, steward.userId, steward.email),
            },
          };
        });
    res.json(
      await redactHiddenIssueRefsOnRows(db, req, companyId, await filterVisibleBlockedByOnRows(db, req, companyId, emailScoped)),
    );
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
        // A5: ancestors and related issues follow the viewer's visibility.
        svc.getAncestors(issue.id).then((rows) => truncateAncestorsAtInvisible(db, req, issue.companyId, rows)),
        svc.getCommentCursor(issue.id),
        wakeCommentId ? svc.getComment(wakeCommentId) : null,
        svc.getRelationSummaries(issue.id).then((rows) => filterVisibleIssueRelations(db, req, issue.companyId, rows)),
        svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
        svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
        svc.listAttachments(issue.id),
        documentsSvc.getIssueDocumentByKey(issue.id, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY),
        currentExecutionWorkspacePromise,
      ]);
    // GH #863: parentId and the blocker-attention samples follow visibility too.
    const [visibleRefs] = await redactHiddenIssueRefsOnRows(db, req, issue.companyId, [
      { parentId: issue.parentId, blockerAttention },
    ]);

    res.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        ...(visibleRefs!.blockerAttention ? { blockerAttention: visibleRefs!.blockerAttention } : {}),
        productivityReview,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: goal?.id ?? issue.goalId,
        parentId: visibleRefs!.parentId,
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
      // A5 (GH #830 follow-up): ancestors, related issues, mentioned
      // projects and related work follow the viewer's visibility.
      svc.getAncestors(issue.id).then((rows) => truncateAncestorsAtInvisible(db, req, issue.companyId, rows)),
      svc.findMentionedProjectIds(issue.id, { includeCommentBodies: false }).then(async (projectIds) => {
        const visible = await Promise.all(projectIds.map((projectId) => isProjectIdVisible(db, req, projectId)));
        return projectIds.filter((_projectId, index) => visible[index]);
      }),
      documentsSvc.getIssueDocumentPayload(issue),
      svc.getRelationSummaries(issue.id).then((rows) => filterVisibleIssueRelations(db, req, issue.companyId, rows)),
      svc.listBlockerAttention(issue.companyId, [issue]).then((map) => map.get(issue.id) ?? null),
      svc.listProductivityReviews(issue.companyId, [issue.id]).then((map) => map.get(issue.id) ?? null),
      issueReferencesSvc
        .listIssueReferenceSummary(issue.id)
        .then((summary) => filterVisibleReferenceSummary(db, req, issue.companyId, summary)),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.companyId, mentionedProjectIds)
      : [];
    const currentExecutionWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    // GH #863: parentId and the blocker-attention samples follow visibility too.
    const [visibleRefs] = await redactHiddenIssueRefsOnRows(db, req, issue.companyId, [
      { parentId: issue.parentId, blockerAttention },
    ]);
    res.json({
      ...issue,
      parentId: visibleRefs!.parentId,
      goalId: goal?.id ?? issue.goalId,
      ancestors,
      ...(visibleRefs!.blockerAttention ? { blockerAttention: visibleRefs!.blockerAttention } : {}),
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

  // AgentDash (Scan 3 lane I): the run a work product came from. The caller's
  // own run wins. A run id in the body is kept only when it is a run in this
  // company and the caller may speak for it: a board user, or an agent naming
  // its own run or a run of the issue's assignee. It is a foreign key, and it
  // decides which agent Shipped names.
  async function resolveWorkProductRunId(
    req: Request,
    issue: { companyId: string; assigneeAgentId?: string | null },
    bodyRunId: unknown,
  ): Promise<string | null> {
    const actor = getActorInfo(req);
    if (actor.runId) return actor.runId;
    if (typeof bodyRunId !== "string" || !isCanonicalUuid(bodyRunId)) return null;
    const run = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, bodyRunId), eq(heartbeatRuns.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!run) return null;
    if (req.actor.type === "board") return run.id;
    if (actor.agentId && (run.agentId === actor.agentId || run.agentId === issue.assigneeAgentId)) return run.id;
    return null;
  }

  // AgentDash (Scan 3 lane I): see workProductSelfAcceptanceRefusal.
  function refuseSelfAcceptance(
    req: Request,
    res: Response,
    body: { status?: unknown; reviewState?: unknown; type?: unknown },
    existing?: { type: string; status: string; metadata?: unknown },
  ): boolean {
    const error = workProductSelfAcceptanceRefusal(
      { type: req.actor.type, source: req.actor.source },
      body,
      existing?.type,
      existing?.status,
      existing?.metadata,
    );
    if (!error) return false;
    res.status(403).json({ error, code: "work_product_self_acceptance" });
    return true;
  }

  // AgentDash (Scan 4 lane M): review metadata is written by the server
  // (acceptance on Accept, changesRequestedAt on Request changes,
  // resubmittedAt on resubmit). An agent or assistant grant can neither set
  // nor erase it: client values for these keys are dropped and the stored
  // ones carried over, since a metadata PATCH replaces the whole object.
  const SERVER_OWNED_WORK_PRODUCT_METADATA_KEYS = [
    "acceptance",
    "changesRequestedAt",
    "changesRequestedAtRevision",
    "changesRequestedRevisionId",
    "resubmittedAt",
    "reviewReopenedAt",
    "reviewReopenReason",
  ] as const;
  // AgentDash (review #1003): once a deliverable is submitted for review, the
  // document it binds to is server-owned — otherwise an agent could drop or
  // rewrite documentKey and the revision baseline check would be skipped.
  // Round-2 follow-up: a bound key is locked whenever it is already set too,
  // not only from ready_for_review onward.
  const DOCUMENT_KEY_LOCKED_STATUSES = new Set(["ready_for_review", "changes_requested", "approved", "merged"]);
  function protectServerOwnedMetadata<T extends object>(
    req: Request,
    body: T,
    existingMetadata: Record<string, unknown> | null | undefined,
    existingStatus?: string | null,
  ): T {
    if (req.actor.type !== "agent" && req.actor.source !== "assistant_grant") return body;
    if (!("metadata" in body)) return body;
    const documentKeyLocked =
      (!!existingStatus && DOCUMENT_KEY_LOCKED_STATUSES.has(existingStatus))
      || (!!existingMetadata && "documentKey" in existingMetadata);
    const supplied = (body as { metadata?: unknown }).metadata;
    const incoming = supplied && typeof supplied === "object" ? { ...(supplied as Record<string, unknown>) } : null;
    for (const key of SERVER_OWNED_WORK_PRODUCT_METADATA_KEYS) delete incoming?.[key];
    if (documentKeyLocked) delete incoming?.documentKey;
    const kept: Record<string, unknown> = {};
    for (const key of SERVER_OWNED_WORK_PRODUCT_METADATA_KEYS) {
      if (existingMetadata && key in existingMetadata) kept[key] = existingMetadata[key];
    }
    if (documentKeyLocked && existingMetadata && "documentKey" in existingMetadata) {
      kept.documentKey = existingMetadata.documentKey;
    }
    const merged = { ...(incoming ?? {}), ...kept };
    return { ...body, metadata: Object.keys(merged).length > 0 ? merged : incoming } as T;
  }

  // AgentDash (Scan 3 lane I): a file: URL names a path on the agent's
  // machine. It opens nothing for anyone else, so it is not stored.
  function withoutLocalFileUrl<T extends { url?: unknown }>(body: T): T {
    return typeof body.url === "string" && /^\s*file:/i.test(body.url) ? { ...body, url: null } : body;
  }

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
    // AgentDash (Scan 3 lane I): `accepted=true` is the Shipped view: only
    // work a board user accepted (or that merged). Without it every work
    // product is listed (an issue's Result block shows what awaits review).
    const rawAccepted = req.query.accepted;
    if (rawAccepted !== undefined && rawAccepted !== "true" && rawAccepted !== "false") {
      res.status(400).json({ error: "accepted must be true or false" });
      return;
    }
    res.json(
      await workProductsSvc.listForCompany(companyId, {
        acceptedOnly: rawAccepted === "true",
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

    await applyDeliverableReviewAfterDocumentRevision({
      db,
      issue,
      key: doc.key,
      latestRevisionId: doc.latestRevisionId,
      latestRevisionNumber: doc.latestRevisionNumber,
      actor: { ...actor, source: req.actor.source },
      onIssueStatusChanged: (issueId, before, after) => cosVerdictOrchestratorSvc.onIssueStatusChanged(issueId, before, after),
    });

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

      await applyDeliverableReviewAfterDocumentRevision({
        db,
        issue,
        key: result.document.key,
        latestRevisionId: result.document.latestRevisionId,
        latestRevisionNumber: result.document.latestRevisionNumber,
        actor: { ...actor, source: req.actor.source },
        onIssueStatusChanged: (issueId, before, after) => cosVerdictOrchestratorSvc.onIssueStatusChanged(issueId, before, after),
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
    if (refuseSelfAcceptance(req, res, req.body)) return;
    // AgentDash (review #1003 follow-up): a fresh deliverable bound to the
    // same documentKey as an already-reviewed one revives Accept for it with
    // no new revision — delete-and-recreate through the row instead of the
    // field. Refused for agents, same as the reviewed-status write.
    if (req.actor.type === "agent" || req.actor.source === "assistant_grant") {
      const documentKey = workProductDocumentKey((req.body as { metadata?: unknown }).metadata);
      if (documentKey) {
        const bound = await db
          .select({ status: issueWorkProducts.status, metadata: issueWorkProducts.metadata })
          .from(issueWorkProducts)
          .where(and(
            eq(issueWorkProducts.companyId, issue.companyId),
            eq(issueWorkProducts.issueId, issue.id),
            sql`${issueWorkProducts.metadata} ->> 'documentKey' = ${documentKey}`,
          ));
        if (bound.some((row) => workProductWasReviewed(row.status ?? undefined, row.metadata))) {
          res.status(403).json({
            error: "A reviewed deliverable already binds that document. Write the revised document revision, then move the issue to in_review.",
            code: "work_product_self_acceptance",
          });
          return;
        }
      }
    }
    const actor = getActorInfo(req);
    const product = await workProductsSvc.createForIssue(issue.id, issue.companyId, {
      ...protectServerOwnedMetadata(req, withoutLocalFileUrl(req.body), null),
      // AgentDash (Scan 3 lane I): a path-like title shows as its file name.
      title: sanitizeWorkProductTitle(req.body.title),
      projectId: req.body.projectId ?? issue.projectId ?? null,
      // AgentDash (Scan 3 lane I): the run that recorded it, so Shipped can
      // name the agent that made it.
      createdByRunId: await resolveWorkProductRunId(req, issue, req.body.createdByRunId),
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
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
    await assertIssueIdVisible(db, req, existing.issueId, "Work product");
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (refuseSelfAcceptance(req, res, req.body, existing)) return;
    const actor = getActorInfo(req);
    const patch: Record<string, unknown> = protectServerOwnedMetadata(
      req,
      { ...withoutLocalFileUrl(req.body as { url?: unknown }) },
      existing.metadata,
      existing.status,
    );
    if (typeof patch.title === "string") patch.title = sanitizeWorkProductTitle(patch.title);
    if ("createdByRunId" in patch) {
      patch.createdByRunId = await resolveWorkProductRunId(req, issue, patch.createdByRunId);
    }
    const product = await workProductsSvc.update(id, patch);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
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
    await assertIssueIdVisible(db, req, existing.issueId, "Work product");
    const issue = await svc.getById(existing.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    // AgentDash (review #1003 follow-up): deleting a reviewed deliverable and
    // recording a fresh ready_for_review one revives Accept with no new
    // revision — the same bypass the status-write refusal closes, through the
    // row instead of the field.
    if (
      (req.actor.type === "agent" || req.actor.source === "assistant_grant")
      && workProductWasReviewed(existing.status, existing.metadata)
    ) {
      res.status(403).json({
        error: "Only the server removes a reviewed deliverable: write the revised document revision, then move the issue to in_review.",
        code: "work_product_self_acceptance",
      });
      return;
    }
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
    const canReadSpend = await canReadCompanySpend(db, req, issue.companyId);
    res.json(approvals.map(approval => redactApprovalForReader(approval, canReadSpend)));
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
    const canReadSpend = await canReadCompanySpend(db, req, issue.companyId);
    res.status(201).json(approvals.map(approval => redactApprovalForReader(approval, canReadSpend)));
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
    await assertIssueWriteTargetsVisible(req, companyId, req.body);
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
    const { requestId: _requestId, ...requestedInput } = req.body;
    const { input: issueInput, routed: routedToStewardedAgent } =
      await routePersonAssigneeToStewardedAgent(req, companyId, requestedInput);
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
        ...(routedToStewardedAgent ? { routedToStewardedAgent } : {}),
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
      routedFromStewardUserId: routedToStewardedAgent?.fromUserId ?? null,
    });

    // A5: a mention of a restricted issue in the new description must not
    // echo that issue's title back.
    const visibleReferenceSummary = await filterVisibleReferenceSummary(db, req, companyId, referenceSummary);
    res.status(201).json({
      ...issue,
      ...(routedToStewardedAgent ? { routedToStewardedAgent } : {}),
      relatedWork: visibleReferenceSummary,
      referencedIssueIdentifiers: visibleReferenceSummary.outbound.map(
        (item) => item.issue.identifier ?? item.issue.id,
      ),
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
    await assertIssueWriteTargetsVisible(req, parent.companyId, req.body);
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
    const { input: childInput, routed: routedToStewardedAgent } =
      await routePersonAssigneeToStewardedAgent(req, parent.companyId, req.body);
    const routeUnownedTodoToChiefOfStaff = await callerMayRouteToChiefOfStaff(req, parent.companyId, childInput);
    const { issue, parentBlockerAdded } = await svc.createChild(parent.id, {
      ...childInput,
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
        ...(wasRoutedToChiefOfStaff(childInput, issue) ? { routedToChiefOfStaff: issue.assigneeAgentId } : {}),
        ...(routedToStewardedAgent ? { routedToStewardedAgent } : {}),
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
      routedFromStewardUserId: routedToStewardedAgent?.fromUserId ?? null,
    });

    res.status(201).json(routedToStewardedAgent ? { ...issue, routedToStewardedAgent } : issue);
  });

  router.patch("/issues/:id", validate(updateIssueRouteSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) throw notFound("Issue not found");
    assertCompanyAccess(req, existing.companyId);
    // AgentDash (GH #830 A5, #854/#868): write targets are checked before
    // acceptance, so a restricted project/parent/blocker is 404 here.
    await assertIssueWriteTargetsVisible(req, existing.companyId, req.body);
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
    const { input: patchIntent, routed: routedToStewardedAgent } =
      await routePersonAssigneeToStewardedAgent(req, existing.companyId, req.body, existing);
    try {
      const context: IssuePatchContext = { issueId: existing.id, companyId: existing.companyId,
        actor: getActorInfo(req), actorKind: req.actor.type, actorSource: req.actor.source, attribution: assistantGrantAttribution(req), intent: patchIntent,
        ...(routedToStewardedAgent ? { routedToStewardedAgent } : {}),
        stageAuthority: issueCurrentAuthority(req, req.body.projectId),
        validate: async (executor, current, intent) => {
          const policyDb = executor as Db;
          await assertHostWorkspaceCommandAuthority(policyDb, req, current.companyId, collectIssueWorkspaceCommandPaths(intent, {
            executionWorkspaceSettings: current.executionWorkspaceSettings, assigneeAdapterOverrides: current.assigneeAdapterOverrides }));
          assertIssueOverrideHostExecutionAllowed(req, current.assigneeAdapterOverrides);
          if (req.actor.type === "agent" && intent.assigneeAdapterOverrides !== undefined) throw new IssueCommentPolicyRefusal(403, {
            error: "Agent-authenticated callers cannot change assigneeAdapterOverrides; only a human with agent-configuration authority may change adapter or model configuration" });
          await assertAgentIssueMutationAllowed(req, res, current, policyDb);
          // AgentDash (GH #891 F-A): an agent cannot move an exhausted issue
          // into in_progress (the first half of taking it over) unless its run
          // is the one a board user authorized. Checkout and lock adoption
          // refuse the same way in services/issues.ts.
          if (req.actor.type === "agent" && intent.status === "in_progress" && current.status !== "in_progress"
            && !exhaustedRecoveryBudgetAllowsRun(current.executionState, { runId: getActorInfo(req).runId, agentId: req.actor.agentId ?? "" })) {
            throw new IssueCommentPolicyRefusal(409, { error: EXHAUSTED_RECOVERY_CHECKOUT_REFUSAL, code: "task_recovery_budget_exhausted" });
          }
          if (intent.executionWorkspaceSettings?.environmentId) await assertEnvironmentSelectionForCompany(environmentService(policyDb),
            current.companyId, intent.executionWorkspaceSettings.environmentId, { allowedDrivers: ["local", "ssh", "sandbox"] });
          const { comment, reviewRequest, reopen: _reopen, resume: _resume, interrupt: _interrupt, hiddenAt: _hiddenAt, acceptedDocumentRevisions: _acceptedDocumentRevisions, ...fields } = intent;
          const agentWork = req.actor.type === "agent" && (Object.keys(fields).length > 0 || reviewRequest !== undefined);
          const workspace = current.executionWorkspaceId ? await executionWorkspaceServiceDirect(policyDb).getById(current.executionWorkspaceId) : null;
          if (workspace && isClosedIsolatedExecutionWorkspace(workspace) && (comment || agentWork)) throw new IssueCommentPolicyRefusal(409, {
            error: getClosedIsolatedExecutionWorkspaceMessage(workspace), executionWorkspace: workspace });
        },
        validateResume: async (executor, current) => { await assertExplicitResumeIntentAllowed(req, res, current, executor as Db); },
        validateAssignment: (executor, current) => assertCanAssignTasks(req, current.companyId, executor as Db),
        // A5 (GH #830 follow-up): keep blockers the actor cannot see instead
        // of silently dropping links in a restricted project.
        retainHiddenBlockerIds: async (executor, companyId, blockerIds) => {
          const visible = await listVisibleIssueIds(executor as Db, req, companyId, blockerIds);
          return blockerIds.filter((blockerId) => !visible.has(blockerId));
        },
      };
      const accepted = await actions.accept(context);
      const effects = await actions.dispatch(accepted);
      if (effects.unresolved) {
        logger.warn({ issueId: existing.id, mutationId: accepted.mutationId, effects: effects.outcomes }, "issue update accepted with unresolved effects");
        res.status(500).json({ error: "Issue update accepted, but follow-up effects are unresolved. Read the issue before retrying." });
        return;
      }
      let issueResponse = accepted.issueResponse;
      // A5: the response names only blockers and related work the actor can see.
      if (Array.isArray(issueResponse.blockedBy) && Array.isArray(issueResponse.blocks)) {
        const visibleRelations = await filterVisibleIssueRelations(db, req, existing.companyId, {
          blockedBy: issueResponse.blockedBy,
          blocks: issueResponse.blocks,
        } as Awaited<ReturnType<typeof svc.getRelationSummaries>>);
        issueResponse = { ...issueResponse, blockedBy: visibleRelations.blockedBy, blocks: visibleRelations.blocks };
      }
      if (issueResponse.relatedWork) {
        const visibleRelatedWork = await filterVisibleReferenceSummary(db, req, existing.companyId, issueResponse.relatedWork);
        issueResponse = {
          ...issueResponse,
          relatedWork: visibleRelatedWork,
          referencedIssueIdentifiers: visibleRelatedWork.outbound.map((item) => item.issue.identifier ?? item.issue.id),
        };
      }
      // AgentDash (recovery budget, explicit clear): say so when the marker
      // outlives this update, and point at the explicit clear.
      const budgetNotice = recoveryBudgetNotice(accepted.issue.id, accepted.issue.executionState);
      res.json({ ...issueResponse, comment: accepted.comment, ...(routedToStewardedAgent ? { routedToStewardedAgent } : {}),
        ...(budgetNotice ? { recoveryBudgetNotice: budgetNotice } : {}) });
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

  // AgentDash (Scan 3 lane I): a board user sends a deliverable back. One
  // server action: in one transaction the note is posted as a comment, the
  // issue returns to work (in_progress, or todo when nobody is assigned), and
  // the work products that were waiting for review are marked
  // changes_requested. The assignee is woken by the comment after commit.
  router.post("/issues/:id/request-changes", validate(requestIssueChangesSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) throw notFound("Issue not found");
    assertCompanyAccess(req, existing.companyId);
    await assertIssueIdVisible(db, req, existing.id, "Issue");
    if (req.actor.type !== "board" || req.actor.source === "assistant_grant" || getActorInfo(req).actorType !== "user") {
      res.status(403).json({ error: "Only a board user can request changes on a deliverable." });
      return;
    }
    if (existing.status === "done" || existing.status === "cancelled") {
      res.status(409).json({ error: "This issue is closed. Reopen it to ask for changes." });
      return;
    }
    const waiting = (await workProductsSvc.listForIssue(existing.id)).filter((product) => product.status === "ready_for_review");
    if (waiting.length === 0) {
      res.status(409).json({ error: "Nothing on this issue is waiting for review." });
      return;
    }
    const status = existing.assigneeAgentId || existing.assigneeUserId ? "in_progress" : "todo";
    const actions = issuePatchActions(db, heartbeat, {
      statusChanged: (id, before, after) => cosVerdictOrchestratorSvc.onIssueStatusChanged(id, before, after),
    });
    try {
      const context: IssuePatchContext = { issueId: existing.id, companyId: existing.companyId,
        actor: getActorInfo(req), actorKind: req.actor.type, actorSource: req.actor.source, attribution: assistantGrantAttribution(req),
        intent: { status, comment: req.body.note },
        requestChanges: true,
        validate: async () => undefined,
        validateResume: async () => undefined,
        validateAssignment: (executor, current) => assertCanAssignTasks(req, current.companyId, executor as Db),
      };
      const accepted = await actions.accept(context);
      const effects = await actions.dispatch(accepted);
      if (effects.unresolved) {
        logger.warn({ issueId: existing.id, mutationId: accepted.mutationId, effects: effects.outcomes }, "request changes accepted with unresolved effects");
        res.status(500).json({ error: "Changes were requested, but follow-up effects are unresolved. Read the issue before retrying." });
        return;
      }
      const workProducts = await workProductsSvc.listForIssue(existing.id);
      res.json({
        issue: { id: accepted.issue.id, identifier: accepted.issue.identifier, status: accepted.issue.status, companyId: accepted.issue.companyId },
        comment: accepted.comment,
        workProducts,
      });
    } catch (error) {
      if (error instanceof IssueCommentPolicyRefusal) {
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
      // AgentDash (GH #863, #864 follow-up): the row is already gone, so the
      // live-events filter cannot look its project up; carry it on the event.
      details: { projectId: issue.projectId ?? null },
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

  // AgentDash (recovery budget remediation): "Clear recovery block & retry".
  // Removes an exhausted automatic-recovery marker, moves a budget-blocked
  // issue back to `todo` when nothing else blocks it, and wakes the assignee.
  // The clear resets the retry ledger (see services/issue-recovery-budget.ts),
  // so the agent gets a fresh automatic-retry window, not an unlimited one.
  // AgentDash (#881 review P3): audited exit from a workspace-persistence
  // quarantine. A person checks the workspace and issue first; this only
  // marks the unresolved attempts resolved (no file cleanup, no replay).
  // `{ agentId }` clears an agent-level hold (an attempt with no issue) and
  // needs company admin; `{ issueId }` needs a human board user who can see
  // the issue.
  router.post("/companies/:companyId/workspace-recovery/clear", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!isHumanBoardActor(req) || !req.actor.userId && req.actor.source !== "local_implicit") {
      res.status(403).json({ error: "Only a board user can clear a workspace recovery hold" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const body = (req.body ?? {}) as { issueId?: unknown; agentId?: unknown; note?: unknown };
    // #882 review P3: an empty id is a malformed request (400), not a refusal.
    const rawIssueId = typeof body.issueId === "string" && body.issueId.trim() ? body.issueId.trim() : null;
    const agentId = typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : null;
    if ((rawIssueId === null) === (agentId === null)) {
      res.status(400).json({ error: "Pass exactly one of issueId or agentId" });
      return;
    }
    // Accept an identifier (AGE-12) or a UUID; the clear always uses the row id.
    const issueId = rawIssueId ? await normalizeIssueIdentifier(rawIssueId) : null;
    if (!issueId) {
      const isAdmin = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin || actorHumanRole(req, companyId) === "admin";
      if (!isAdmin) throw forbidden("Clearing an agent-level workspace hold requires company admin");
    }
    const actor = getActorInfo(req);
    const result = await clearWorkspacePersistenceHold(db, {
      companyId, issueId, agentId, actorUserId: actor.actorId,
      note: typeof body.note === "string" ? body.note.slice(0, 2000) : null,
      // Target, company and visibility are checked on the clear transaction,
      // after the company lock (#881 re-review).
      authorize: async (tx) => {
        if (issueId) {
          if (!isCanonicalUuid(issueId)) throw notFound("Issue not found");
          const [issue] = await tx.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
          if (!issue || issue.companyId !== companyId) throw notFound("Issue not found");
          await assertIssueIdVisible(tx, req, issue.id);
        } else {
          if (!isCanonicalUuid(agentId)) throw notFound("Agent not found");
          const [agent] = await tx.select({ id: agents.id, companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId!));
          if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
        }
      },
    });
    if (result.clearedRunIds.length === 0) {
      res.status(409).json({ error: "No unresolved workspace attempt matches" });
      return;
    }
    res.json({ cleared: true, runIds: result.clearedRunIds });
  });

  router.post("/issues/:id/recovery-budget/clear", async (req, res) => {
    if (!isHumanBoardActor(req)) {
      res.status(403).json({ error: "Only a board user can clear an issue's recovery block" });
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
    await assertProjectIdVisible(db, req, existing.companyId, existing.projectId);
    if (!hasExhaustedRecoveryBudget(existing.executionState)) {
      res.status(409).json({ error: "Issue has no exhausted recovery budget to clear" });
      return;
    }

    const actor = getActorInfo(req);
    const hasUnresolvedBlockers =
      existing.status === "blocked"
        ? (await svc.getDependencyReadiness(existing.id)).unresolvedBlockerCount > 0
        : false;
    const moveToTodo = existing.status === "blocked" && !hasUnresolvedBlockers;

    const cleared = await clearIssueRecoveryBudget(db, {
      companyId: existing.companyId,
      issueId: existing.id,
      actorUserId: actor.actorId,
      trigger: "explicit_action",
      runId: actor.runId,
      details: {
        previousStatus: existing.status,
        ...(moveToTodo ? { nextStatus: "todo" } : {}),
        ...(hasUnresolvedBlockers ? { unresolvedBlockers: true } : {}),
      },
    });
    if (!cleared) {
      res.status(409).json({ error: "Issue has no exhausted recovery budget to clear" });
      return;
    }

    let issue = cleared.issue;
    if (moveToTodo) {
      const reopened = await svc.update(existing.id, { status: "todo", actorUserId: actor.actorId });
      if (reopened) {
        issue = reopened;
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
            status: "todo",
            identifier: issue.identifier,
            source: "recovery_budget_clear",
            _previous: { status: existing.status },
          },
        });
      }
    }

    let retryQueued = false;
    if (issue.assigneeAgentId && (issue.status === "todo" || issue.status === "in_progress")) {
      const wake = await heartbeat
        .wakeup(issue.assigneeAgentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "issue_recovery_budget_cleared",
          payload: { issueId: issue.id, mutation: "recovery_budget_clear" },
          requestedByActorType: "user",
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            source: "issue.recovery_budget_clear",
            wakeReason: "issue_recovery_budget_cleared",
          },
        })
        .catch((err) => {
          logger.warn({ err, issueId: issue.id }, "failed to wake assignee after clearing recovery budget");
          return null;
        });
      retryQueued = Boolean(wake);
    }

    res.json({
      issue,
      cleared: true,
      retryQueued,
      ...(hasUnresolvedBlockers ? { stillBlockedByIssues: true } : {}),
    });
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
        const guard = await authority.stage(executor, { companyId, operationId, input, native: true, readOnly: !mutation });
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
  // AgentDash (#882 review P2): assistant connectors act through an OAuth
  // grant, not a named board credential, so the named-owner authority cannot
  // admit them. They keep ordinary interactions; private (owner-pinned or
  // workforce) questions stay out of their reach.
  const isAssistantActor = (req: Request) => req.actor.type === 'board' && req.actor.source === 'assistant_grant';
  const isPrivateQuestion = (value: { kind: string; payload?: unknown }) => {
    if (value.kind !== 'ask_user_questions') return false;
    const payload = (value.payload ?? {}) as { answerOwnerUserId?: unknown; workforceAgentId?: unknown; workforceEnrollmentId?: unknown; workforceTemplateId?: unknown; questions?: Array<{ companyFactKey?: unknown }> };
    return Boolean(payload.answerOwnerUserId || payload.workforceAgentId || payload.workforceEnrollmentId || payload.workforceTemplateId
      || payload.questions?.some(question => question.companyFactKey));
  };
  async function assistantQuestionWrite<T>(issue: { id: string; companyId: string }, interactionId: string,
    work: (executor: Db, acceptance: ActivityAcceptance) => Promise<T>) {
    const current = await issueThreadInteractionService(db).getById(interactionId);
    if (!current || current.issueId !== issue.id || isPrivateQuestion(current)) throw notFound("Interaction not found");
    const publications: ActivityPublication[] = [];
    const value = await db.transaction(async tx => work(tx as unknown as Db, { executor: tx as unknown as Db, publications }));
    for (const publication of publications) publishActivity(publication);
    return value;
  }
  router.get("/issues/:id/interactions", async (req, res) => {
    const authority = req.actor.type === 'board' && !isAssistantActor(req) ? foundationAuthority(req) : null;
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
    }) : (await issueThreadInteractionService(db).listForIssue(id))
      .filter(value => !isAssistantActor(req) || !isPrivateQuestion(value));
    res.json(interactions);
  });

  router.post("/issues/:id/interactions", validate(createIssueThreadInteractionSchema), async (req, res) => {
    const authority = req.actor.type === 'board' && !isAssistantActor(req) && req.body.kind === 'ask_user_questions' ? foundationAuthority(req) : null;
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
    // AgentDash: drafts are routed when they are written, whoever writes them:
    // a person who stewards an agent is replaced by that agent now, so the
    // person accepting (board-only) sees the assignee the task will really
    // have. Acceptance creates the stored drafts as they stand.
    const routedSuggestedTasks: Array<StewardedAgentRoute & { clientKey: string }> = [];
    let interactionBody = req.body;
    if (req.body.kind === "suggest_tasks") {
      const tasks = [];
      for (const { routedFromStewardUserId: _ignored, ...task } of req.body.payload.tasks) {
        const { input, routed } = await routePersonAssigneeToStewardedAgent(req, issue.companyId, task);
        if (routed) routedSuggestedTasks.push({ clientKey: task.clientKey, ...routed });
        tasks.push(routed ? { ...input, routedFromStewardUserId: routed.fromUserId } : input);
      }
      interactionBody = { ...req.body, payload: { ...req.body.payload, tasks } };
    }
    const interaction = await issueThreadInteractionService(db).create(issue, {
      ...interactionBody,
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
        ...(routedSuggestedTasks.length > 0 ? { routedToStewardedAgent: routedSuggestedTasks } : {}),
      },
    });

    res.status(201).json(routedSuggestedTasks.length > 0 ? { ...interaction, routedToStewardedAgent: routedSuggestedTasks } : interaction);
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

      const stewardByCreatedIssueId = routedDraftStewards(interaction);
      for (const createdIssue of createdIssues) {
        const routed = stewardByCreatedIssueId.get(createdIssue.id);
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "interaction_accept",
          contextSource: "issue.interaction.accept",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          routedFromStewardUserId:
            routed && routed.toAgentId === createdIssue.assigneeAgentId ? routed.fromUserId : null,
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
      const authority = isAssistantActor(req) ? null : foundationAuthority(req);
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
      const respond = async (executor: Db, acceptance: ActivityAcceptance, guards: QuestionWriteGuards = {}) => {
        const value = await issueThreadInteractionService(executor).answerQuestions(issue, interactionId, req.body, { agentId: actor.agentId, userId: actor.actorType === 'user' ? actor.actorId : null }, acceptance, guards);
        acceptance.publications.push(await insertActivity(executor, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
          action: 'issue.thread_interaction_answered', entityType: 'issue', entityId: issue.id,
          details: { interactionId: value.id, interactionKind: value.kind, interactionStatus: value.status, answeredQuestionCount: value.kind === 'ask_user_questions' ? value.result?.answers?.length ?? 0 : 0 } }, guards.beforeWrite));
        return value;
      };
      const interaction = authority
        ? await protectedQuestions(req, authority, issue.companyId, 'human_questions.respond', { issueId: id, interactionId, shareWithCompany: req.body.shareWithCompany === true }, (executor, acceptance, guards) => respond(executor, acceptance, guards), true)
        : await assistantQuestionWrite(issue, interactionId, (executor, acceptance) => respond(executor, acceptance));

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.respond",
      });

      res.json(authority ? await currentQuestion(req, authority, issue, interaction.id) : interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/cancel",
    validate(cancelIssueThreadInteractionSchema),
    async (req, res) => {
      const authority = isAssistantActor(req) ? null : foundationAuthority(req);
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
      const respond = async (executor: Db, acceptance: ActivityAcceptance, guards: QuestionWriteGuards = {}) => {
        const value = await issueThreadInteractionService(executor).cancelQuestions(issue, interactionId, req.body, { agentId: actor.agentId, userId: actor.actorType === 'user' ? actor.actorId : null }, acceptance, guards);
        acceptance.publications.push(await insertActivity(executor, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
          action: 'issue.thread_interaction_cancelled', entityType: 'issue', entityId: issue.id,
          details: { interactionId: value.id, interactionKind: value.kind, interactionStatus: value.status, cancellationReason: value.kind === 'ask_user_questions' ? value.result?.cancellationReason ?? null : null } }, guards.beforeWrite));
        return value;
      };
      const interaction = authority
        ? await protectedQuestions(req, authority, issue.companyId, 'human_questions.cancel', { issueId: id, interactionId }, (executor, acceptance, guards) => respond(executor, acceptance, guards), true)
        : await assistantQuestionWrite(issue, interactionId, (executor, acceptance) => respond(executor, acceptance));

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.cancel",
      });

      res.json(authority ? await currentQuestion(req, authority, issue, interaction.id) : interaction);
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
      // A5: a trace captured while the issue sat in a restricted project.
      visibleWhere: feedbackTraceVisibilityCondition(req, issue.companyId),
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
    const trace = isCanonicalUuid(traceId) ? await feedback.getFeedbackTraceById(traceId, includePayload) : null;
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    // A5 (GH #830 follow-up): a trace carries its issue's title and a
    // payload snapshot; one on an invisible issue or project is 404.
    await assertFeedbackTraceVisible(db, req, trace);
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    // A5: resolve the trace's issue/project first, before building the bundle.
    const trace = isCanonicalUuid(traceId) ? await feedback.getFeedbackTraceById(traceId, false) : null;
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    await assertFeedbackTraceVisible(db, req, trace);
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    // Document access (slice 6b): a bundle carries its source run's log and
    // events, so it follows the run's readership rule (steward, instance
    // admin) while the company's flag is on.
    const sourceRun = bundle.paperclipRun;
    const sourceAgentId = typeof sourceRun?.agentId === "string" ? sourceRun.agentId : null;
    const documentRuns = documentRunAccess(db);
    const unreadable = sourceRun
      ? sourceAgentId
        ? !(await documentRuns.canReadRunContent(req.actor, { companyId: bundle.companyId, agentId: sourceAgentId }))
        // A run whose agent cannot be read back: fail closed while flagged.
        : await documentRuns.documentAccessEnabled(bundle.companyId)
      : false;
    if (unreadable) {
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
      // AgentDash (recovery budget, explicit clear): a comment (reopening or
      // not) leaves an exhausted marker in place; say so and point at the clear.
      const budgetNotice = recoveryBudgetNotice(issue.id, accepted.currentIssue.executionState);
      res.status(201).json(budgetNotice ? { ...accepted.comment, recoveryBudgetNotice: budgetNotice } : accepted.comment);
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
    await assertIssueIdVisible(db, req, attachment.issueId, "Attachment");

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
    await assertIssueIdVisible(db, req, attachment.issueId, "Attachment");
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

  // AgentDash (Ross launch M2): the governed question-to-Ross request. Defined
  // on this router so router.param("id") applies identifier resolution and the
  // A5 project rule (404) exactly as it does for /issues/:id/comments.
  registerRossRequestRoutes(router, { db, heartbeat });

  return router;
}
