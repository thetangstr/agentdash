import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agents, costEvents, heartbeatRuns, issueWorkProducts, issues } from "@paperclipai/db";
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
    const filters: SQL[] = [eq(issueWorkProducts.companyId, companyId), eq(issues.companyId, companyId)];
    if (opts.visibleWhere) filters.push(opts.visibleWhere);
    if (opts.projectId) filters.push(eq(issues.projectId, opts.projectId));
    if (opts.issueId) filters.push(eq(issueWorkProducts.issueId, opts.issueId));
    if (opts.agentId) filters.push(sql`${producingAgentId} = ${opts.agentId}`);
    if (opts.since) filters.push(gte(issueWorkProducts.createdAt, opts.since));
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
