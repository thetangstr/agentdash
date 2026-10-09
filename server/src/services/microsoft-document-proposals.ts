// AgentDash (per-steward document access, slice 5): an agent ASKS to save a
// proposed copy of a document in its steward's own OneDrive.
//
// Filing is all this does. It makes no Graph call and uses no token: it checks
// the request, resolves the steward's connection through the live stewardship
// (slice 1), binds the request to the exact attachment bytes (sha256), and
// files a `connector_send` approval for the steward. Nothing is written to
// Microsoft until the steward approves, and then only by the executor
// (`connector-send-execution.ts` -> `microsoft-documents-write.ts`), which
// re-checks everything against the state at that moment.
//
// The server stamps the fields the executor relies on (`connectionId`,
// `stewardUserId`, `attachmentSha256`, `proposedFileName`, `payloadDigest`);
// the generic approval routes refuse a Microsoft `connector_send`, so this is
// the only way one is filed and those fields are never agent-written.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { agents, assets, companyMemberships, issueAttachments } from "@paperclipai/db";
import {
  checkConnectorSendPayload,
  proposedCopyFileName,
  proposedCopyFormatFor,
} from "@paperclipai/shared";
import { HttpError, notFound, unprocessable } from "../errors.js";
import { assertIssueIdVisible } from "../routes/visibility.js";
import { insertActivity, publishActivity } from "./activity-log.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { approvalCardDeliveryService } from "./approval-card-delivery.js";
import { approvalService } from "./approvals.js";
import { connectorService } from "./connectors.js";
import { issueApprovalService } from "./issue-approvals.js";
import { stewardInboxService } from "./steward-inbox.js";

/** Same lifetime as a HubSpot write request: a decision that waits a day is stale. */
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface ProposeUploadInput {
  operation?: unknown;
  target?: unknown;
  fileName?: unknown;
  attachmentId?: unknown;
  sourceItemId?: unknown;
  summary?: unknown;
}

export interface ProposeUploadResult {
  approvalId: string;
  expiresAt: Date;
  proposedFileName: string;
  issueId: string;
}

/** Strip parameters (`; charset=utf-8`) and case from a stored content type. */
export function baseContentType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * The digest of exactly what the steward is deciding on. The executor
 * recomputes it from the stored payload and refuses on a mismatch, so a payload
 * edited after filing can never be executed under the original decision.
 */
export function microsoftProposalDigest(payload: Record<string, unknown>): string {
  const target = (payload.target ?? {}) as Record<string, unknown>;
  const decided = {
    operation: payload.operation ?? null,
    target: {
      driveId: target.driveId ?? null,
      folderId: target.folderId ?? null,
      path: target.path ?? null,
    },
    fileName: payload.fileName ?? null,
    proposedFileName: payload.proposedFileName ?? null,
    attachmentId: payload.attachmentId ?? null,
    attachmentSha256: payload.attachmentSha256 ?? null,
    sourceItemId: payload.sourceItemId ?? null,
    summary: payload.summary ?? null,
    connectionId: payload.connectionId ?? null,
    stewardUserId: payload.stewardUserId ?? null,
  };
  return createHash("sha256").update(JSON.stringify(decided)).digest("hex");
}

