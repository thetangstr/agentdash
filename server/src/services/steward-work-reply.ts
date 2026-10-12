import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  bridgeEndpoints,
  companies,
  documents,
  issueApprovals,
  issueDocuments,
  issues,
  projects,
  stewardInboxActionHandles,
} from "@paperclipai/db";
import {
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  isSystemIssueDocumentKey,
  issueDocumentFormatSchema,
  issueDocumentKeySchema,
  type RespondIssueThreadInteraction,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { insertActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import {
  answersThatDifferFromRecommendation,
  normalizeLessons,
  recommendedOption,
  personDisplayName,
  agentDisplayName,
  recordAgentCorrectionGuarded,
  sendBackSummary,
} from "./agent-corrections.js";
import { approvalAuthorityService } from "./approval-authority.js";
import { approvalDecisionEffectsService, type DecisionWake } from "./approval-decision-effects.js";
import { applyDeliverableReviewAfterDocumentRevision } from "./deliverable-review-revision.js";
import { documentService } from "./documents.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import type { heartbeatService } from "./heartbeat.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { approvalService } from "./index.js";
import { issueReferenceService } from "./issue-references.js";
import { continuationWakesAssignee } from "./issue-interaction-continuation.js";
import { IssueCommentPolicyRefusal, issueCommentActions } from "./issue-mutation-actions.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { toCanonicalAnswer } from "./steward-inbox-answers.js";
import {
  DECIDABLE_STATUSES,
  frameUntrustedText,
  optionAlias,
  questionAlias,
  resolveAddressedQuestion,
  type StoredQuestionPayload,
} from "./steward-inbox.js";
import { stewardWorkService, type WorkOwner, type WorkRefusal } from "./steward-work.js";
import type { StorageService } from "../storage/types.js";
import { normalizeIssueAttachmentMaxBytes } from "../attachment-types.js";
import { nextVersionsFor, splitVersionedName } from "./attachment-versions.js";
import {
  attachStagedFiles,
  describeStagedFile,
  filesLeftOutReason,
  filesNotUploadedRefusal,
  missingUploads,
  plannedVersions,
  StagedFileRefusal,
  storedNameFor,
  validateBridgeFiles,
  type StagedFileSpec,
} from "./bridge-staged-files.js";

/**
 * AgentDash-MK: the person's own Claude as co-worker -- the send-back.
 *
 * After the person's session has reviewed an agent's hand-off and finished the
 * work with them, this sends back what the person approved, as the person, in
 * one bundle: an answer to the agent's question, a decision on an approval, a
 * new revision of a document, a comment, and the lessons the person wants the
 * agent to keep, and files (co-worker slice 5: only on issues in projects
 * with restricted access, D2; elsewhere the read-back leaves them out and
 * says why). A file's bytes arrive between propose and confirm through
 * `work/upload` against this handle (bridge-staged-files.ts); confirm
 * refuses until every named file has arrived, then attaches them as the
 * person, versioned with their name.
 *
 * The same two steps as every other inbox write, for the same reason: the
 * endpoint credential is never a write credential.
 *
 *   1. **propose** -- validate every part against the issue as it stands,
 *      resolve the question aliases, and mint a single-use `reply` handle over
 *      the exact bundle. Returns the read-back the person says "yes" to, and
 *      who will see it. Nothing is written.
 *   2. **confirm** -- spend the handle and apply the bundle in ONE transaction
 *      as the person, through the services the web page uses, re-checking
 *      that the issue is still theirs, the question still open, the approval
 *      still at the revision read back and the document still at the
 *      revision the bundle was built on. Anything stale refuses the whole
 *      bundle; a spent handle refuses. Every activity row carries
 *      `channel: "bridge_work"`, the endpoint and its label, and the same
 *      `replyId`, so the bundle reads as one group. The agent is woken at
 *      most once.
 *
 * A decision is written in that transaction (the approval row, through the
 * approval service with the revision pinned). Its effects that reach outside
 * the database -- a connector send, a bridge task release, the requester's
 * wake -- run after the commit through the same decision path the inbox
 * uses. When the requester is the agent the bundle wakes, the decision rides
 * in the bundle's one wake instead of a second one.
 *
 * Who is woken follows the web page's rules: a comment or a document revision
 * wakes the assignee; an answer wakes it only when the question's
 * continuation policy says so; a decision wakes its requester.
 *
 * Refusals a person can hit answer `{ ok: false, code, reason }` and write
 * nothing.
 */

export const STEWARD_WORK_REPLY_KIND = "reply";
/** Who a sent file is credited to when the person has no name on record. */
const FILE_AUTHOR_FALLBACK = "person";
export const BRIDGE_WORK_CHANNEL = "bridge_work";

/** Long enough to read a bundle back and decide; short enough to be worthless if it leaks. */
const REPLY_HANDLE_TTL_MS = 30 * 60 * 1000;

export const REPLY_LIMITS = {
  commentChars: 20_000,
  noteChars: 2_000,
  documentChars: 524_288,
  documentTitleChars: 200,
  changeSummaryChars: 500,
  lessons: 5,
  lessonChars: 300,
} as const;

type StoredReply = {
  issueId: string;
  identifier: string | null;
  answer?: { interactionId: string; body: RespondIssueThreadInteraction };
  decision?: {
    approvalId: string;
    revision: number;
    decision: "approved" | "rejected";
    note: string | null;
    title: string | null;
  };
  document?: {
    key: string;
    title: string | null;
    format: string;
    body: string;
    changeSummary: string | null;
    baseRevisionId: string | null;
  };
  comment?: string;
  lessons: string[];
  /** Named by sha256 and size; the bytes are staged against this handle. */
  files?: StagedFileSpec[];
};

export interface ReplyRequest {
  issueId?: unknown;
  answer?: unknown;
  decision?: unknown;
  document?: unknown;
  comment?: unknown;
  lessons?: unknown;
  files?: unknown;
}

function refusal(code: string, reason: string): WorkRefusal {
  return { ok: false, code, reason };
}

/** Thrown inside the confirm transaction so everything rolls back. */
class ReplyRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function words(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** The heartbeat surface the send-back needs: one wake. */
type Wakeup = Pick<ReturnType<typeof heartbeatService>, "wakeup">;

export function stewardWorkReplyService(
  db: Db,
  options: {
    heartbeat: Wakeup;
    storage?: StorageService;
    pluginWorkerManager?: PluginWorkerManager;
    autoDispatchQueuedRuns?: boolean;
  },
) {
  const work = stewardWorkService(db, { storage: options.storage });
  const authority = approvalAuthorityService(db);
  const effects = approvalDecisionEffectsService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
    autoDispatchQueuedRuns: options.autoDispatchQueuedRuns,
  });

  /** Who sees what is sent: the issue's audience, said plainly. */
  async function audienceFor(issue: { projectId: string | null; identifier: string | null }) {
    const ref = issue.identifier ?? "this issue";
    const project = issue.projectId
      ? await db
          .select({ name: projects.name, visibility: projects.visibility })
          .from(projects)
          .where(eq(projects.id, issue.projectId))
          .then((rows) => rows[0] ?? null)
      : null;
    if (project?.visibility === "restricted") {
      return `Everyone on the access list of the restricted project "${frameUntrustedText(project.name, 120)}" (and its agents) will see these on ${ref}.`;
    }
    return `Everyone in the company who can see ${ref} will see these.`;
  }

  /** The decision authority check, as the person, against the revision read back. */
  async function checkDecisionAuthority(
    owner: WorkOwner,
    approval: typeof approvals.$inferSelect,
    revision: number,
    idempotencyKey: string,
  ) {
    return authority.requireDecisionAuthority(
      approval,
      { userId: owner.userId, source: "session", isInstanceAdmin: false, type: "board" } as never,
      { revision, idempotencyKey, channel: BRIDGE_WORK_CHANNEL } as never,
    );
  }

  async function linkedDecidableApproval(issueId: string, approvalId: string) {
    const row = await db
      .select({ approval: approvals })
      .from(issueApprovals)
      .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
      .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)))
      .then((rows) => rows[0]?.approval ?? null);
    return row;
  }

  // -------------------------------------------------------------------------
  // propose
  // -------------------------------------------------------------------------

  async function propose(endpointId: string, request: ReplyRequest) {
    const owner = await work.resolveOwner(endpointId);
    if (work.isRefusal(owner)) return owner;
    const issue = await work.findWorkIssue(owner, request.issueId);
    const ref = issue.identifier ?? issue.id;

    // -- files: checked first, so a bad list proposes nothing ------------------
    const companyCap = await db
      .select({ attachmentMaxBytes: companies.attachmentMaxBytes })
      .from(companies)
      .where(eq(companies.id, owner.companyId))
      .then((rows) => normalizeIssueAttachmentMaxBytes(rows[0]?.attachmentMaxBytes));
    const checkedFiles = validateBridgeFiles(request.files, companyCap);
    if (!checkedFiles.ok) return checkedFiles;
    const restricted = await projectIsRestricted(db, issue.projectId);
    // D2: files travel only on issues in restricted projects; elsewhere they
    // are left out and the read-back says why.
    const filesLeftOut =
      checkedFiles.files.length > 0 && !restricted
        ? filesLeftOutReason(`${ref} is not in a project with restricted access`, checkedFiles.files)
        : null;

    const stored: StoredReply = { issueId: issue.id, identifier: issue.identifier, lessons: [] };
    const readback: string[] = [];
    // For the wake line: the same rules confirm applies.
    let answerWakes = false;
    let decisionRequesterId: string | null = null;

    // -- answer ---------------------------------------------------------------
    if (request.answer !== undefined && request.answer !== null) {
      const answer = request.answer as Record<string, unknown>;
      const interactionId = typeof answer?.interactionId === "string" ? answer.interactionId.trim() : "";
      if (!interactionId) {
        return refusal("invalid_answer", "answer needs the question's interactionId (from inbox_sync).");
      }
      const addressed = await resolveAddressedQuestion(db, { companyId: owner.companyId, userId: owner.userId }, interactionId);
      if (!addressed.ok) return refusal("question_not_open", addressed.reason);
      if (addressed.issue.id !== issue.id) {
        return refusal("question_elsewhere", `That question is on ${addressed.issue.identifier ?? "another issue"}, not ${ref}.`);
      }
      const mapped = toCanonicalAnswer(addressed.payload, {
        ...(typeof answer.optionId === "string" ? { optionId: answer.optionId } : {}),
        ...(Array.isArray(answer.optionIds)
          ? { optionIds: answer.optionIds.filter((value): value is string => typeof value === "string") }
          : {}),
        ...(typeof answer.text === "string" ? { text: answer.text } : {}),
        ...(Array.isArray(answer.answers)
          ? {
              answers: answer.answers
                .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object")
                .map((value) => ({
                  questionId: typeof value.questionId === "string" ? value.questionId : "",
                  optionIds: Array.isArray(value.optionIds)
                    ? value.optionIds.filter((id): id is string => typeof id === "string")
                    : [],
                  ...(typeof value.text === "string" ? { text: value.text } : {}),
                })),
            }
          : {}),
      });
      if (!mapped.ok) return refusal("invalid_answer", mapped.reason);
      stored.answer = { interactionId, body: mapped.body };
      answerWakes = continuationWakesAssignee({ continuationPolicy: addressed.interaction.continuationPolicy, status: "answered" });
      readback.push(...describeAnswer(addressed.payload, mapped.body));
    }

    // -- decision -------------------------------------------------------------
    if (request.decision !== undefined && request.decision !== null) {
      const decision = request.decision as Record<string, unknown>;
      const approvalId = typeof decision?.approvalId === "string" ? decision.approvalId.trim() : "";
      const verb = decision?.decision;
      if (!approvalId || (verb !== "approve" && verb !== "reject")) {
        return refusal("invalid_decision", 'decision needs approvalId and decision: "approve" or "reject".');
      }
      const note = typeof decision.note === "string" && decision.note.trim() ? decision.note.trim() : null;
      if (note && note.length > REPLY_LIMITS.noteChars) {
        return refusal("note_too_long", `Keep the decision note under ${REPLY_LIMITS.noteChars.toLocaleString("en-US")} characters.`);
      }
      const approval = /^[0-9a-f-]{36}$/i.test(approvalId) ? await linkedDecidableApproval(issue.id, approvalId) : null;
      if (!approval || approval.companyId !== owner.companyId) {
        return refusal("no_such_approval", `There is no approval with that id on ${ref}.`);
      }
      if (!DECIDABLE_STATUSES.has(approval.status)) {
        return refusal("approval_settled", `That approval is already ${approval.status}; there is nothing to decide.`);
      }
      try {
        await checkDecisionAuthority(owner, approval, approval.revision, `bridge-work-propose-${approval.id}`);
      } catch {
        return refusal("not_yours_to_decide", "You are not the person who decides that approval, so it cannot be part of your send-back.");
      }
      const title = typeof (approval.payload as { title?: unknown } | null)?.title === "string"
        ? frameUntrustedText((approval.payload as { title: string }).title, 160)
        : null;
      stored.decision = {
        approvalId: approval.id,
        revision: approval.revision,
        decision: verb === "approve" ? "approved" : "rejected",
        note,
        title,
      };
      decisionRequesterId = approval.requestedByAgentId ?? null;
      readback.push(
        `decision ${verb === "approve" ? "approve" : "reject"} ${title ? `"${title}"` : `the ${approval.type} approval`} (revision ${approval.revision})${note ? `, note: "${note}"` : ""}`,
      );
    }

    // -- document -------------------------------------------------------------
    if (request.document !== undefined && request.document !== null) {
      const document = request.document as Record<string, unknown>;
      const keyParsed = issueDocumentKeySchema.safeParse(typeof document?.key === "string" ? document.key.trim().toLowerCase() : "");
      if (!keyParsed.success) return refusal("invalid_document", "document needs a valid key (lowercase letters, digits, - or _).");
      const key = keyParsed.data;
      if (isSystemIssueDocumentKey(key)) {
        return refusal("system_document", `"${key}" is a system document; it is not written from the bridge.`);
      }
      if (typeof document.body !== "string" || !document.body.trim()) {
        return refusal("invalid_document", "document needs a body.");
      }
      if (document.body.length > REPLY_LIMITS.documentChars) {
        return refusal("document_too_long", `The document is over ${REPLY_LIMITS.documentChars.toLocaleString("en-US")} characters.`);
      }
      const formatParsed = issueDocumentFormatSchema.safeParse(document.format ?? "markdown");
      if (!formatParsed.success) return refusal("invalid_document", "document format must be markdown.");
      const title = typeof document.title === "string" && document.title.trim() ? document.title.trim().slice(0, REPLY_LIMITS.documentTitleChars) : null;
      const changeSummary =
        typeof document.changeSummary === "string" && document.changeSummary.trim()
          ? document.changeSummary.trim().slice(0, REPLY_LIMITS.changeSummaryChars)
          : null;
      const baseRevisionId =
        typeof document.baseRevisionId === "string" && document.baseRevisionId.trim() ? document.baseRevisionId.trim() : null;
      const current = await currentDocument(db, issue.id, key);
      if (current) {
        if (!baseRevisionId) {
          return refusal(
            "base_revision_required",
            `"${key}" already exists (revision ${current.revisionNumber}). Pass its revisionId from work_read as baseRevisionId, so nothing written since you read it is overwritten.`,
          );
        }
        if (baseRevisionId !== current.revisionId) {
          return refusal(
            "document_moved_on",
            `"${key}" moved on since you read it: it is now at revision ${current.revisionNumber}. Read it again with work_read and rebuild the revision on it.`,
          );
        }
        if (current.body === document.body && (title ?? current.title) === current.title) {
          return refusal("document_unchanged", `The document is the same as revision ${current.revisionNumber}; there is nothing to send for it.`);
        }
      } else if (baseRevisionId) {
        return refusal("no_such_document", `There is no document "${key}" on ${ref} to revise. Leave baseRevisionId out to create it.`);
      }
      stored.document = {
        key,
        title: title ?? current?.title ?? null,
        format: formatParsed.data,
        body: document.body,
        changeSummary,
        baseRevisionId: current ? baseRevisionId : null,
      };
      readback.push(
        current
          ? `document "${key}" -> new revision ${current.revisionNumber + 1} on top of revision ${current.revisionNumber} (${words(document.body)} words, ${document.body.length} characters)${changeSummary ? `: "${changeSummary}"` : ""}`
          : `document "${key}" -> created (${words(document.body)} words, ${document.body.length} characters)${changeSummary ? `: "${changeSummary}"` : ""}`,
      );
    }

    // -- comment --------------------------------------------------------------
    if (request.comment !== undefined && request.comment !== null) {
      if (typeof request.comment !== "string") return refusal("invalid_comment", "comment must be text.");
      const comment = request.comment.trim();
      if (comment) {
        if (comment.length > REPLY_LIMITS.commentChars) {
          return refusal("comment_too_long", `Keep the comment under ${REPLY_LIMITS.commentChars.toLocaleString("en-US")} characters, or put the long part in the document.`);
        }
        stored.comment = comment;
        readback.push(`comment "${comment}"`);
      }
    }

    // -- lessons --------------------------------------------------------------
    if (request.lessons !== undefined && request.lessons !== null) {
      if (!Array.isArray(request.lessons) || request.lessons.some((lesson) => typeof lesson !== "string")) {
        return refusal("invalid_lessons", "lessons must be a list of short sentences.");
      }
      const given = (request.lessons as string[]).map((lesson) => lesson.trim()).filter(Boolean);
      if (given.length > REPLY_LIMITS.lessons) {
        return refusal("too_many_lessons", `Keep it to ${REPLY_LIMITS.lessons} lessons or fewer; two or three is best.`);
      }
      if (given.some((lesson) => lesson.length > REPLY_LIMITS.lessonChars)) {
        return refusal("lesson_too_long", `Keep each lesson under ${REPLY_LIMITS.lessonChars} characters: one plain sentence.`);
      }
      stored.lessons = normalizeLessons(given);
    }

    // -- files -----------------------------------------------------------------
    if (checkedFiles.files.length > 0 && !filesLeftOut) {
      const personName = await personDisplayName(db, owner.userId, FILE_AUTHOR_FALLBACK);
      const next = await nextVersionsFor(
        db,
        issue.id,
        checkedFiles.files.map((file) => splitVersionedName(file.name).baseKey),
      );
      // The handle binds the version read back; the confirm refuses if it moved on.
      stored.files = plannedVersions(checkedFiles.files, next);
      for (const file of stored.files) {
        readback.push(describeStagedFile(file, storedNameFor(file, file.version ?? 1, personName)));
      }
    }

    if (!stored.answer && !stored.decision && !stored.document && !stored.comment && !stored.files?.length) {
      return refusal(
        "empty_reply",
        filesLeftOut
          ? `Nothing to send. ${filesLeftOut}`
          : "Nothing to send: give an answer, a decision, a document revision, a comment or files (lessons go with one of those).",
      );
    }

    // Agent names are free text: flattened to one line, so a name cannot add
    // lines to the read-back the person says yes to.
    const agentName = issue.assigneeAgentId
      ? frameUntrustedText(owner.agentNameById.get(issue.assigneeAgentId), 80)
      : null;
    const assigneeWoken =
      Boolean(issue.assigneeAgentId) &&
      (Boolean(stored.document) ||
        Boolean(stored.comment) ||
        Boolean(stored.files?.length) ||
        answerWakes ||
        (Boolean(stored.decision) && decisionRequesterId === issue.assigneeAgentId));
    if (stored.lessons.length > 0) {
      readback.push(
        `lessons for ${agentName ?? "the agent"} (it saves them to its own memory, which you and your company's members can read):`,
        ...stored.lessons.map((lesson) => `  - ${lesson}`),
      );
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + REPLY_HANDLE_TTL_MS);
    await db.insert(stewardInboxActionHandles).values({
      token,
      companyId: owner.companyId,
      bridgeEndpointId: endpointId,
      actorUserId: owner.userId,
      kind: STEWARD_WORK_REPLY_KIND,
      payload: stored as unknown as Record<string, unknown>,
      expiresAt,
    });

    return {
      ok: true as const,
      handle: token,
      expiresAt: expiresAt.toISOString(),
      issueId: issue.id,
      identifier: issue.identifier,
      readback: [
        `Send back to ${agentName ?? "the agent"} on ${ref}, as you, via bridge (${frameUntrustedText(owner.endpoint.label, 60) ?? "this machine"}):`,
        ...readback.map((line) => (line.startsWith("  ") ? line : `  ${line}`)),
      ],
      audience: await audienceFor(issue),
      ...(filesLeftOut ? { filesLeftOut } : {}),
      ...(stored.files?.length
        ? {
            upload: {
              files: stored.files.map((file) => ({ name: file.name, sha256: file.sha256, size: file.size })),
              note: "After the person's yes, upload each named file with this handle (work/upload), then confirm. Nothing is attached until the confirm.",
            },
          }
        : {}),
      wakes: describeWake({
        agentName,
        assigned: Boolean(issue.assigneeAgentId),
        assigneeWoken,
        quietAnswer: Boolean(stored.answer) && !answerWakes,
        decisionWakesAnother: Boolean(stored.decision) && decisionRequesterId !== null && decisionRequesterId !== issue.assigneeAgentId,
      }),
      confirmWith: "work_confirm_reply with this handle, only after the person's explicit yes to this exact read-back.",
    };
  }

  // -------------------------------------------------------------------------
  // confirm
  // -------------------------------------------------------------------------

  async function confirm(endpointId: string, token: string) {
    const owner = await work.resolveOwner(endpointId);
    if (work.isRefusal(owner)) return owner;
    const spentOrGone = refusal(
      "handle_not_valid",
      "This send-back handle was already used, has expired, or belongs to another machine. Nothing was sent; propose it again.",
    );

    // Read, not spent: the authority checks below must run as the person
    // before anything is written. The spend is inside the transaction.
    const record = await db
      .select()
      .from(stewardInboxActionHandles)
      .where(
        and(
          eq(stewardInboxActionHandles.token, token),
          eq(stewardInboxActionHandles.bridgeEndpointId, endpointId),
          eq(stewardInboxActionHandles.kind, STEWARD_WORK_REPLY_KIND),
          isNull(stewardInboxActionHandles.consumedAt),
          gt(stewardInboxActionHandles.expiresAt, new Date()),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!record || record.companyId !== owner.companyId || record.actorUserId !== owner.userId) return spentOrGone;
    const stored = record.payload as unknown as StoredReply;

    // Still the person's work, still on their page: 404 inside findWorkIssue.
    let issue;
    try {
      issue = await work.findWorkIssue(owner, stored.issueId);
    } catch {
      return refusal(
        "no_longer_yours",
        `${stored.identifier ?? "That issue"} is no longer yours to act on from here (reassigned, hidden or moved out of your view). Nothing was sent.`,
      );
    }

    // The decision's authority, now, against the revision read back.
    let approvalRow: typeof approvals.$inferSelect | null = null;
    let decisionMeta: { revision: number; channel: string; idempotencyKey: string | null; actorRole: string } | null = null;
    if (stored.decision) {
      approvalRow = await linkedDecidableApproval(issue.id, stored.decision.approvalId);
      if (!approvalRow || !DECIDABLE_STATUSES.has(approvalRow.status)) {
        return refusal("approval_settled", `That approval was already ${approvalRow?.status ?? "removed"}. Nothing was sent; propose again without it.`);
      }
      try {
        const context = await checkDecisionAuthority(owner, approvalRow, stored.decision.revision, `bridge-work-${record.id}`);
        decisionMeta = {
          revision: context.revision,
          channel: context.channel,
          idempotencyKey: context.idempotencyKey,
          actorRole: context.role,
        };
      } catch (err) {
        const status = (err as { status?: number }).status;
        return refusal(
          status === 409 ? "approval_changed" : "not_yours_to_decide",
          status === 409
            ? "That approval changed since the read-back. Nothing was sent; read it again and propose again."
            : "You are no longer the person who decides that approval. Nothing was sent.",
        );
      }
    }

    // Every file the read-back named must have arrived before anything is sent.
    if (stored.files?.length) {
      const missing = await missingUploads(db, record.id, stored.files);
      if (missing.length > 0) return filesNotUploadedRefusal(missing);
    }

    const personName = await personDisplayName(db, owner.userId, "Your steward");
    const endpointLabel = owner.endpoint.label;
    const provenance = {
      channel: BRIDGE_WORK_CHANNEL,
      via: "bridge",
      bridgeEndpointId: endpointId,
      bridgeEndpointLabel: endpointLabel,
      replyId: record.id,
    };
    const publications: ActivityPublication[] = [];
    const heartbeatNoop = {
      cancelRun: async () => null,
      wakeup: async () => null,
      reportRunActivity: async () => undefined,
    } as unknown as Parameters<typeof issueCommentActions>[1];

    type Applied = {
      assigneeAgentId: string | null;
      status: string;
      reopened: boolean;
      commentId: string | null;
      mentionedIds: string[];
      interactionId: string | null;
      /** The answered question's continuation policy wakes the assignee. */
      answerWakes: boolean;
      document: { id: string; key: string; latestRevisionId: string | null; latestRevisionNumber: number } | null;
      /** The decision as written in the transaction; its outside effects run after. */
      decision: { approval: typeof approvals.$inferSelect } | null;
      files: Array<{ attachmentId: string; name: string | null; version: number | null }>;
    };

    let applied: Applied;
    try {
      applied = await db.transaction(async (txRaw): Promise<Applied> => {
        const tx = txRaw as unknown as Db;
        // Hold the endpoint, so a revocation lands before the bundle or after it.
        const live = await tx
          .select({ id: bridgeEndpoints.id })
          .from(bridgeEndpoints)
          .where(and(eq(bridgeEndpoints.id, endpointId), isNull(bridgeEndpoints.revokedAt)))
          .for("share")
          .then((rows) => rows[0] ?? null);
        if (!live) throw new ReplyRefused("endpoint_revoked", "This machine's connection was revoked. Nothing was sent.");

        const now = new Date();
        const spent = await tx
          .update(stewardInboxActionHandles)
          .set({ consumedAt: now })
          .where(
            and(
              eq(stewardInboxActionHandles.id, record.id),
              isNull(stewardInboxActionHandles.consumedAt),
              gt(stewardInboxActionHandles.expiresAt, now),
            ),
          )
          .returning({ id: stewardInboxActionHandles.id })
          .then((rows) => rows[0] ?? null);
        if (!spent) throw new ReplyRefused(spentOrGone.code, spentOrGone.reason);

        // Company, then issue: the order every issue write in this codebase takes.
        await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, owner.companyId)).for("no key update");
        const locked = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.id, issue.id), eq(issues.companyId, owner.companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        const stillOwners =
          locked &&
          !locked.hiddenAt &&
          ((locked.assigneeAgentId && owner.agentIds.includes(locked.assigneeAgentId)) ||
            (locked.assigneeUserId && locked.assigneeUserId === owner.userId));
        if (!locked || !stillOwners) {
          throw new ReplyRefused("no_longer_yours", `${stored.identifier ?? "That issue"} is no longer yours to act on from here. Nothing was sent.`);
        }
        const agentId = locked.assigneeAgentId;

        // -- document: the stale check is the whole bundle's ----------------
        let documentResult: Applied["document"] = null;
        let documentBefore: { body: string; revisionNumber: number; authorLabel: string } | null = null;
        if (stored.document) {
          const current = await currentDocument(tx, issue.id, stored.document.key);
          const base = stored.document.baseRevisionId;
          if ((current && current.revisionId !== base) || (!current && base)) {
            throw new ReplyRefused(
              "document_moved_on",
              `"${stored.document.key}" moved on since the read-back${current ? ` (now revision ${current.revisionNumber})` : ""}. Nothing was sent; read it again and propose again.`,
            );
          }
          if (current) {
            documentBefore = {
              body: current.body,
              revisionNumber: current.revisionNumber,
              authorLabel: current.updatedByAgentId
                ? current.updatedByAgentId === agentId
                  ? "you"
                  : await agentDisplayName(tx, current.updatedByAgentId)
                : current.updatedByUserId
                  ? await personDisplayName(tx, current.updatedByUserId)
                  : "unknown",
            };
          }
          const result = await documentService(tx)
            .upsertIssueDocument({
              issueId: issue.id,
              key: stored.document.key,
              title: stored.document.title,
              format: stored.document.format,
              body: stored.document.body,
              changeSummary: stored.document.changeSummary,
              baseRevisionId: base,
              createdByUserId: owner.userId,
            })
            .catch((err: unknown) => {
              if ((err as { status?: number }).status === 409) {
                throw new ReplyRefused("document_moved_on", `"${stored.document!.key}" moved on since the read-back. Nothing was sent; read it again and propose again.`);
              }
              throw err;
            });
          const doc = result.document;
          await issueReferenceService(tx).syncDocument(doc.id, tx);
          publications.push(
            await insertActivity(tx, {
              companyId: owner.companyId,
              actorType: "user",
              actorId: owner.userId,
              action: result.created ? "issue.document_created" : "issue.document_updated",
              entityType: "issue",
              entityId: issue.id,
              details: {
                key: doc.key,
                documentId: doc.id,
                title: doc.title,
                format: doc.format,
                revisionNumber: doc.latestRevisionNumber,
                ...provenance,
              },
            }),
          );
          if (!result.created) {
            const expired = await issueThreadInteractionService(tx).expireStaleRequestConfirmationsForIssueDocument(
              locked,
              { id: doc.id, key: doc.key, latestRevisionId: doc.latestRevisionId, latestRevisionNumber: doc.latestRevisionNumber },
              { agentId: null, userId: owner.userId },
              { executor: tx, publications },
            );
            for (const interaction of expired) {
              publications.push(
                await insertActivity(tx, {
                  companyId: owner.companyId,
                  actorType: "user",
                  actorId: owner.userId,
                  action: "issue.thread_interaction_expired",
                  entityType: "issue",
                  entityId: issue.id,
                  details: {
                    identifier: locked.identifier,
                    interactionId: interaction.id,
                    interactionKind: interaction.kind,
                    interactionStatus: interaction.status,
                    source: "issue.document_updated",
                    ...provenance,
                  },
                }),
              );
            }
          }
          documentResult = {
            id: doc.id,
            key: doc.key,
            latestRevisionId: doc.latestRevisionId,
            latestRevisionNumber: doc.latestRevisionNumber,
          };
        }

        // -- answer ----------------------------------------------------------
        let interactionId: string | null = null;
        let answerDifferences: ReturnType<typeof answersThatDifferFromRecommendation> = [];
        let answeredWithRecommendation = false;
        let answerWakes = false;
        if (stored.answer) {
          const addressed = await resolveAddressedQuestion(tx, { companyId: owner.companyId, userId: owner.userId }, stored.answer.interactionId);
          if (!addressed.ok || addressed.issue.id !== issue.id) {
            throw new ReplyRefused("question_not_open", `${addressed.ok ? "That question moved to another issue." : addressed.reason} Nothing was sent.`);
          }
          const updated = await issueThreadInteractionService(tx).answerQuestions(
            { id: issue.id, companyId: owner.companyId },
            stored.answer.interactionId,
            stored.answer.body,
            { userId: owner.userId },
            { executor: tx, publications },
          );
          publications.push(
            await insertActivity(tx, {
              companyId: owner.companyId,
              actorType: "user",
              actorId: owner.userId,
              action: "issue.thread_interaction_answered",
              entityType: "issue",
              entityId: issue.id,
              details: {
                interactionId: updated.id,
                interactionKind: updated.kind,
                interactionStatus: updated.status,
                answeredQuestionCount: updated.kind === "ask_user_questions" ? updated.result?.answers?.length ?? 0 : 0,
                ...provenance,
              },
            }),
          );
          interactionId = updated.id;
          answerWakes = continuationWakesAssignee(updated);
          const questions = addressed.payload.questions ?? [];
          const answers = updated.kind === "ask_user_questions" ? updated.result?.answers ?? [] : [];
          answerDifferences = answersThatDifferFromRecommendation(questions, answers);
          answeredWithRecommendation =
            answerDifferences.length === 0 && questions.some((question) => recommendedOption(question) !== null);
        }

        // -- comment ---------------------------------------------------------
        let commentId: string | null = null;
        let reopened = false;
        let mentionedIds: string[] = [];
        let afterStatus = locked.status;
        if (stored.comment) {
          try {
            const accepted = await issueCommentActions(tx, heartbeatNoop).accept({
              issueId: issue.id,
              companyId: owner.companyId,
              actor: { actorType: "user", actorId: owner.userId, agentId: null, runId: null },
              actorKind: "board",
              attribution: provenance,
              intent: { body: stored.comment },
              validate: async (executor, current) => {
                const workspace = current.executionWorkspaceId
                  ? await executionWorkspaceService(executor as Db).getById(current.executionWorkspaceId)
                  : null;
                if (workspace && isClosedIsolatedExecutionWorkspace(workspace)) {
                  throw new IssueCommentPolicyRefusal(409, { error: getClosedIsolatedExecutionWorkspaceMessage(workspace) });
                }
              },
            });
            publications.push(...accepted.publications);
            commentId = accepted.comment.id;
            reopened = accepted.plan.reopened;
            mentionedIds = accepted.plan.mentionedIds;
            afterStatus = accepted.currentIssue.status;
          } catch (err) {
            if (err instanceof IssueCommentPolicyRefusal) {
              throw new ReplyRefused("comment_refused", `${err.message} Nothing was sent.`);
            }
            throw err;
          }
        }

        // -- decision: the approval row, in this transaction -------------------
        // Pinned to the revision read back, so an approval that changed or
        // was decided since refuses the whole bundle. Its effects outside the
        // database run after the commit.
        let decided: Applied["decision"] = null;
        if (stored.decision && approvalRow && decisionMeta) {
          const decisionSvc = approvalService(tx);
          const result = await (
            stored.decision.decision === "approved"
              ? decisionSvc.approve(approvalRow.id, owner.userId, stored.decision.note, decisionMeta as never)
              : decisionSvc.reject(approvalRow.id, owner.userId, stored.decision.note, decisionMeta as never)
          ).catch((err: unknown) => {
            const status = (err as { status?: number }).status;
            if (status === 409) {
              throw new ReplyRefused(
                "approval_changed",
                "That approval changed or was decided since the read-back. Nothing was sent; read it again and propose again.",
              );
            }
            if (status === 422) {
              throw new ReplyRefused("decision_refused", `${String((err as Error).message).replace(/\.$/, "")}. Nothing was sent.`);
            }
            throw err;
          });
          if (!result.applied) {
            throw new ReplyRefused(
              "approval_settled",
              `That approval was already ${result.approval.status} by the time this was sent. Nothing was sent; propose again without it.`,
            );
          }
          decided = { approval: result.approval };
        }

        // -- files: still a restricted project, still within the cap ----------
        let attachedFiles: Applied["files"] = [];
        if (stored.files?.length) {
          if (!(await projectIsRestricted(tx, locked.projectId))) {
            throw new ReplyRefused(
              "files_not_allowed_now",
              `${locked.identifier ?? "The issue"} is no longer in a project with restricted access, so its files cannot travel over the bridge. Nothing was sent; propose again without them.`,
            );
          }
          const cap = await tx
            .select({ attachmentMaxBytes: companies.attachmentMaxBytes })
            .from(companies)
            .where(eq(companies.id, owner.companyId))
            .then((rows) => normalizeIssueAttachmentMaxBytes(rows[0]?.attachmentMaxBytes));
          const over = stored.files.find((file) => file.size > cap);
          if (over) {
            throw new ReplyRefused(
              "file_too_large",
              `"${over.name}" is ${over.size.toLocaleString("en-US")} bytes; the cap for this company is now ${cap.toLocaleString("en-US")} bytes. Nothing was sent.`,
            );
          }
          const attached = await attachStagedFiles(tx, {
            companyId: owner.companyId,
            issueId: issue.id,
            handleId: record.id,
            files: stored.files,
            userId: owner.userId,
            // The same name the read-back showed the files stored under.
            personName: await personDisplayName(tx, owner.userId, FILE_AUTHOR_FALLBACK),
            issueCommentId: commentId,
          });
          for (const attachment of attached) {
            publications.push(
              await insertActivity(tx, {
                companyId: owner.companyId,
                actorType: "user",
                actorId: owner.userId,
                action: "issue.attachment_added",
                entityType: "issue",
                entityId: issue.id,
                details: {
                  attachmentId: attachment.id,
                  originalFilename: attachment.originalFilename,
                  contentType: attachment.contentType,
                  byteSize: attachment.byteSize,
                  version: attachment.version,
                  ...provenance,
                },
              }),
            );
          }
          attachedFiles = attached.map((attachment) => ({
            attachmentId: attachment.id,
            name: attachment.originalFilename,
            version: attachment.version,
          }));
        }

        // -- what changed, for the agent's next wake --------------------------
        // A decision on its own leaves only its own correction (a rejection
        // records approval_rejected); lessons always go with one. Guarded: a
        // fault here is logged and never fails the person's send-back.
        const onlyDecision = !stored.answer && !stored.document && !stored.comment && attachedFiles.length === 0;
        if (agentId && !(onlyDecision && stored.lessons.length === 0)) {
          await recordAgentCorrectionGuarded(tx, owner.companyId, async () => ({
            companyId: owner.companyId,
            agentId,
            issueId: issue.id,
            kind: "steward_send_back",
            summary: sendBackSummary({
              personName,
              identifier: locked.identifier,
              endpointLabel,
              document: stored.document && documentResult
                ? {
                    key: stored.document.key,
                    before: documentBefore,
                    after: { body: stored.document.body, revisionNumber: documentResult.latestRevisionNumber },
                  }
                : null,
              answerDifferences,
              answeredWithRecommendation,
              // A rejection is its own correction (approval_rejected), recorded
              // by the decision path below; an approval is agreement.
              decision: null,
              comment: stored.comment ?? null,
              files: attachedFiles.map((file) => ({ name: file.name ?? "file", version: file.version })),
            }),
            details: {
              lessons: stored.lessons,
              replyId: record.id,
              documentKey: stored.document?.key ?? null,
              answerDifferences,
              attachmentIds: attachedFiles.map((file) => file.attachmentId),
            },
            sourceActorType: "user",
            sourceActorId: owner.userId,
          }));
        }

        // -- the group's own row ---------------------------------------------
        publications.push(
          await insertActivity(tx, {
            companyId: owner.companyId,
            actorType: "user",
            actorId: owner.userId,
            action: "issue.bridge_reply_sent",
            entityType: "issue",
            entityId: issue.id,
            agentId,
            details: {
              identifier: locked.identifier,
              parts: [
                ...(stored.answer ? ["answer"] : []),
                ...(stored.decision ? ["decision"] : []),
                ...(stored.document ? ["document"] : []),
                ...(stored.comment ? ["comment"] : []),
                ...(attachedFiles.length > 0 ? ["files"] : []),
              ],
              lessonCount: stored.lessons.length,
              attachmentIds: attachedFiles.map((file) => file.attachmentId),
              commentId,
              interactionId,
              documentKey: documentResult?.key ?? null,
              revisionNumber: documentResult?.latestRevisionNumber ?? null,
              ...provenance,
            },
          }),
        );

        return {
          assigneeAgentId: agentId,
          status: afterStatus,
          reopened,
          commentId,
          mentionedIds,
          interactionId,
          answerWakes,
          document: documentResult,
          decision: decided,
          files: attachedFiles,
        };
      });
    } catch (err) {
      if (err instanceof ReplyRefused || err instanceof StagedFileRefusal) {
        logger.info({ endpointId, code: err.code }, "bridge send-back refused");
        return refusal(err.code, err.message);
      }
      throw err;
    }

    for (const publication of publications) publishActivity(publication);

    // The document's review step, exactly as the web document route runs it
    // after a revision. A person's own write is recorded as accepted rather
    // than reopening review, so nothing here changes the issue's status.
    if (applied.document) {
      await applyDeliverableReviewAfterDocumentRevision({
        db,
        issue: { id: issue.id, companyId: owner.companyId, identifier: issue.identifier },
        key: applied.document.key,
        latestRevisionId: applied.document.latestRevisionId,
        latestRevisionNumber: applied.document.latestRevisionNumber,
        actor: { actorType: "user", actorId: owner.userId, agentId: null, runId: null, source: BRIDGE_WORK_CHANNEL },
        onIssueStatusChanged: async () => undefined,
      }).catch((err) => logger.warn({ err, issueId: issue.id }, "send-back document review step failed"));
    }

    // Who the bundle wakes, by the web page's rules: a comment or a document
    // revision wakes the assignee; an answer only when its question's
    // continuation policy says so; a decision wakes its requester, and when
    // that is the assignee the decision rides in this one wake.
    const assigneeId = applied.assigneeAgentId;
    const assigneeOpen = Boolean(assigneeId) && applied.status !== "done" && applied.status !== "cancelled";
    const decisionForAssignee = Boolean(applied.decision) && applied.decision!.approval.requestedByAgentId === assigneeId;
    const wakeAssignee =
      assigneeOpen &&
      (Boolean(applied.document) ||
        Boolean(applied.commentId) ||
        applied.files.length > 0 ||
        applied.answerWakes ||
        decisionForAssignee);

    // The decision's effects outside the database, through the inbox's
    // decision path. The decision itself is committed: a fault here is
    // logged, never reported as a decision that did not happen.
    let decisionWake: DecisionWake | null = null;
    if (applied.decision && stored.decision) {
      const context = {
        actorUserId: owner.userId,
        decisionNote: stored.decision.note,
        via: `bridge (${endpointLabel})`,
        wakeRequester: !(wakeAssignee && decisionForAssignee),
      };
      try {
        decisionWake =
          (stored.decision.decision === "approved"
            ? await effects.afterApprove(applied.decision.approval, true, context)
            : await effects.afterReject(applied.decision.approval, true, context)) ?? null;
      } catch (err) {
        logger.error({ err, approvalId: applied.decision.approval.id, endpointId }, "send-back decision effects failed after the decision committed");
      }
    }

    // At most one wake for the assignee, carrying the whole bundle.
    let agentWoken = false;
    if (assigneeId && wakeAssignee) {
      const decisionInWake = decisionForAssignee && applied.decision
        ? {
            approvalId: applied.decision.approval.id,
            approvalStatus: applied.decision.approval.status,
            reason: decisionWake?.reason ?? (stored.decision?.decision === "approved" ? "approval_approved" : "approval_rejected"),
            connectorSend: decisionWake?.connectorSend ?? null,
          }
        : null;
      // A decision riding in the wake names it: it is the news, and the
      // approval_* and connector_send_* reasons get a follow-up even while the
      // issue is running. The wake is the person's own, so a reopen of
      // closed work still happens without the reopen reason.
      const wakeReason = decisionInWake
        ? decisionInWake.reason
        : applied.reopened
          ? "issue_reopened_via_comment"
          : "issue_commented";
      try {
        const run = await options.heartbeat.wakeup(assigneeId, {
          source: "automation",
          triggerDetail: "system",
          reason: wakeReason,
          payload: {
            issueId: issue.id,
            mutation: "bridge_reply",
            ...(applied.commentId ? { commentId: applied.commentId } : {}),
            ...(applied.interactionId ? { interactionId: applied.interactionId } : {}),
            ...(decisionInWake
              ? {
                  approvalId: decisionInWake.approvalId,
                  approvalStatus: decisionInWake.approvalStatus,
                  ...(decisionInWake.connectorSend ? { connectorSend: decisionInWake.connectorSend } : {}),
                }
              : stored.decision
                ? { approvalId: stored.decision.approvalId }
                : {}),
          },
          requestedByActorType: "user",
          requestedByActorId: owner.userId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            ...(applied.commentId ? { commentId: applied.commentId, wakeCommentId: applied.commentId } : {}),
            ...(applied.interactionId ? { interactionId: applied.interactionId } : {}),
            ...(applied.document ? { documentKey: applied.document.key } : {}),
            ...(applied.files.length > 0 ? { attachmentIds: applied.files.map((file) => file.attachmentId) } : {}),
            ...(decisionInWake
              ? {
                  approvalId: decisionInWake.approvalId,
                  approvalStatus: decisionInWake.approvalStatus,
                  ...(decisionInWake.connectorSend
                    ? {
                        connectorSendOutcome: decisionInWake.connectorSend.outcome,
                        connectorSendReason: decisionInWake.connectorSend.reason,
                      }
                    : {}),
                }
              : {}),
            source: "bridge.work.reply",
            wakeReason,
          },
        });
        agentWoken = run != null;
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "send-back wake failed; the agent reads the bundle on its next run");
      }
    }
    // A comment that names another agent wakes it, as on the web page.
    for (const mentionedId of applied.mentionedIds) {
      if (mentionedId === applied.assigneeAgentId) continue;
      await options.heartbeat
        .wakeup(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: issue.id, commentId: applied.commentId },
          requestedByActorType: "user",
          requestedByActorId: owner.userId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            commentId: applied.commentId,
            wakeCommentId: applied.commentId,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id, mentionedId }, "send-back mention wake failed"));
    }

    return {
      ok: true as const,
      issueId: issue.id,
      identifier: issue.identifier,
      sent: {
        ...(stored.answer ? { answer: { interactionId: applied.interactionId } } : {}),
        ...(applied.document
          ? { document: { key: applied.document.key, revisionNumber: applied.document.latestRevisionNumber } }
          : {}),
        ...(applied.commentId ? { comment: { commentId: applied.commentId } } : {}),
        ...(stored.lessons.length > 0 ? { lessons: stored.lessons.length } : {}),
        ...(applied.files.length > 0 ? { files: applied.files } : {}),
        ...(applied.decision && stored.decision ? { decision: stored.decision.decision } : {}),
      },
      agentWoken,
    };
  }

  return { propose, confirm };
}

