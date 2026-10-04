import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, documents, heartbeatRuns, issueDocuments, issueWorkProducts, issues } from "@paperclipai/db";
import { insertActivity, publishActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";
import type {
  IssueWorkProduct,
  ShippedFeed,
  ShippedIssueUsage,
  ShippedWorkProduct,
} from "@paperclipai/shared";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type ReviewLoopExecutor = Pick<Db, "select" | "insert" | "update">;
type ReviewLoopIssue = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "assigneeAgentId" | "executionRunId" | "checkoutRunId"
>;

// AgentDash (batch 2 review lane): the document a document-typed deliverable
// points at lives behind metadata.documentKey (the key the agent wrote it
// under), joined through issue_documents.
export function workProductDocumentKey(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const key = (metadata as Record<string, unknown>).documentKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

export interface IssueDocumentRevisionInfo {
  issueId: string;
  key: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  updatedAt: Date;
}

/** The map key `listIssueDocumentsByKey` returns rows under. */
export function issueDocumentKey(issueId: string, key: string): string {
  return `${issueId}\u0000${key}`;
}

/**
 * Documents linked to issues under the given keys, keyed by
 * `issueId + "\0" + key`. The issue joins the key — document keys repeat
 * across issues ("spec" on two issues is two documents).
 */
export async function listIssueDocumentsByKey(
  executor: Pick<Db, "select">,
  companyId: string,
  keysByIssue: ReadonlyMap<string, readonly string[]>,
) {
  const issueIds = [...keysByIssue.keys()];
  const keys = [...new Set([...keysByIssue.values()].flat())];
  const map = new Map<string, IssueDocumentRevisionInfo>();
  if (issueIds.length === 0 || keys.length === 0) return map;
  const rows = await executor
    .select({
      issueId: issueDocuments.issueId,
      key: issueDocuments.key,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
      // documents.updated_at is the instant of the latest revision write; it
      // stands in for revision.created_at when only a changes-requested
      // timestamp is available to compare against.
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      inArray(issueDocuments.issueId, issueIds),
      inArray(issueDocuments.key, keys),
    ));
  for (const row of rows) {
    if (!keysByIssue.get(row.issueId)?.includes(row.key)) continue;
    map.set(issueDocumentKey(row.issueId, row.key), row);
  }
  return map;
}

// AgentDash (review #1003): liveness for the resubmission gate counts only
// the assignee's runs — a queued reviewer or CoS run bound to the same issue
// cannot keep a sent-back deliverable out of review forever.
export async function listLiveAssigneeIssueRuns(
  executor: Pick<Db, "select">,
  issue: ReviewLoopIssue,
) {
  if (!issue.assigneeAgentId) return [];
  return executor
    .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      eq(heartbeatRuns.agentId, issue.assigneeAgentId),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
      or(
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}`,
        issue.executionRunId ? eq(heartbeatRuns.id, issue.executionRunId) : undefined,
        issue.checkoutRunId ? eq(heartbeatRuns.id, issue.checkoutRunId) : undefined,
      ),
    ));
}

/**
 * AgentDash (batch 2 review lane): the flip shared by the in_review PATCH
 * transition and the run-finish re-check. A sent-back deliverable returns to
 * ready_for_review when its document has a revision newer than the one the
 * changes request was made against, or when no assignee run is live anymore
 * ("or your run has finished"). callingRunIsLive is the PATCH case: an agent
 * resubmitting mid-run has not finished, so only an already-written revision
 * may flip. Returns the number of products flipped.
 */
export async function resubmitSentBackDeliverables(
  executor: ReviewLoopExecutor,
  issue: ReviewLoopIssue,
  opts: {
    actor: { actorType: "agent" | "user" | "system" | "plugin"; actorId: string; agentId: string | null; runId: string | null };
    audit: (input: LogActivityInput) => Promise<unknown>;
    /** Count the calling run as live when it belongs to the assignee (PATCH-time resubmission). */
    callingRunIsLive?: boolean;
    activityDetails?: Record<string, unknown>;
  },
): Promise<number> {
  const sentBack = await executor
    .select({ id: issueWorkProducts.id, metadata: issueWorkProducts.metadata })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, issue.companyId),
      eq(issueWorkProducts.issueId, issue.id),
      eq(issueWorkProducts.status, "changes_requested"),
    ));
  if (sentBack.length === 0) return 0;
  const docsByKey = await listIssueDocumentsByKey(
    executor,
    issue.companyId,
    new Map([[issue.id, sentBack.map((product) => workProductDocumentKey(product.metadata)).filter((key): key is string => !!key)]]),
  );
  const liveRunIds = new Set((await listLiveAssigneeIssueRuns(executor, issue)).map((run) => run.id));
  // A still-running assignee resubmitting itself counts as live even before
  // its row settles in the table.
  if (opts.callingRunIsLive && opts.actor.runId && opts.actor.agentId && opts.actor.agentId === issue.assigneeAgentId) {
    liveRunIds.add(opts.actor.runId);
  }
  const hasLiveAssigneeRun = liveRunIds.size > 0;
  const resubmittedAt = new Date().toISOString();
  let flipped = 0;
  for (const product of sentBack) {
    const documentKey = workProductDocumentKey(product.metadata);
    if (documentKey) {
      const doc = docsByKey.get(issueDocumentKey(issue.id, documentKey));
      const meta = product.metadata as Record<string, unknown> | null;
      const requestedRevision =
        typeof meta?.changesRequestedAtRevision === "number" ? meta.changesRequestedAtRevision : null;
      const requestedAtRaw = meta?.changesRequestedAt;
      const requestedAt =
        typeof requestedAtRaw === "string" && !Number.isNaN(Date.parse(requestedAtRaw))
          ? new Date(requestedAtRaw)
          : null;
      const hasNewerRevision = !!doc && (
        (requestedRevision !== null && doc.latestRevisionNumber > requestedRevision)
        || (requestedRevision === null && requestedAt !== null && doc.updatedAt.getTime() > requestedAt.getTime())
      );
      if (!hasNewerRevision && hasLiveAssigneeRun) continue;
    }
    await executor.update(issueWorkProducts)
      .set({
        status: "ready_for_review",
        reviewState: "needs_board_review",
        metadata: sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || jsonb_build_object('resubmittedAt', ${resubmittedAt}::text)`,
        updatedAt: new Date(),
      })
      .where(eq(issueWorkProducts.id, product.id));
    flipped += 1;
    await opts.audit({
      companyId: issue.companyId,
      actorType: opts.actor.actorType,
      actorId: opts.actor.actorId,
      agentId: opts.actor.agentId,
      runId: opts.actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        workProductId: product.id,
        changedKeys: ["reviewState", "status"],
        status: "ready_for_review",
        reviewState: "needs_board_review",
        reason: "resubmitted_for_review",
        ...(documentKey ? { documentKey } : {}),
        ...opts.activityDetails,
      },
    });
  }
  return flipped;
}