/** The attachment a proposal names, scoped to the company. */
export async function loadProposalAttachment(db: Db, companyId: string, attachmentId: string) {
  return db
    .select({
      attachmentId: issueAttachments.id,
      issueId: issueAttachments.issueId,
      assetId: assets.id,
      objectKey: assets.objectKey,
      contentType: assets.contentType,
      byteSize: assets.byteSize,
      sha256: assets.sha256,
      createdByAgentId: assets.createdByAgentId,
    })
    .from(issueAttachments)
    .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
    .where(and(eq(issueAttachments.id, attachmentId), eq(issueAttachments.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
}

export type ProposalAttachmentRefusal = "attachment_not_uploaded_by_agent" | "attachment_not_visible_to_steward";

/**
 * Whether this attachment may travel into this steward's OneDrive at all.
 *
 * - The requesting agent must have uploaded it. "An issue attachment you
 *   uploaded" is the contract the tool and skill state; without it an agent
 *   could name any file it can merely see, such as a client PDF a person
 *   attached on a restricted project.
 * - The steward must be able to see the issue it is attached to, judged as
 *   the steward (not the agent). Otherwise approving would copy a file out of
 *   a project the steward is not on, past AgentDash's own visibility rules,
 *   using the steward's credential.
 *
 * Asked at filing and again by the executor, because either can change in
 * between (an asset re-attributed, a project restricted).
 */
export async function proposalAttachmentRefusal(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    stewardUserId: string;
    attachment: { issueId: string; createdByAgentId: string | null };
  },
): Promise<ProposalAttachmentRefusal | null> {
  if (input.attachment.createdByAgentId !== input.agentId) return "attachment_not_uploaded_by_agent";
  const membership = await db
    .select()
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, input.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, input.stewardUserId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!membership) return "attachment_not_visible_to_steward";
  // The steward as a board actor, so the ONE visibility rule decides (project
  // restriction and agent visibility), exactly as it would for their own request.
  const asSteward = {
    actor: {
      type: "board",
      source: "session",
      userId: input.stewardUserId,
      isInstanceAdmin: false,
      companyIds: [input.companyId],
      memberships: [membership],
    },
  } as unknown as Request;
  try {
    await assertIssueIdVisible(db, asSteward, input.attachment.issueId, "Attachment");
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return "attachment_not_visible_to_steward";
    throw error;
  }
  return null;
}

const ATTACHMENT_REFUSAL_TEXT: Record<ProposalAttachmentRefusal, string> = {
  attachment_not_uploaded_by_agent:
    "You can only propose a copy of an attachment you uploaded yourself. Attach your draft to the task with " +
    "attach_file, then propose again with that attachment's id.",
  attachment_not_visible_to_steward:
    "Your steward cannot see the task this attachment is on, so they cannot approve copying it into their " +
    "OneDrive. Attach the draft to a task your steward can see, then propose again.",
};

function refusal(status: number, reason: string, message: string): HttpError {
  return new HttpError(status, message, { reason });
}

export function microsoftDocumentProposalService(db: Db) {
  const connectors = connectorService(db);
  const stewardships = agentStewardshipService(db);
  const stewardInbox = stewardInboxService(db);
  const cardDelivery = approvalCardDeliveryService(db);

  /**
   * File the approval. Throws an HttpError a route can return as-is:
   * 422 for a payload that could never execute, 404 for an attachment that is
   * not in this company (or that the caller may not see), 403 for an agent
   * with no steward or no usable connection.
   */
  async function propose(input: {
    companyId: string;
    agentId: string;
    body: ProposeUploadInput;
    /** The route's issue-visibility guard; throws 404 for an issue the caller cannot see. */
    assertIssueVisible: (issueId: string) => Promise<void>;
  }): Promise<ProposeUploadResult> {
    const { companyId, agentId, body } = input;
    const requested: Record<string, unknown> = {
      provider: "microsoft",
      operation: body.operation ?? "upload_new",
      target: body.target,
      fileName: typeof body.fileName === "string" ? body.fileName.trim() : body.fileName,
      attachmentId: body.attachmentId,
      sourceItemId: body.sourceItemId ?? null,
      summary: typeof body.summary === "string" ? body.summary.trim() : body.summary,
    };
    const shape = checkConnectorSendPayload(requested);
    if (!shape.ok) {
      throw unprocessable(shape.message, { code: `connector_send_${shape.problem}` });
    }
    const fileName = requested.fileName as string;
    const attachmentId = requested.attachmentId as string;
    const rawTarget = requested.target as Record<string, unknown>;
    const target: Record<string, string> = {};
    if (typeof rawTarget.driveId === "string") target.driveId = rawTarget.driveId;
    if (typeof rawTarget.folderId === "string") target.folderId = rawTarget.folderId;
    if (typeof rawTarget.path === "string") target.path = rawTarget.path.trim();

    // The steward, live. No steward means there is nobody whose OneDrive this
    // could ever land in, and nobody to decide it.
    const steward = await stewardships.activeByAgent(companyId, agentId);
    if (!steward) {
      throw refusal(
        403,
        "no_active_steward",
        "You have no steward, so there is no OneDrive to propose a copy to and nobody to approve it.",
      );
    }
    // Slice 1: only the steward's own private row resolves.
    const acting = await connectors.resolveActingAs(companyId, agentId, "send", "microsoft");
    if (!acting.ok) {
      throw refusal(403, acting.blocked.reason, acting.blocked.message);
    }

    const attachment = await loadProposalAttachment(db, companyId, attachmentId);
    if (!attachment) throw notFound("Attachment not found");
    await input.assertIssueVisible(attachment.issueId);
    const provenance = await proposalAttachmentRefusal(db, {
      companyId,
      agentId,
      stewardUserId: steward.userId,
      attachment,
    });
    if (provenance) throw unprocessable(ATTACHMENT_REFUSAL_TEXT[provenance], { code: provenance });

    const format = proposedCopyFormatFor(fileName)!;
    const contentType = baseContentType(attachment.contentType);
    if (!format.accepts.includes(contentType)) {
      throw unprocessable(
        `A .${format.extension} copy can be made from an attachment of type ${format.accepts.join(" or ")}; ` +
          `this attachment is ${contentType || "of unknown type"}. Attach the draft in one of those formats ` +
          `(Markdown for a Word document), then propose again.`,
        { code: "attachment_type_mismatch" },
      );
    }

    const agentName = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0]?.name ?? "");
    const proposedFileName = proposedCopyFileName(fileName, agentName);

    const payload: Record<string, unknown> = {
      provider: "microsoft",
      operation: "upload_new",
      target,
      fileName,
      proposedFileName,
      attachmentId,
      attachmentSha256: attachment.sha256,
      attachmentByteSize: attachment.byteSize,
      attachmentContentType: contentType,
      sourceItemId: requested.sourceItemId,
      summary: requested.summary,
      connectionId: acting.resolution.connectionId,
      stewardUserId: steward.userId,
    };
    payload.payloadDigest = microsoftProposalDigest(payload);

    const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MS);
    // Create, link to the task the file belongs to, and record it as one
    // unit, as the generic approval route does (GH #919).
    const { approval, publication } = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const created = await approvalService(tx).create(companyId, {
        type: "connector_send",
        requestedByAgentId: agentId,
        requestedByUserId: null,
        status: "pending",
        expiresAt,
        payload,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      await issueApprovalService(tx).linkManyForApproval(created.id, [attachment.issueId], { agentId });
      const activity = await insertActivity(tx, {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "document.upload_proposed",
        entityType: "approval",
        entityId: created.id,
        // Ids and digests only. The file name, folder and summary live on the
        // approval, which the steward reads; they are not copied here.
        details: {
          provider: "microsoft",
          operation: "upload_new",
          connectionId: acting.resolution.connectionId,
          attachmentId,
          attachmentSha256: attachment.sha256,
          issueId: attachment.issueId,
          payloadDigest: payload.payloadDigest,
        },
      });
      return { approval: created, publication: activity };
    });
    publishActivity(publication);

    // The steward hears about it where they hear about every approval.
    await stewardInbox.recordApprovalEvent(approval.id, "approval.opened");
    await cardDelivery.deliverForApproval(approval.id);

    return { approvalId: approval.id, expiresAt, proposedFileName, issueId: attachment.issueId };
  }

  return { propose };
}
