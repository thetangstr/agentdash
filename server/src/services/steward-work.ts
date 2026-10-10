import type { Readable } from "node:stream";
import { and, asc, count, desc, eq, inArray, isNull, min, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  assets,
  authUsers,
  bridgeEndpoints,
  companies,
  documents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issues,
  issueThreadInteractions,
  projects,
} from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import type { Request } from "express";
import { conflict, forbidden, HttpError, notFound } from "../errors.js";
import {
  isAllowedContentType,
  normalizeContentType,
  normalizeIssueAttachmentMaxBytes,
} from "../attachment-types.js";
import { documentRunAccess } from "../routes/document-run-access.js";
import {
  isCanonicalUuid,
  issueVisibilityCondition,
  resolveAgentVisibility,
} from "../routes/visibility.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import { AGENT_MATERIAL_FRAMING, STEWARD_WORK_CAPABILITY, frameUntrustedAgentMaterial } from "./bridge.js";
import { featureFlagsService } from "./feature-flags.js";
import { redactRunLogText } from "./run-log-redaction.js";
import {
  DECIDABLE_STATUSES,
  activeMembership,
  frameUntrustedText,
  personRequest,
  stewardInboxService,
} from "./steward-inbox.js";

/**
 * AgentDash-MK: the person's own Claude as co-worker -- the read half.
 *
 * The steward inbox (steward-inbox.ts) delivers pointers: "Agent A asked you
 * something on ISSUE-41". This service delivers the evidence behind them, so
 * the person's own session can review the agent's work before the person
 * decides anything: the issue and the request it came from, the comments, the
 * documents, the attachments (metadata here, bytes through `file`), and the
 * agent's run log.
 *
 * Four rules hold on every call, and each is the reason this is its own
 * service rather than more fields on the digest:
 *
 * 1. **Its own credential scope.** The endpoint must hold `bridge:work`, and
 *    the company must have switched `coworker_bridge_enabled` on. An
 *    inbox-only machine never receives evidence.
 * 2. **Exactly the page.** Every read is resolved as the endpoint's owner
 *    through the same visibility predicates the web uses (restricted projects,
 *    agent visibility, the document-access run rule), and then narrowed to the
 *    owner's own work: issues assigned to them or to an agent they answer for.
 *    Anything else is 404 -- never 403, which would confirm it exists.
 * 3. **Framed, all of it.** Every free-text field was written by an agent or
 *    another person and is delivered into a session with the person's files
 *    and shells. Multi-line text arrives inside `<untrusted-agent-material>`
 *    markers; one-line text is flattened and capped. Ids, sizes, hashes and
 *    timestamps are not text and are not framed.
 * 4. **Capped, with totals.** Every list says how many there are and how many
 *    it shows; every long body says whether it was cut and where to resume.
 *
 * Nothing here writes, except the activity row each file download leaves.
 */

/** How the person refers to this surface in refusals. */
const DISABLED_REASON =
  "Reviewing your agents' work from your own session is not switched on for this company. " +
  "An administrator turns it on (coworker_bridge_enabled); until then, open the issue on your AgentDash page.";

/** Caps. Lists report `total` beside `shown`; text reports `truncated`. */
export const WORK_LIMITS = {
  listDefault: 25,
  listMax: 50,
  commentsDefault: 20,
  commentsMax: 50,
  children: 20,
  documents: 20,
  attachments: 50,
  runs: 20,
  runEvents: 50,
  ancestors: 10,
} as const;

export const WORK_TEXT_CAPS = {
  /** One-line fields: titles, names. */
  title: 240,
  name: 120,
  /** Multi-line bodies, in characters. */
  issueBody: 20_000,
  contextBody: 4_000,
  comment: 4_000,
  documentPage: 20_000,
  runEventMessage: 1_000,
  /** One page of a run log, in bytes of the stored file. */
  runLogPageBytes: 64_000,
} as const;

/**
 * Types refused on the bridge file path whatever the allowlist says (D6):
 * markup a viewer may execute. Matched on the stored type and on the file
 * name, because a `.html` stored as text/plain is still a page someone's
 * tooling may open as one.
 */
const MARKUP_TYPES = new Set(["text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"]);
const MARKUP_EXTENSIONS = /\.(html?|xhtml|shtml|svg|xml|xht|mht|mhtml)$/i;