/**
 * AgentDash (review #1003): the "or your run has finished" half. When an
 * issue-bound run goes terminal, sent-back deliverables that were deferred at
 * resubmission (the run was still live, no newer revision yet) get their
 * second evaluation — with the finished run now out of the live set.
 */
export async function resubmitSentBackDeliverablesAfterRunFinished(
  db: Db,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "contextSnapshot">,
): Promise<number> {
  const context = (run.contextSnapshot ?? null) as Record<string, unknown> | null;
  const issueId = [context?.issueId, context?.taskId].find((value): value is string => typeof value === "string");
  if (!issueId) return 0;
  const publications: ActivityPublication[] = [];
  const flipped = await db.transaction(async (tx) => {
    const issue = await tx
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.status !== "in_review") return 0;
    return resubmitSentBackDeliverables(tx, issue, {
      actor: {
        actorType: run.agentId ? "agent" : "system",
        actorId: run.agentId ?? "system",
        agentId: run.agentId ?? null,
        runId: run.id,
      },
      audit: async (input) => { publications.push(await insertActivity(tx, input)); },
      callingRunIsLive: false,
      activityDetails: { finishedRunId: run.id },
    });
  });
  for (const publication of publications) publishActivity(publication);
  return flipped;
}

// AgentDash: UX-2 (#783) — company-wide Shipped feed.
export const SHIPPED_DEFAULT_LIMIT = 50;
export const SHIPPED_MAX_LIMIT = 200;

export interface ListShippedOptions {
  /** Restricted-project visibility for the caller (routes/visibility.ts), over issues.project_id. */
  visibleWhere?: SQL;
  projectId?: string;
  agentId?: string;
  issueId?: string;
  /** Only work products created at or after this instant (e.g. "this week" on Home). */
  since?: Date;
  /**
   * AgentDash (Scan 3 lane I): only accepted work, which is what Shipped and
   * Home count. See `acceptedWorkProductCondition`.
   */
  acceptedOnly?: boolean;
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  before?: string | null;
  now?: Date;
}

const UNMETERED: ShippedIssueUsage = {
  metered: false,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costCents: 0,
};

export function encodeShippedCursor(createdAt: Date, id: string) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeShippedCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso ?? "");
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * AgentDash (Scan 3 lane I): work products created before this instant were
 * recorded before a board user's acceptance was written onto them, so for
 * those alone "the issue is done" stands in for "accepted". Anything newer is
 * accepted only when a person approved it (or a pull request merged): an
 * agent closing its own issue does not ship its work.
 */
export const ACCEPTANCE_RECORDED_SINCE = new Date("2026-10-02T00:00:00.000Z");

