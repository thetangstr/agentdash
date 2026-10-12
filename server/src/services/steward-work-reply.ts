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
  recordAgentCorrection,
  sendBackSummary,
} from "./agent-corrections.js";
import { approvalAuthorityService } from "./approval-authority.js";
import { approvalDecisionEffectsService } from "./approval-decision-effects.js";
import { applyDeliverableReviewAfterDocumentRevision } from "./deliverable-review-revision.js";
import { documentService } from "./documents.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import type { heartbeatService } from "./heartbeat.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { approvalService } from "./index.js";
import { issueReferenceService } from "./issue-references.js";
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

/**
 * AgentDash-MK: the person's own Claude as co-worker -- the send-back.
 *
 * After the person's session has reviewed an agent's hand-off and finished the
 * work with them, this sends back what the person approved, as the person, in
 * one bundle: an answer to the agent's question, a decision on an approval, a
 * new revision of a document, a comment, and the lessons the person wants the
 * agent to keep. Files are reserved for a later slice and refused here.
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
 *      that the issue is still theirs, the question still open and the
 *      document still at the revision the bundle was built on. A stale
 *      document refuses the whole bundle; a spent handle refuses. Every
 *      activity row carries `channel: "bridge_work"`, the endpoint and its
 *      label, and the same `replyId`, so the bundle reads as one group. The
 *      agent is woken once.
 *
 * A decision is the one part that cannot share the transaction: an approval's
 * effects reach outside the database (a connector send, a bridge task). Its
 * authority is checked before anything is written, and it is applied right
 * after the rest commits through the same decision path the inbox uses; if it
 * is refused at that point the answer says exactly which parts landed.
 *
 * Refusals a person can hit answer `{ ok: false, code, reason }` and write
 * nothing.
 */

export const STEWARD_WORK_REPLY_KIND = "reply";
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
  const approvalsSvc = approvalService(db);
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

    if (request.files !== undefined && request.files !== null) {
      if (!Array.isArray(request.files)) return refusal("invalid_files", "files must be a list.");
      if (request.files.length > 0) {
        return refusal(
          "files_not_supported_yet",
          "Files cannot be sent back through the bridge yet; nothing was proposed. Send the text now and attach the files on the AgentDash page, or wait for file send-back (it will work only on issues in projects with restricted access).",
        );
      }
    }

    const stored: StoredReply = { issueId: issue.id, identifier: issue.identifier, lessons: [] };
    const readback: string[] = [];

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

    if (!stored.answer && !stored.decision && !stored.document && !stored.comment) {
      return refusal(
        "empty_reply",
        "Nothing to send: give an answer, a decision, a document revision or a comment (lessons go with one of those).",
      );
    }

    const agentName = issue.assigneeAgentId ? owner.agentNameById.get(issue.assigneeAgentId) ?? null : null;
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
      wakes: agentName ? `${agentName} is woken once with all of this.` : "No agent is assigned; nobody is woken.",
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
      document: { id: string; key: string; latestRevisionId: string | null; latestRevisionNumber: number } | null;
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

        // -- what changed, for the agent's next wake --------------------------
        if (agentId) {
          await recordAgentCorrection(tx, {
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
            }),
            details: {
              lessons: stored.lessons,
              replyId: record.id,
              documentKey: stored.document?.key ?? null,
              answerDifferences,
            },
            sourceActorType: "user",
            sourceActorId: owner.userId,
          });
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
              ],
              lessonCount: stored.lessons.length,
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
          document: documentResult,
        };
      });
    } catch (err) {
      if (err instanceof ReplyRefused) {
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

    // The decision, through the inbox's decision path, after the rest landed.
    let decisionOutcome: { ok: true; decision: "approved" | "rejected" } | { ok: false; reason: string } | null = null;
    if (stored.decision && approvalRow && decisionMeta) {
      try {
        const result =
          stored.decision.decision === "approved"
            ? await approvalsSvc.approve(approvalRow.id, owner.userId, stored.decision.note, decisionMeta as never)
            : await approvalsSvc.reject(approvalRow.id, owner.userId, stored.decision.note, decisionMeta as never);
        const context = { actorUserId: owner.userId, decisionNote: stored.decision.note, via: `bridge (${endpointLabel})` };
        if (stored.decision.decision === "approved") await effects.afterApprove(result.approval, result.applied, context);
        else await effects.afterReject(result.approval, result.applied, context);
        decisionOutcome = { ok: true, decision: stored.decision.decision };
      } catch (err) {
        logger.warn({ err, approvalId: approvalRow.id, endpointId }, "send-back decision refused after the rest landed");
        decisionOutcome = {
          ok: false,
          reason: "The decision was not applied: the approval changed or was decided between the read-back and the send. Everything else in the bundle was sent.",
        };
      }
    }

    // One wake for the agent, carrying the whole bundle.
    let agentWoken = false;
    if (applied.assigneeAgentId && applied.status !== "done" && applied.status !== "cancelled") {
      const wakeReason = applied.reopened ? "issue_reopened_via_comment" : "issue_commented";
      try {
        const run = await options.heartbeat.wakeup(applied.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: wakeReason,
          payload: {
            issueId: issue.id,
            mutation: "bridge_reply",
            ...(applied.commentId ? { commentId: applied.commentId } : {}),
            ...(applied.interactionId ? { interactionId: applied.interactionId } : {}),
            ...(stored.decision ? { approvalId: stored.decision.approvalId } : {}),
          },
          requestedByActorType: "user",
          requestedByActorId: owner.userId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            ...(applied.commentId ? { commentId: applied.commentId, wakeCommentId: applied.commentId } : {}),
            ...(applied.interactionId ? { interactionId: applied.interactionId } : {}),
            ...(applied.document ? { documentKey: applied.document.key } : {}),
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
        ...(decisionOutcome?.ok ? { decision: decisionOutcome.decision } : {}),
      },
      ...(decisionOutcome && !decisionOutcome.ok ? { notSent: { decision: decisionOutcome.reason } } : {}),
      agentWoken,
    };
  }

  return { propose, confirm };
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