const ISSUE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/i;

type WorkRefusal = { ok: false; code: string; reason: string };
type EndpointRow = typeof bridgeEndpoints.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

type Owner = {
  endpoint: EndpointRow;
  companyId: string;
  userId: string;
  req: Request;
  agentIds: string[];
  agentNameById: Map<string, string>;
};

function refusal(code: string, reason: string): WorkRefusal {
  return { ok: false, code, reason };
}

function clampInt(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, lo), hi);
}

/**
 * A slice of a long agent-written body, framed, with where it was cut. The
 * offset and lengths are in characters of the stored text.
 */
export function framedSlice(value: string | null | undefined, kind: string, max: number, offset = 0) {
  const text = value ?? "";
  const start = Math.min(Math.max(0, Math.floor(offset)), text.length);
  const slice = text.slice(start, start + max);
  const end = start + slice.length;
  return {
    text: slice ? frameUntrustedAgentMaterial(slice, kind) : null,
    totalChars: text.length,
    offset: start,
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
  };
}

/** Why this attachment may or may not come down the bridge. */
export function downloadVerdict(
  attachment: { contentType: string | null; originalFilename: string | null; byteSize: number },
  capBytes: number,
): { allowed: true } | { allowed: false; reason: string } {
  const type = normalizeContentType(attachment.contentType);
  const name = attachment.originalFilename ?? "";
  if (MARKUP_TYPES.has(type) || MARKUP_EXTENSIONS.test(name)) {
    return {
      allowed: false,
      reason: "HTML, SVG and XML files are not sent over the bridge: they can carry script. Open it on the AgentDash page.",
    };
  }
  if (!isAllowedContentType(type)) {
    return { allowed: false, reason: `${type} is not on this instance's attachment allowlist.` };
  }
  if (attachment.byteSize > capBytes) {
    return {
      allowed: false,
      reason: `This file is ${attachment.byteSize} bytes; the cap for this company is ${capBytes} bytes.`,
    };
  }
  return { allowed: true };
}

/** Stored run-log NDJSON, as the readable transcript it records. */
export function transcriptFromRunLog(content: string): string {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as { stream?: unknown; chunk?: unknown };
      if (typeof record.chunk === "string") {
        out.push(
          record.stream === "stderr"
            ? record.chunk.replace(/^(?=.)/gm, "[stderr] ")
            : record.chunk,
        );
        continue;
      }
    } catch {
      // A line cut by the page boundary: keep it as text, it was redacted as text.
    }
    out.push(`${line}\n`);
  }
  return out.join("");
}

type ReadRunLog = (
  run: { id: string; companyId: string; logStore: string | null; logRef: string | null },
  opts: { offset: number; limitBytes: number },
) => Promise<{ content: string; nextOffset?: number; missing?: boolean }>;

