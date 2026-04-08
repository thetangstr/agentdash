import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agents, approvals } from "@agentdash/db";
import type { InboxListQuery } from "@agentdash/shared";
import { approvalService } from "./approvals.js";
import { notFound } from "../errors.js";

export interface InboxItem {
  id: string;
  type: string;
  status: string;
  agentId: string | null;
  agentName: string | null;
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
}

function extractTitle(row: typeof approvals.$inferSelect): string {
  const payload = row.payload as Record<string, unknown>;
  return (
    (payload?.title as string) ??
    (payload?.proposedAction as string) ??
    `${row.type} approval`
  );
}

function extractDescription(row: typeof approvals.$inferSelect): string | null {
  const payload = row.payload as Record<string, unknown>;
  return (payload?.description as string) ?? (payload?.reason as string) ?? null;
}

export function inboxService(db: Db) {
  const approveSvc = approvalService(db);

  return {
    async listPending(companyId: string, filters?: Partial<InboxListQuery>) {
      return this.listRecent(companyId, { ...filters, status: "pending" });
    },

    async listRecent(companyId: string, filters?: Partial<InboxListQuery>) {
      const conditions = [eq(approvals.companyId, companyId)];

      if (filters?.status && filters.status !== "all") {
        conditions.push(eq(approvals.status, filters.status));
      }
      if (filters?.agentId) {
        conditions.push(eq(approvals.requestedByAgentId, filters.agentId));
      }

      const rows = await db
        .select({
          approval: approvals,
          agentName: agents.name,
        })
        .from(approvals)
        .leftJoin(agents, eq(approvals.requestedByAgentId, agents.id))
        .where(and(...conditions))
        .orderBy(desc(approvals.createdAt))
        .limit(filters?.limit ?? 50)
        .offset(filters?.offset ?? 0);

      const items: InboxItem[] = rows.map((r) => ({
        id: r.approval.id,
        type: r.approval.type,
        status: r.approval.status,
        agentId: r.approval.requestedByAgentId,
        agentName: r.agentName,
        title: extractTitle(r.approval),
        description: extractDescription(r.approval),
        payload: r.approval.payload,
        createdAt: r.approval.createdAt,
        decidedAt: r.approval.decidedAt,
        decisionNote: r.approval.decisionNote,
      }));

      return items;
    },

    async pendingCount(companyId: string) {
      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.status, "pending"),
          ),
        );
      return result?.count ?? 0;
    },

    async approve(companyId: string, approvalId: string, decidedByUserId: string, decisionNote?: string | null) {
      const row = await approveSvc.getById(approvalId);
      if (!row || row.companyId !== companyId) throw notFound("Approval not found");
      return approveSvc.approve(approvalId, decidedByUserId, decisionNote);
    },

    async reject(companyId: string, approvalId: string, decidedByUserId: string, reason?: string | null) {
      const row = await approveSvc.getById(approvalId);
      if (!row || row.companyId !== companyId) throw notFound("Approval not found");
      return approveSvc.reject(approvalId, decidedByUserId, reason);
    },

    async getDetail(companyId: string, approvalId: string) {
      const row = await approveSvc.getById(approvalId);
      if (!row || row.companyId !== companyId) return null;

      let agentName: string | null = null;
      if (row.requestedByAgentId) {
        const [agent] = await db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, row.requestedByAgentId))
          .limit(1);
        agentName = agent?.name ?? null;
      }

      return {
        id: row.id,
        type: row.type,
        status: row.status,
        agentId: row.requestedByAgentId,
        agentName,
        title: extractTitle(row),
        description: extractDescription(row),
        payload: row.payload,
        createdAt: row.createdAt,
        decidedAt: row.decidedAt,
        decisionNote: row.decisionNote,
      } satisfies InboxItem;
    },
  };
}