/** The read-back's wake line: who is woken, and once. */
function describeWake(input: {
  agentName: string | null;
  assigned: boolean;
  assigneeWoken: boolean;
  /** An answer is in the bundle and its question does not wake the agent. */
  quietAnswer: boolean;
  decisionWakesAnother: boolean;
}): string {
  const another = input.decisionWakesAnother ? " The agent that asked for the approval is woken with your decision." : "";
  if (!input.assigned) return `No agent is assigned to this issue.${another || " Nobody is woken."}`;
  const name = input.agentName ?? "The agent";
  if (input.assigneeWoken) return `${name} is woken once with all of this.${another}`;
  const why = input.quietAnswer
    ? "its question was set not to wake it when answered"
    : "a decision on its own wakes only the agent that asked for the approval";
  return `${name} is not woken by this: ${why}. It sees all of this on its next run.${another}`;
}

/** The read-back lines for an answer: which question, which option, as labelled by the agent. */
function describeAnswer(payload: StoredQuestionPayload, body: RespondIssueThreadInteraction): string[] {
  const lines: string[] = [];
  const questions = payload.questions ?? [];
  const answers = (body as { answers?: Array<{ questionId: string; optionIds?: string[]; text?: string }> }).answers ?? [];
  for (const answer of answers) {
    const index = questions.findIndex((question) => question.id === answer.questionId);
    if (index < 0) continue;
    const question = questions[index]!;
    const chosen = (answer.optionIds ?? [])
      .map((id) => {
        const optionIndex = question.options.findIndex((option) => option.id === id);
        return optionIndex < 0
          ? null
          : `${optionAlias(index, optionIndex)} "${frameUntrustedText(question.options[optionIndex]!.label, 120)}"`;
      })
      .filter((value): value is string => Boolean(value));
    const parts = [
      ...(chosen.length > 0 ? [chosen.join(", ")] : []),
      ...(answer.text?.trim() ? [`"${answer.text.trim()}"`] : []),
    ];
    lines.push(`answer ${questionAlias(index)} "${frameUntrustedText(question.prompt, 200)}" -> ${parts.join(", note: ") || "(no option)"}`);
  }
  const summary = (body as { summaryMarkdown?: string | null }).summaryMarkdown;
  if (summary?.trim()) lines.push(`answer note "${summary.trim()}"`);
  return lines;
}

/** Is this project one with restricted access (where files may travel, D2)? */
async function projectIsRestricted(reader: Pick<Db, "select">, projectId: string | null): Promise<boolean> {
  if (!projectId) return false;
  const row = await reader
    .select({ visibility: projects.visibility })
    .from(projects)
    .where(eq(projects.id, projectId))
    .then((rows) => rows[0] ?? null);
  return row?.visibility === "restricted";
}

/** The latest revision of one document on an issue, or null. */
async function currentDocument(reader: Pick<Db, "select">, issueId: string, key: string) {
  return reader
    .select({
      revisionId: documents.latestRevisionId,
      revisionNumber: documents.latestRevisionNumber,
      body: documents.latestBody,
      title: documents.title,
      updatedByAgentId: documents.updatedByAgentId,
      updatedByUserId: documents.updatedByUserId,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
    .then((rows) => rows[0] ?? null);
}