export function stewardWorkService(
  db: Db,
  options: {
    storage?: StorageService;
    /** The heartbeat service's `readLog`: redacted at write and again at serve. */
    readRunLog?: ReadRunLog;
  } = {},
) {
  const inbox = stewardInboxService(db);
  const flags = featureFlagsService(db);
  const runAccess = documentRunAccess(db);

  /**
   * The endpoint, if it may use the work routes at all. Same gate shape as
   * `requireInboxEndpoint`: a revoked or unknown endpoint is 404, an
   * unapproved one 409, one without the capability 403.
   */
  async function requireWorkEndpoint(endpointId: string): Promise<EndpointRow> {
    const endpoint = await db
      .select()
      .from(bridgeEndpoints)
      .where(and(eq(bridgeEndpoints.id, endpointId), isNull(bridgeEndpoints.revokedAt)))
      .then((rows) => rows[0] ?? null);
    if (!endpoint) throw notFound("Endpoint not found");
    if (!endpoint.enrolledAt) throw conflict("That endpoint has not been approved yet");
    if (!(endpoint.capabilities ?? []).includes(STEWARD_WORK_CAPABILITY)) {
      throw forbidden(
        `That endpoint did not declare the ${STEWARD_WORK_CAPABILITY} capability. Reconnect this machine with a new connect code to add it.`,
      );
    }
    return endpoint;
  }

  /** Who is reading, as a person, or the refusal a person can act on. */
  async function resolveOwner(endpointId: string): Promise<Owner | WorkRefusal> {
    const endpoint = await requireWorkEndpoint(endpointId);
    if (!(await flags.isEnabled(endpoint.companyId, FEATURE_FLAG_KEYS.COWORKER_BRIDGE))) {
      return refusal("coworker_bridge_disabled", DISABLED_REASON);
    }
    const member = await activeMembership(db, endpoint.companyId, endpoint.userId);
    if (!member) {
      return refusal("not_a_member", "You are no longer an active member of this company.");
    }
    const req = personRequest(endpoint.userId, {
      companyId: endpoint.companyId,
      membershipRole: member.membershipRole,
      status: member.status,
    });
    // Built once per call: issueVisibilityCondition reads it from the request.
    await resolveAgentVisibility(db, req, endpoint.companyId);
    const mine = await inbox.agentsAnsweredForBy(endpoint.companyId, endpoint.userId);
    return {
      endpoint,
      companyId: endpoint.companyId,
      userId: endpoint.userId,
      req,
      agentIds: mine.map((agent) => agent.id),
      agentNameById: new Map(mine.map((agent) => [agent.id, agent.name])),
    };
  }

  function isRefusal(value: Owner | WorkRefusal): value is WorkRefusal {
    return (value as WorkRefusal).ok === false;
  }

  /** Is this one issue on the owner's page? */
  async function visibleOnPage(owner: Owner, issueId: string): Promise<boolean> {
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.id, issueId), issueVisibilityCondition(owner.req, owner.companyId)))
      .then((rows) => rows.length > 0);
  }

  /** The owner's own work: assigned to them, or to an agent they answer for. */
  function isOwnersWork(owner: Owner, issue: IssueRow): boolean {
    if (issue.assigneeUserId && issue.assigneeUserId === owner.userId) return true;
    return Boolean(issue.assigneeAgentId && owner.agentIds.includes(issue.assigneeAgentId));
  }

  /**
   * The issue, or 404. Unknown, hidden, off the owner's page, and not the
   * owner's work all answer the same, so the answer reveals nothing.
   */
  async function findWorkIssue(owner: Owner, issueRef: unknown): Promise<IssueRow> {
    const missing = notFound("Issue not found");
    const ref = typeof issueRef === "string" ? issueRef.trim() : "";
    let match;
    if (isCanonicalUuid(ref)) match = eq(issues.id, ref);
    else if (ISSUE_IDENTIFIER_RE.test(ref)) match = eq(issues.identifier, ref.toUpperCase());
    else throw missing;
    const issue = await db
      .select()
      .from(issues)
      .where(and(match, eq(issues.companyId, owner.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.hiddenAt) throw missing;
    if (!isOwnersWork(owner, issue)) throw missing;
    if (!(await visibleOnPage(owner, issue.id))) throw missing;
    return issue;
  }

  async function namesFor(input: { agentIds?: Array<string | null>; userIds?: Array<string | null> }) {
    const agentIds = [...new Set((input.agentIds ?? []).filter((id): id is string => Boolean(id)))];
    const userIds = [...new Set((input.userIds ?? []).filter((id): id is string => Boolean(id)))];
    const agentNames = new Map<string, string>();
    const userNames = new Map<string, string>();
    if (agentIds.length > 0) {
      const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds));
      for (const row of rows) agentNames.set(row.id, row.name);
    }
    if (userIds.length > 0) {
      const rows = await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds));
      for (const row of rows) if (row.name) userNames.set(row.id, row.name);
    }
    return {
      author(agentId: string | null | undefined, userId: string | null | undefined) {
        if (agentId) return { kind: "agent" as const, name: frameUntrustedText(agentNames.get(agentId), WORK_TEXT_CAPS.name) };
        if (userId) return { kind: "person" as const, name: frameUntrustedText(userNames.get(userId), WORK_TEXT_CAPS.name) };
        return { kind: "system" as const, name: null };
      },
    };
  }

  // -------------------------------------------------------------------------
  // work/list
  // -------------------------------------------------------------------------

  /**
   * What the owner's agents have handed them: issues assigned to an agent they
   * answer for that are blocked or in review, or carry an open question or an
   * open approval. Decisions first, then questions, then blockers, then
   * reviews -- the order the review skill works in -- and oldest first within
   * each, so the longest wait is read first.
   */
  async function list(endpointId: string, input: { limit?: unknown } = {}) {
    const owner = await resolveOwner(endpointId);
    if (isRefusal(owner)) return owner;
    const limit = clampInt(input.limit, WORK_LIMITS.listDefault, 1, WORK_LIMITS.listMax);
    const empty = { total: 0, shown: 0, truncated: false, items: [] as unknown[] };
    const base = { ok: true as const, framing: AGENT_MATERIAL_FRAMING };
    if (owner.agentIds.length === 0) return { ...base, agentsAnsweredFor: 0, handoffs: empty };

    const pendingQuestion = sql`exists (select 1 from ${issueThreadInteractions} q
      where q.issue_id = ${issues.id} and q.kind = 'ask_user_questions' and q.status = 'pending')`;
    const openApproval = sql`exists (select 1 from ${issueApprovals} ia
      join ${approvals} a on a.id = ia.approval_id
      where ia.issue_id = ${issues.id} and a.status in ('pending', 'revision_requested'))`;
    const candidates = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        projectId: issues.projectId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, owner.companyId),
          isNull(issues.hiddenAt),
          inArray(issues.assigneeAgentId, owner.agentIds),
          notInArray(issues.status, ["done", "cancelled"]),
          or(inArray(issues.status, ["blocked", "in_review"]), pendingQuestion, openApproval),
          issueVisibilityCondition(owner.req, owner.companyId),
        ),
      );
    if (candidates.length === 0) return { ...base, agentsAnsweredFor: owner.agentIds.length, handoffs: empty };
    const ids = candidates.map((row) => row.id);

    const questionRows = await db
      .select({ issueId: issueThreadInteractions.issueId, n: count(), since: min(issueThreadInteractions.createdAt) })
      .from(issueThreadInteractions)
      .where(
        and(
          inArray(issueThreadInteractions.issueId, ids),
          eq(issueThreadInteractions.kind, "ask_user_questions"),
          eq(issueThreadInteractions.status, "pending"),
        ),
      )
      .groupBy(issueThreadInteractions.issueId);
    const approvalRows = await db
      .select({ issueId: issueApprovals.issueId, n: count(), since: min(approvals.updatedAt) })
      .from(issueApprovals)
      .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
      .where(and(inArray(issueApprovals.issueId, ids), inArray(approvals.status, [...DECIDABLE_STATUSES])))
      .groupBy(issueApprovals.issueId);
    const documentRows = await db
      .select({ issueId: issueDocuments.issueId, n: count() })
      .from(issueDocuments)
      .where(inArray(issueDocuments.issueId, ids))
      .groupBy(issueDocuments.issueId);
    const attachmentRows = await db
      .select({ issueId: issueAttachments.issueId, n: count() })
      .from(issueAttachments)
      .where(inArray(issueAttachments.issueId, ids))
      .groupBy(issueAttachments.issueId);
    const projectIds = [...new Set(candidates.map((row) => row.projectId).filter((id): id is string => Boolean(id)))];
    const projectNames = new Map<string, string>();
    if (projectIds.length > 0) {
      for (const row of await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds))) {
        projectNames.set(row.id, row.name);
      }
    }

    const byIssue = <T extends { issueId: string }>(rows: T[]) => new Map(rows.map((row) => [row.issueId, row]));
    const questions = byIssue(questionRows);
    const approvalsByIssue = byIssue(approvalRows);
    const documentsByIssue = byIssue(documentRows);
    const attachmentsByIssue = byIssue(attachmentRows);

    const ranked = candidates
      .map((row) => {
        const q = questions.get(row.id);
        const a = approvalsByIssue.get(row.id);
        const waitingOn: string[] = [];
        if (a) waitingOn.push("approval");
        if (q) waitingOn.push("question");
        if (row.status === "blocked") waitingOn.push("blocked");
        if (row.status === "in_review") waitingOn.push("in_review");
        const rank = a ? 0 : q ? 1 : row.status === "blocked" ? 2 : 3;
        const since = [a?.since, q?.since].filter((d): d is Date => d instanceof Date);
        const waitingSince = since.length > 0 ? new Date(Math.min(...since.map((d) => d.getTime()))) : row.updatedAt;
        return { row, rank, waitingOn, waitingSince, q, a };
      })
      .sort((x, y) => x.rank - y.rank || x.waitingSince.getTime() - y.waitingSince.getTime());

    const items = ranked.slice(0, limit).map(({ row, waitingOn, waitingSince, q, a }) => ({
      issueId: row.id,
      identifier: row.identifier,
      title: frameUntrustedText(row.title, WORK_TEXT_CAPS.title),
      status: row.status,
      agentName: row.assigneeAgentId ? owner.agentNameById.get(row.assigneeAgentId) ?? null : null,
      project: row.projectId ? frameUntrustedText(projectNames.get(row.projectId), WORK_TEXT_CAPS.name) : null,
      waitingOn,
      openQuestions: Number(q?.n ?? 0),
      openApprovals: Number(a?.n ?? 0),
      documents: Number(documentsByIssue.get(row.id)?.n ?? 0),
      attachments: Number(attachmentsByIssue.get(row.id)?.n ?? 0),
      waitingSince: waitingSince.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    return {
      ...base,
      agentsAnsweredFor: owner.agentIds.length,
      handoffs: { total: ranked.length, shown: items.length, truncated: ranked.length > items.length, items },
    };
  }

  // -------------------------------------------------------------------------
  // work/read
  // -------------------------------------------------------------------------

  /** Parent and original request, stopping at the first one off the page. */
  async function contextChain(owner: Owner, issue: IssueRow) {
    const chain: IssueRow[] = [];
    let parentId = issue.parentId;
    const seen = new Set<string>([issue.id]);
    while (parentId && chain.length < WORK_LIMITS.ancestors && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, parentId), eq(issues.companyId, owner.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!parent || parent.hiddenAt || !(await visibleOnPage(owner, parent.id))) break;
      chain.push(parent);
      parentId = parent.parentId;
    }
    return chain;
  }

  async function read(
    endpointId: string,
    input: { issueId?: unknown; documentKey?: unknown; offset?: unknown; commentLimit?: unknown },
  ) {
    const owner = await resolveOwner(endpointId);
    if (isRefusal(owner)) return owner;
    const issue = await findWorkIssue(owner, input.issueId);
    const documentKey = typeof input.documentKey === "string" && input.documentKey.trim() ? input.documentKey.trim() : null;
    const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const commentLimit = clampInt(input.commentLimit, WORK_LIMITS.commentsDefault, 1, WORK_LIMITS.commentsMax);

    const company = await db
      .select({ attachmentMaxBytes: companies.attachmentMaxBytes })
      .from(companies)
      .where(eq(companies.id, owner.companyId))
      .then((rows) => rows[0] ?? null);
    const capBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);

    const project = issue.projectId
      ? await db
          .select({ id: projects.id, name: projects.name, visibility: projects.visibility })
          .from(projects)
          .where(eq(projects.id, issue.projectId))
          .then((rows) => rows[0] ?? null)
      : null;

    const chain = await contextChain(owner, issue);

    const commentTotal = await db
      .select({ n: count() })
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .then((rows) => Number(rows[0]?.n ?? 0));
    const commentRows = (
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issue.id))
        .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        .limit(commentLimit)
    ).reverse();

    const documentRows = await db
      .select({
        key: issueDocuments.key,
        documentId: documents.id,
        title: documents.title,
        format: documents.format,
        body: documents.latestBody,
        revisionId: documents.latestRevisionId,
        revisionNumber: documents.latestRevisionNumber,
        updatedAt: documents.updatedAt,
        updatedByAgentId: documents.updatedByAgentId,
        updatedByUserId: documents.updatedByUserId,
      })
      .from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(eq(issueDocuments.issueId, issue.id))
      .orderBy(asc(issueDocuments.key));
    if (documentKey && !documentRows.some((row) => row.key === documentKey)) {
      return refusal("no_such_document", `There is no document with the key "${frameUntrustedText(documentKey, 80)}" on this issue.`);
    }

    const attachmentRows = await db
      .select({
        id: issueAttachments.id,
        commentId: issueAttachments.issueCommentId,
        createdAt: issueAttachments.createdAt,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(eq(issueAttachments.issueId, issue.id))
      .orderBy(desc(issueAttachments.createdAt));

    const childRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, owner.companyId),
          eq(issues.parentId, issue.id),
          isNull(issues.hiddenAt),
          issueVisibilityCondition(owner.req, owner.companyId),
        ),
      )
      .orderBy(asc(issues.createdAt));

    const names = await namesFor({
      agentIds: [
        issue.assigneeAgentId,
        issue.createdByAgentId,
        ...chain.map((row) => row.createdByAgentId),
        ...commentRows.map((row) => row.authorAgentId),
        ...documentRows.map((row) => row.updatedByAgentId),
        ...attachmentRows.map((row) => row.createdByAgentId),
        ...childRows.map((row) => row.assigneeAgentId),
      ],
      userIds: [
        issue.assigneeUserId,
        issue.createdByUserId,
        ...chain.map((row) => row.createdByUserId),
        ...commentRows.map((row) => row.authorUserId),
        ...documentRows.map((row) => row.updatedByUserId),
        ...attachmentRows.map((row) => row.createdByUserId),
        ...childRows.map((row) => row.assigneeUserId),
      ],
    });

    const contextIssue = (row: IssueRow) => ({
      issueId: row.id,
      identifier: row.identifier,
      title: frameUntrustedText(row.title, WORK_TEXT_CAPS.title),
      status: row.status,
      createdBy: names.author(row.createdByAgentId, row.createdByUserId),
      description: framedSlice(row.description, "issue-description", WORK_TEXT_CAPS.contextBody),
    });
    const parent = chain[0] ?? null;
    const root = chain.length > 1 ? chain[chain.length - 1]! : null;

    const shownDocuments = (documentKey ? documentRows.filter((row) => row.key === documentKey) : documentRows).slice(
      0,
      WORK_LIMITS.documents,
    );
    const shownAttachments = attachmentRows.slice(0, WORK_LIMITS.attachments);
    const shownChildren = childRows.slice(0, WORK_LIMITS.children);

    return {
      ok: true as const,
      framing: AGENT_MATERIAL_FRAMING,
      issue: {
        issueId: issue.id,
        identifier: issue.identifier,
        title: frameUntrustedText(issue.title, WORK_TEXT_CAPS.title),
        status: issue.status,
        priority: issue.priority,
        assignee: issue.assigneeAgentId
          ? names.author(issue.assigneeAgentId, null)
          : names.author(null, issue.assigneeUserId),
        createdBy: names.author(issue.createdByAgentId, issue.createdByUserId),
        createdAt: issue.createdAt.toISOString(),
        updatedAt: issue.updatedAt.toISOString(),
        description: framedSlice(issue.description, "issue-description", WORK_TEXT_CAPS.issueBody),
      },
      project: project
        ? {
            name: frameUntrustedText(project.name, WORK_TEXT_CAPS.name),
            // Restricted projects are where files may travel back (D2).
            restricted: project.visibility === "restricted",
          }
        : null,
      parent: parent ? contextIssue(parent) : null,
      // The request this work started from, when it is further up than the parent.
      request: root ? contextIssue(root) : null,
      comments: {
        total: commentTotal,
        shown: commentRows.length,
        truncated: commentTotal > commentRows.length,
        // Oldest first within the newest `shown`.
        items: commentRows.map((row) => ({
          commentId: row.id,
          createdAt: row.createdAt.toISOString(),
          author: names.author(row.authorAgentId, row.authorUserId),
          body: framedSlice(row.body, "comment", WORK_TEXT_CAPS.comment),
        })),
      },
      documents: {
        total: documentRows.length,
        shown: shownDocuments.length,
        truncated: documentRows.length > shownDocuments.length,
        items: shownDocuments.map((row) => ({
          key: row.key,
          title: frameUntrustedText(row.title, WORK_TEXT_CAPS.title),
          format: row.format,
          revisionId: row.revisionId,
          revisionNumber: row.revisionNumber,
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: names.author(row.updatedByAgentId, row.updatedByUserId),
          // `offset` applies to the document named by `documentKey` only.
          body: framedSlice(row.body, "document", WORK_TEXT_CAPS.documentPage, documentKey ? offset : 0),
        })),
      },
      attachments: {
        total: attachmentRows.length,
        shown: shownAttachments.length,
        truncated: attachmentRows.length > shownAttachments.length,
        capBytes,
        items: shownAttachments.map((row) => {
          const verdict = downloadVerdict(row, capBytes);
          return {
            attachmentId: row.id,
            name: frameUntrustedText(row.originalFilename, WORK_TEXT_CAPS.title),
            contentType: normalizeContentType(row.contentType),
            byteSize: row.byteSize,
            sha256: row.sha256,
            createdAt: row.createdAt.toISOString(),
            commentId: row.commentId,
            author: names.author(row.createdByAgentId, row.createdByUserId),
            download: verdict.allowed ? { allowed: true } : { allowed: false, reason: verdict.reason },
          };
        }),
      },
      children: {
        total: childRows.length,
        shown: shownChildren.length,
        truncated: childRows.length > shownChildren.length,
        items: shownChildren.map((row) => ({
          issueId: row.id,
          identifier: row.identifier,
          title: frameUntrustedText(row.title, WORK_TEXT_CAPS.title),
          status: row.status,
          assignee: row.assigneeAgentId ? names.author(row.assigneeAgentId, null) : names.author(null, row.assigneeUserId),
        })),
      },
    };
  }

  // -------------------------------------------------------------------------
  // work/run-log
  // -------------------------------------------------------------------------

  /**
   * The runs on this issue the owner may read: by an agent they answer for
   * (never another person's agent), and readable under the document-access
   * run rule exactly as on the page. Newest first.
   */
  async function readableRuns(owner: Owner, issue: IssueRow) {
    if (owner.agentIds.length === 0) return [];
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        createdAt: heartbeatRuns.createdAt,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        logBytes: heartbeatRuns.logBytes,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, owner.companyId),
          inArray(heartbeatRuns.agentId, owner.agentIds),
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            sql`exists (
              select 1 from ${activityLog}
              where ${activityLog.companyId} = ${owner.companyId}
                and ${activityLog.entityType} = 'issue'
                and ${activityLog.entityId} = ${issue.id}
                and ${activityLog.runId} = ${heartbeatRuns.id}
            )`,
          ),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(200);
    const readable = [];
    for (const row of rows) {
      if (await runAccess.canReadRunContent(owner.req.actor, row)) readable.push(row);
    }
    return readable;
  }

  async function runLog(endpointId: string, input: { issueId?: unknown; runId?: unknown; offset?: unknown }) {
    const owner = await resolveOwner(endpointId);
    if (isRefusal(owner)) return owner;
    const issue = await findWorkIssue(owner, input.issueId);
    const runs = await readableRuns(owner, issue);

    const runSummary = (run: (typeof runs)[number]) => ({
      runId: run.id,
      agentName: owner.agentNameById.get(run.agentId) ?? null,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      logBytes: run.logBytes ?? 0,
    });
    const shownRuns = runs.slice(0, WORK_LIMITS.runs);
    const runsBlock = {
      total: runs.length,
      shown: shownRuns.length,
      truncated: runs.length > shownRuns.length,
      items: shownRuns.map(runSummary),
    };

    let run: (typeof runs)[number] | undefined;
    if (input.runId !== undefined && input.runId !== null && input.runId !== "") {
      run = typeof input.runId === "string" && isCanonicalUuid(input.runId)
        ? runs.find((row) => row.id === input.runId)
        : undefined;
      // Not a run of this issue the owner may read: as missing as any other.
      if (!run) throw notFound("Run not found");
    } else {
      run = runs[0];
    }
    if (!run) {
      return { ok: true as const, framing: AGENT_MATERIAL_FRAMING, issueId: issue.id, identifier: issue.identifier, runs: runsBlock, run: null };
    }

    const offset = clampInt(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    let log: { content: string; nextOffset?: number; missing?: boolean };
    if (!run.logStore || !run.logRef || !options.readRunLog) {
      log = { content: "", missing: true };
    } else {
      try {
        log = await options.readRunLog(run, { offset, limitBytes: WORK_TEXT_CAPS.runLogPageBytes });
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) log = { content: "", missing: true };
        else throw err;
      }
    }
    // Redacted at write and at serve already; once more here, because this
    // copy leaves the server for a machine nobody here can inspect.
    const transcript = redactRunLogText(transcriptFromRunLog(log.content));

    const eventTotal = await db
      .select({ n: count() })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run.id))
      .then((rows) => Number(rows[0]?.n ?? 0));
    const eventRows = (
      await db
        .select({
          seq: heartbeatRunEvents.seq,
          eventType: heartbeatRunEvents.eventType,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run.id))
        .orderBy(desc(heartbeatRunEvents.seq))
        .limit(WORK_LIMITS.runEvents)
    ).reverse();

    return {
      ok: true as const,
      framing: AGENT_MATERIAL_FRAMING,
      issueId: issue.id,
      identifier: issue.identifier,
      runs: runsBlock,
      run: {
        ...runSummary(run),
        log: {
          // Byte offsets in the stored log; pass `nextOffset` back as `offset`.
          offset,
          nextOffset: log.nextOffset ?? null,
          truncated: typeof log.nextOffset === "number",
          missing: log.missing === true,
          text: transcript ? frameUntrustedAgentMaterial(transcript, "run-log") : null,
        },
        // Payloads are left out: they are adapter internals, not the agent's work.
        events: {
          total: eventTotal,
          shown: eventRows.length,
          truncated: eventTotal > eventRows.length,
          items: eventRows.map((row) => ({
            seq: row.seq,
            eventType: row.eventType,
            level: row.level,
            createdAt: row.createdAt.toISOString(),
            message: frameUntrustedText(row.message ? redactRunLogText(row.message) : null, WORK_TEXT_CAPS.runEventMessage),
          })),
        },
      },
    };
  }

  // -------------------------------------------------------------------------
  // work/file
  // -------------------------------------------------------------------------

  /**
   * One attachment's bytes, or the reason it will not come down the bridge.
   * Every download writes an activity row naming the attachment and its size,
   * never its content.
   */
  async function file(
    endpointId: string,
    input: { attachmentId?: unknown },
  ): Promise<
    | WorkRefusal
    | {
        ok: true;
        stream: Readable;
        attachmentId: string;
        issueId: string;
        identifier: string | null;
        filename: string;
        contentType: string;
        byteSize: number;
        sha256: string;
      }
  > {
    const owner = await resolveOwner(endpointId);
    if (isRefusal(owner)) return owner;
    const attachmentId = typeof input.attachmentId === "string" ? input.attachmentId.trim() : "";
    if (!isCanonicalUuid(attachmentId)) throw notFound("Attachment not found");
    const attachment = await db
      .select({
        id: issueAttachments.id,
        issueId: issueAttachments.issueId,
        companyId: issueAttachments.companyId,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        originalFilename: assets.originalFilename,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(assets.id, issueAttachments.assetId))
      .where(and(eq(issueAttachments.id, attachmentId), eq(issueAttachments.companyId, owner.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!attachment) throw notFound("Attachment not found");
    let issue: IssueRow;
    try {
      issue = await findWorkIssue(owner, attachment.issueId);
    } catch {
      throw notFound("Attachment not found");
    }

    const company = await db
      .select({ attachmentMaxBytes: companies.attachmentMaxBytes })
      .from(companies)
      .where(eq(companies.id, owner.companyId))
      .then((rows) => rows[0] ?? null);
    const verdict = downloadVerdict(attachment, normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes));
    if (!verdict.allowed) return refusal("file_refused", verdict.reason);

    if (!options.storage) throw new HttpError(503, "File storage is not available");
    const object = await options.storage.getObject(owner.companyId, attachment.objectKey);

    await logActivity(db, {
      companyId: owner.companyId,
      actorType: "user",
      actorId: owner.userId,
      action: "bridge.work_file_downloaded",
      entityType: "issue",
      entityId: issue.id,
      details: {
        attachmentId: attachment.id,
        bytes: attachment.byteSize,
        channel: "bridge_work",
        bridgeEndpointId: owner.endpoint.id,
        endpointLabel: owner.endpoint.label,
      },
    });

    return {
      ok: true,
      stream: object.stream,
      attachmentId: attachment.id,
      issueId: issue.id,
      identifier: issue.identifier,
      filename: attachment.originalFilename ?? "attachment",
      contentType: normalizeContentType(attachment.contentType),
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
    };
  }

  return { requireWorkEndpoint, list, read, runLog, file };
}