/**
 * AgentDash (Scan 3 lane I): "shipped" means accepted. A work product is
 * accepted when a board user approved it (status approved, set when they move
 * the issue to done), when it merged, or, for work recorded before
 * ACCEPTANCE_RECORDED_SINCE, when its issue is done and it was not withdrawn
 * (closed, archived, failed, draft, changes requested). Derived on read, no
 * backfill.
 *
 * AgentDash (Scan 4 lane M): legacy work that went through Request changes
 * (metadata.changesRequestedAt) is under the new rule: only an explicit
 * acceptance ships it, even after it is resubmitted.
 */
export function acceptedWorkProductCondition(): SQL {
  return sql`(${issueWorkProducts.status} in ('approved', 'merged') or (${issues.status} = 'done' and ${issueWorkProducts.createdAt} < ${ACCEPTANCE_RECORDED_SINCE.toISOString()}::timestamptz and ${issueWorkProducts.status} not in ('closed', 'archived', 'failed', 'draft', 'changes_requested') and not (coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) ? 'changesRequestedAt')))`;
}

/** AgentDash (Scan 3 lane I): a title that is an absolute path or a file: URL shows as its file name. */
export function sanitizeWorkProductTitle(title: string): string {
  const trimmed = title.trim();
  const looksLikePath = /^file:/i.test(trimmed) || (/^(\/|~\/|[A-Za-z]:[\\/])/.test(trimmed) && !/\s/.test(trimmed));
  if (!looksLikePath) return title;
  const withoutQuery = trimmed.replace(/[?#].*$/, "");
  const base = withoutQuery.split(/[\\/]/).filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(base) || "Deliverable";
  } catch {
    return base || "Deliverable";
  }
}

export function startOfUtcMonth(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function workProductService(db: Db) {
  const runAgents = alias(agents, "shipped_run_agent");
  const assigneeAgents = alias(agents, "shipped_assignee_agent");
  // Millisecond precision so the cursor (a JS Date) compares exactly.
  const createdAtMs = sql`date_trunc('milliseconds', ${issueWorkProducts.createdAt})`;
  const producingAgentId = sql<string | null>`coalesce(${heartbeatRuns.agentId}, ${issues.assigneeAgentId})`;

  function shippedFilters(companyId: string, opts: ListShippedOptions): SQL[] {
    const filters: SQL[] = [
      eq(issueWorkProducts.companyId, companyId),
      eq(issues.companyId, companyId),
      // Hidden issues are gone everywhere else (issue list, assistant digest).
      isNull(issues.hiddenAt),
    ];
    if (opts.visibleWhere) filters.push(opts.visibleWhere);
    if (opts.projectId) filters.push(eq(issues.projectId, opts.projectId));
    if (opts.issueId) filters.push(eq(issueWorkProducts.issueId, opts.issueId));
    if (opts.agentId) filters.push(sql`${producingAgentId} = ${opts.agentId}`);
    if (opts.since) filters.push(gte(issueWorkProducts.createdAt, opts.since));
    if (opts.acceptedOnly) filters.push(acceptedWorkProductCondition());
    return filters;
  }

  async function usageByIssue(companyId: string, issueIds: string[]) {
    const map = new Map<string, ShippedIssueUsage>();
    if (issueIds.length === 0) return map;
    const rows = await db
      .select({
        issueId: costEvents.issueId,
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
        cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
        costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.issueId, issueIds)))
      .groupBy(costEvents.issueId);
    for (const row of rows) {
      if (!row.issueId) continue;
      map.set(row.issueId, {
        metered: true,
        inputTokens: Number(row.inputTokens),
        cachedInputTokens: Number(row.cachedInputTokens),
        outputTokens: Number(row.outputTokens),
        costCents: Number(row.costCents),
      });
    }
    return map;
  }

  function sumUsage(values: ShippedIssueUsage[]): ShippedIssueUsage {
    return values.reduce<ShippedIssueUsage>(
      (acc, u) =>
        u.metered
          ? {
              metered: true,
              inputTokens: acc.inputTokens + u.inputTokens,
              cachedInputTokens: acc.cachedInputTokens + u.cachedInputTokens,
              outputTokens: acc.outputTokens + u.outputTokens,
              costCents: acc.costCents + u.costCents,
            }
          : acc,
      { ...UNMETERED },
    );
  }

  return {
    /**
     * Work products across the company, newest first, each with the issue it
     * belongs to, the agent that made it (the producing run's agent, else the
     * issue's assignee), and the metered usage of every run on that issue.
     */
    listForCompany: async (companyId: string, opts: ListShippedOptions = {}): Promise<ShippedFeed> => {
      const limit = Math.min(Math.max(opts.limit ?? SHIPPED_DEFAULT_LIMIT, 1), SHIPPED_MAX_LIMIT);
      const filters = shippedFilters(companyId, opts);
      const pageFilters = [...filters];
      const cursor = opts.before ? decodeShippedCursor(opts.before) : null;
      if (cursor) {
        pageFilters.push(sql`(${createdAtMs}, ${issueWorkProducts.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`);
      }

      const rows = await db
        .select({
          product: issueWorkProducts,
          issueId: issues.id,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          issueProjectId: issues.projectId,
          runAgentId: runAgents.id,
          runAgentName: runAgents.name,
          assigneeAgentId: assigneeAgents.id,
          assigneeAgentName: assigneeAgents.name,
          // AgentDash (batch 3): stamped at run finalization; an `unmetered_*`
          // value lets the client close the "counting…" window at once. The
          // process-lost reaper and the setup-failure path never wrote a
          // usage row, so their status lives only in resultJson.runFacts —
          // read that too or a reaped run's product "counts…" for ten minutes.
          creatingRunMeteringStatus: sql<string | null>`coalesce(
            ${heartbeatRuns.usageJson} ->> 'meteringStatus',
            ${heartbeatRuns.resultJson} -> 'runFacts' ->> 'meteringStatus'
          )`,
        })
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
        .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, issueWorkProducts.createdByRunId))
        .leftJoin(runAgents, eq(runAgents.id, heartbeatRuns.agentId))
        .leftJoin(assigneeAgents, eq(assigneeAgents.id, issues.assigneeAgentId))
        .where(and(...pageFilters))
        .orderBy(desc(createdAtMs), desc(issueWorkProducts.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      // The count of everything the filters match (ignoring the cursor), so a
      // screen can say "12 shipped" beside a list that shows five.
      const total = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
        .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, issueWorkProducts.createdByRunId))
        .where(and(...filters))
        .then((r) => Number(r[0]?.count ?? 0));
      const usage = await usageByIssue(companyId, [...new Set(page.map((r) => r.issueId))]);
      // AgentDash (batch 3): a document deliverable's row must age from its
      // newest revision, not from when the work-product record was written —
      // a revision landing after review reads stale otherwise.
      const documentKeysByIssue = new Map<string, string[]>();
      for (const row of page) {
        if (row.product.type !== "document") continue;
        const key = workProductDocumentKey(row.product.metadata);
        if (!key) continue;
        const keys = documentKeysByIssue.get(row.issueId) ?? [];
        keys.push(key);
        documentKeysByIssue.set(row.issueId, keys);
      }
      const documentsByKey = await listIssueDocumentsByKey(db, companyId, documentKeysByIssue);
      const items: ShippedWorkProduct[] = page.map((row) => ({
        ...toIssueWorkProduct(row.product),
        issue: {
          id: row.issueId,
          identifier: row.issueIdentifier ?? null,
          title: row.issueTitle,
          status: row.issueStatus,
          projectId: row.issueProjectId ?? null,
        },
        agent: row.runAgentId
          ? { id: row.runAgentId, name: row.runAgentName ?? "" }
          : row.assigneeAgentId
            ? { id: row.assigneeAgentId, name: row.assigneeAgentName ?? "" }
            : null,
        usage: usage.get(row.issueId) ?? { ...UNMETERED },
        document: (() => {
          const key = row.product.type === "document" ? workProductDocumentKey(row.product.metadata) : null;
          const doc = key ? documentsByKey.get(issueDocumentKey(row.issueId, key)) : undefined;
          return doc
            ? { key: doc.key, latestRevisionNumber: doc.latestRevisionNumber, updatedAt: doc.updatedAt }
            : null;
        })(),
        creatingRunMeteringStatus: row.creatingRunMeteringStatus ?? null,
      }));
      const last = page[page.length - 1];
      const nextCursor = rows.length > limit && last ? encodeShippedCursor(last.product.createdAt, last.product.id) : null;

      const since = startOfUtcMonth(opts.now ?? new Date());
      const monthRows = await db
        .select({ issueId: issueWorkProducts.issueId, type: issueWorkProducts.type })
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
        .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, issueWorkProducts.createdByRunId))
        .where(and(...filters, gte(issueWorkProducts.createdAt, since)));
      const monthIssueIds = [...new Set(monthRows.map((r) => r.issueId))];
      const monthUsage = await usageByIssue(companyId, monthIssueIds);

      return {
        items,
        total,
        nextCursor,
        monthTotal: {
          since: since.toISOString(),
          count: monthRows.length,
          pullRequests: monthRows.filter((r) => r.type === "pull_request").length,
          usage: sumUsage([...monthUsage.values()]),
        },
      };
    },

    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      const row = await db.transaction(async (tx) => {
        if (data.isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        return await tx
          .update(issueWorkProducts)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      const row = await db
        .delete(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },
  };
}

export { toIssueWorkProduct };
